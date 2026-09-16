//! red-pty: retained PTY sessions in Rust (F176, F151a, spec 129, KI-096).
//!
//! The core behaviors the JS session host pins, mirrored exactly:
//! - output decoding holds an incomplete UTF-8 tail the way node's string_decoder does, so a
//!   multibyte character split across reads emerges whole with no stray U+FFFD;
//! - the scrollback is kept as UTF-16 code units and truncated at OUTPUT_LIMIT the way
//!   `.slice(-1048576)` truncates a JS string — including the lone-surrogate edge when the
//!   slice boundary splits an astral pair (spec 060's "JavaScript string characters");
//! - input is capped at the same 1 MiB, counted in UTF-16 units;
//! - stop is SIGTERM to the process tree, a 2 s grace, then SIGKILL — the same `ps` table the
//!   JS side reads, never pgrep.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize, PtySystem};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

pub const OUTPUT_LIMIT: usize = 1024 * 1024;
pub const INPUT_LIMIT: usize = 1024 * 1024;
/// What one pane's record may weigh (charter D62): titles, a conversation id, a handoff gate.
pub const RECORD_LIMIT: usize = 64 * 1024;

#[derive(Debug)]
pub struct Fail {
    pub message: String,
    pub status: Option<u16>,
}

impl Fail {
    pub fn new(message: impl Into<String>, status: u16) -> Self {
        Fail { message: message.into(), status: Some(status) }
    }
    pub fn raw(message: impl Into<String>) -> Self {
        Fail { message: message.into(), status: None }
    }
}

type Result<T> = std::result::Result<T, Fail>;

/// node string_decoder semantics: an incomplete multibyte tail is held for the next chunk; an
/// invalid byte becomes one U+FFFD. Returns the decoded string and keeps the held tail.
pub fn decode_chunk(tail: &mut Vec<u8>, bytes: &[u8]) -> String {
    tail.extend_from_slice(bytes);
    let mut out = String::new();
    let mut offset = 0;
    loop {
        match std::str::from_utf8(&tail[offset..]) {
            Ok(valid) => {
                out.push_str(valid);
                tail.clear();
                break;
            }
            Err(error) => {
                let up_to = error.valid_up_to();
                out.push_str(unsafe { std::str::from_utf8_unchecked(&tail[offset..offset + up_to]) });
                match error.error_len() {
                    Some(length) => {
                        out.push('\u{fffd}');
                        offset += up_to + length;
                    }
                    None => {
                        tail.drain(..offset + up_to);
                        break;
                    }
                }
            }
        }
    }
    out
}

pub struct PtySession {
    /* What the host knows about this pane and the service does not: which project it belongs to,
       which agent, which conversation, the title a person reads. The service never reads it — it
       is carried so the NEXT host can name what it adopts, which is the difference between a
       retained session and an orphaned process (F179, charter D60). */
    pub meta: Value,
    pub id: String,
    pub pid: u32,
    pub state: &'static str,
    pub exit_code: Option<i64>,
    pub signal: Option<i64>,
    /* When the child ended, by this service's clock. The host used to stamp this itself when the
       exit event arrived, which was fine while one host watched a pane; two hosts stamping their
       own arrival times would report two different endings for one death (charter D62). */
    pub ended_at: Option<u64>,
    pub cols: u16,
    pub rows: u16,
    pub sequence: u64,
    /* When this pane last said anything, and when it was last typed into. A spawn needs neither —
       its pane has said nothing yet by definition — but a MESSAGE to a pane that is already running
       needs both: the first is what "settled" means for a pane nobody is about to hear from again,
       and the second is what "somebody is using this one" means (F222, spec 148). */
    last_output_at: Option<u64>,
    last_input_at: Option<u64>,
    output: Vec<u16>,
    tail: Vec<u8>,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    /// The seed handshake in flight, when this pane was started with one (F221, spec 146).
    seed: Option<SeedWatch>,
}

impl PtySession {
    pub fn push_output(&mut self, decoded: &str) {
        self.output.extend(decoded.encode_utf16());
        if self.output.len() > OUTPUT_LIMIT {
            let drop = self.output.len() - OUTPUT_LIMIT;
            self.output.drain(..drop);
        }
        self.sequence += 1;
    }

    /// The scrollback as base64 of UTF-16LE units: the JS client decodes it to a JS string,
    /// which holds even a lone surrogate at the slice boundary exactly as the JS host does.
    pub fn output_base64(&self) -> String {
        let mut bytes = Vec::with_capacity(self.output.len() * 2);
        for unit in &self.output {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        base64_encode(&bytes)
    }

    /// What an event carries: the same pane, without the megabyte of history. Nothing that reads
    /// these lines reads the scrollback — a host keeps its own, a door asks for it when somebody
    /// wants it — and a snapshot per resize with the history in it would be a service shouting its
    /// whole memory every time a person drags a pane edge.
    pub fn event_snapshot(&self) -> Value {
        let mut snapshot = self.core_snapshot();
        if let Some(fields) = snapshot.as_object_mut() {
            fields.remove("output");
        }
        snapshot
    }

    pub fn core_snapshot(&self) -> Value {
        json!({
            "id": self.id,
            "pid": self.pid,
            "state": self.state,
            "exitCode": self.exit_code,
            "signal": self.signal,
            "endedAt": self.ended_at,
            "cols": self.cols,
            "rows": self.rows,
            "sequence": self.sequence,
            "output": self.output_base64(),
            "meta": self.meta,
        })
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let a = chunk[0] as u32;
        let b = *chunk.get(1).unwrap_or(&0) as u32;
        let c = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (a << 16) | (b << 8) | c;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

/* ---- seeding a pane that cannot be handed its first message on the command line ---------------
   F221, spec 146. Some interactive CLIs take no initial prompt in argv — one of them reads a bare
   word as a SUBCOMMAND and exits on it — so the only way in is the way a person's would be: typed.
   This service holds the master side of the pane, which makes it the only place that can type. */

/// What a caller asks to be typed into a pane once it is listening, and what proves it arrived.
#[derive(Clone, Debug, PartialEq)]
pub struct Seed {
    /// One line, because a CLI that collapses a long paste into a summary echoes nothing to match.
    pub paste: String,
    /// A token the line carries; the Enter that submits it is sent only once this comes back.
    pub confirm: String,
}

/// The pane has drawn something and stopped: the moment a person would start typing.
const SETTLE_MS: u64 = 800;
/// And the moment to stop waiting for quiet. A CLI that redraws a clock or a spinner never falls
/// silent, and waiting for a silence that is not coming would seed nothing at all; a person watching
/// one of those starts typing anyway. Safe because the Enter is still earned by the echo — a paste
/// sent too early costs a redraw and is retried.
const TALKING_MS: u64 = 10_000;
/// How long an echo may take before the attempt is abandoned.
const CONFIRM_MS: u64 = 4_000;
/// Attempts before the seed is given up on. More than one because the first pane in a project can
/// open on the CLI's own trust prompt, which ignores a paste and waits for a person.
const ATTEMPTS: u8 = 3;
/// The whole handshake's bound, from the spawn.
const SEED_DEADLINE_MS: u64 = 90_000;
/// What the watcher keeps of the output since its last paste, in normalised characters.
const SEEN_LIMIT: usize = 64 * 1024;

/* ---- and the same handshake said to a pane that is ALREADY running (F222, spec 148) -----------
   A relay is the strictly more conservative case, for a reason a spawn does not have: the pane it
   types into holds somebody's conversation. It gets ONE attempt, because the retries exist to reach
   a settled composer THROUGH a trust dialog and a relay refuses unless the pane is already settled;
   and a ceiling in seconds rather than a minute and a half, because KI-068's second half was an
   Enter that arrived an hour after the line it submitted. */
/// One attempt. There is no dialog to wait out: an unsettled pane is refused before this starts.
const MESSAGE_ATTEMPTS: u8 = 1;
/// The whole relay's bound. A paste at the first tick and 4 s for its echo fit inside it twice.
const MESSAGE_DEADLINE_MS: u64 = 15_000;
/// A pane that has been typed into more recently than this is somebody's, and is not relayed into:
/// a person's half-written line is exactly the composer a relay must not append to and submit.
pub const MESSAGE_INPUT_QUIET_MS: u64 = 60_000;
/// And the quiet a relay needs before it starts, which is the spawn handshake's own settle.
pub const MESSAGE_SETTLE_MS: u64 = SETTLE_MS;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SeedStep {
    /// Nothing to do yet.
    Wait,
    /// Type the line.
    Paste,
    /// The echo came back: press Enter, and the pane holds the brief.
    Submit,
    /// No echo, no Enter — ever. A brief that did not arrive must not look like one that did.
    GiveUp,
}

/// The handshake's whole decision, separated from the writing so it can be judged without a
/// terminal: what has been seen and when, against what was asked for.
#[derive(Debug)]
pub struct SeedWatch {
    seed: Seed,
    started: u64,
    last_output: Option<u64>,
    /// When this attempt started waiting, so a CLI that never stops talking is still typed into.
    since: Option<u64>,
    pasted_at: Option<u64>,
    attempts: u8,
    seen: String,
    settled: bool,
    /* The two numbers that differ between a spawn's seed and a relay. They are fields rather than
       constants so there is ONE decision with two policies, instead of a second copy of the
       decision with different numbers in it. */
    allowed: u8,
    deadline_ms: u64,
}

/// Everything a composer's box drawing, wrapping and colour can do to a line, undone: what is left
/// is the characters, so a token split across a wrap is still a token.
fn normalised(text: &str) -> String {
    text.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_lowercase()).collect()
}

impl SeedWatch {
    pub fn new(seed: Seed, now: u64) -> Self {
        SeedWatch {
            seed, started: now, last_output: None, since: None, pasted_at: None, attempts: 0,
            seen: String::new(), settled: false, allowed: ATTEMPTS, deadline_ms: SEED_DEADLINE_MS,
        }
    }

    /// The same decision, said to a pane that is already up: the caller supplies when the pane last
    /// spoke, which a spawn has no answer for and a relay does (spec 146 decision 9 — the decision
    /// is pure and the environment-dependent parts are the caller's).
    ///
    /// It matters. A pane that has been quiet for an hour has nothing left to say, and a watcher
    /// that waited for a first byte before typing would wait for one that is never coming and
    /// give up having done nothing.
    pub fn listening(seed: Seed, now: u64, last_output: u64) -> Self {
        SeedWatch {
            seed, started: now, last_output: Some(last_output), since: Some(last_output), pasted_at: None,
            attempts: 0, seen: String::new(), settled: false, allowed: MESSAGE_ATTEMPTS, deadline_ms: MESSAGE_DEADLINE_MS,
        }
    }

    /// Whether this handshake has answered for the last time. A pane whose seed has settled may be
    /// relayed to; one whose handshake is still in flight may not, because two watchers writing to
    /// one master is two lines in one composer and one Enter neither of them earned.
    pub fn settled(&self) -> bool {
        self.settled
    }

    /// The pane said something. Before a paste this only marks the clock; after one it is the echo
    /// this is waiting for.
    pub fn saw_output(&mut self, decoded: &str, now: u64) {
        self.last_output = Some(now);
        self.since.get_or_insert(now);
        if self.pasted_at.is_some() {
            self.seen.push_str(&normalised(decoded));
            if self.seen.len() > SEEN_LIMIT {
                let drop = self.seen.len() - SEEN_LIMIT;
                self.seen.drain(..drop);
            }
        }
    }

    /// What to do now. Every terminal answer is returned once: the caller acts on it and stops.
    pub fn step(&mut self, now: u64) -> SeedStep {
        if self.settled {
            return SeedStep::Wait;
        }
        match self.pasted_at {
            None => {
                let Some(last) = self.last_output else {
                    /* Not one byte yet. A CLI that never speaks is never typed at. */
                    return self.expire(now);
                };
                let waited = now.saturating_sub(self.since.unwrap_or(now));
                if now.saturating_sub(last) >= SETTLE_MS || waited >= TALKING_MS {
                    self.pasted_at = Some(now);
                    self.attempts += 1;
                    self.seen.clear();
                    return SeedStep::Paste;
                }
                self.expire(now)
            }
            Some(pasted) => {
                if self.seen.contains(&normalised(&self.seed.confirm)) {
                    self.settled = true;
                    return SeedStep::Submit;
                }
                if now.saturating_sub(pasted) < CONFIRM_MS {
                    return self.expire(now);
                }
                /* No echo. Whatever is up there is not a composer — a paste it ignored cost it a
                   redraw and nothing else — so wait for the next settle and try again. */
                if self.attempts >= self.allowed {
                    self.settled = true;
                    return SeedStep::GiveUp;
                }
                self.pasted_at = None;
                self.last_output = Some(now);
                self.since = Some(now);
                self.expire(now)
            }
        }
    }

    fn expire(&mut self, now: u64) -> SeedStep {
        if now.saturating_sub(self.started) >= self.deadline_ms {
            self.settled = true;
            return SeedStep::GiveUp;
        }
        SeedStep::Wait
    }

    /// The bytes a `Paste` writes: bracketed, so the receiving CLI reads the whole line as one
    /// pasted event rather than as keystrokes — which is what keeps a newline out of a dialog.
    pub fn paste_bytes(&self) -> Vec<u8> {
        let mut bytes = b"\x1b[200~".to_vec();
        bytes.extend_from_slice(self.seed.paste.as_bytes());
        bytes.extend_from_slice(b"\x1b[201~");
        bytes
    }
}

/// The handshake, run beside the output pump: a slow poll, because the decision depends on the pane
/// going QUIET and silence is not an event.
///
/// It writes twice at most — the paste, then the Enter the echo earns — and records which happened
/// under `record` on the pane's own record, so a line that never arrived cannot read like one that
/// did. One function for both callers (F221's spawn seed, F222's message) because it is one
/// handshake; only the record key and the word for a failure differ.
fn watch_handshake<F: FnMut(Value) + Send + 'static>(
    session: Arc<Mutex<PtySession>>,
    emit: Arc<Mutex<F>>,
    record: &'static str,
    unconfirmed: &'static str,
) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(150));
        let outcome = {
            let mut held = session.lock().expect("session lock");
            if held.state != "running" {
                break;
            }
            let now = now_ms();
            let Some(watch) = held.seed.as_mut() else { break };
            match watch.step(now) {
                SeedStep::Wait => continue,
                SeedStep::Paste => {
                    let bytes = watch.paste_bytes();
                    let _ = held.writer.write_all(&bytes);
                    let _ = held.writer.flush();
                    continue;
                }
                SeedStep::Submit => {
                    let _ = held.writer.write_all(b"\r");
                    let _ = held.writer.flush();
                    "delivered"
                }
                SeedStep::GiveUp => unconfirmed,
            }
        };
        let snapshot = {
            let mut held = session.lock().expect("session lock");
            if !held.meta.is_object() {
                held.meta = json!({});
            }
            held.meta.as_object_mut().expect("a record").insert(record.to_string(), json!(outcome));
            held.event_snapshot()
        };
        (emit.lock().expect("emit lock"))(json!({ "type": "session", "session": snapshot }));
        break;
    });
}

pub struct PtyHost<F: FnMut(Value) + Send> {
    sessions: HashMap<String, Arc<Mutex<PtySession>>>,
    emit: Arc<Mutex<F>>,
    pty_system: Box<dyn PtySystem + Send>,
}

impl<F: FnMut(Value) + Send + 'static> PtyHost<F> {
    pub fn new(emit: F) -> Self {
        PtyHost { sessions: HashMap::new(), emit: Arc::new(Mutex::new(emit)), pty_system: native_pty_system() }
    }

    pub fn spawn(&mut self, id: String, file: &str, argv: &[String], env: &HashMap<String, String>, cwd: &str, cols: u16, rows: u16, meta: Value, seed: Option<Seed>) -> Result<Value> {
        let pair = self
            .pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|error| Fail::raw(error.to_string()))?;
        let mut command = CommandBuilder::new(file);
        command.args(argv);
        command.cwd(cwd);
        /* The caller's environment is the WHOLE environment, which is what node-pty's `env` option
           means and therefore what every pane this replaces was launched with. portable-pty's
           builder starts from this process's own environment instead, so a service that inherited
           a stale RENGINE_AGENT_CONVERSATIONS from the host would hand it to every pane — the
           exact leak the host's cleared-set discipline exists to prevent (KI-068). */
        command.env_clear();
        command.env("TERM", "xterm-256color");
        for (key, value) in env {
            command.env(key, value);
        }
        let mut child = pair.slave.spawn_command(command).map_err(|error| Fail::raw(error.to_string()))?;
        let pid = child.process_id().unwrap_or(0);
        let writer = pair.master.take_writer().map_err(|error| Fail::raw(error.to_string()))?;
        let reader = pair.master.try_clone_reader().map_err(|error| Fail::raw(error.to_string()))?;
        let session = Arc::new(Mutex::new(PtySession {
            meta,
            id: id.clone(),
            pid,
            state: "running",
            exit_code: None,
            signal: None,
            ended_at: None,
            cols,
            rows,
            sequence: 0,
            last_output_at: None,
            last_input_at: None,
            output: Vec::new(),
            tail: Vec::new(),
            writer,
            master: pair.master,
            seed: seed.map(|seed| SeedWatch::new(seed, now_ms())),
        }));
        self.sessions.insert(id.clone(), session.clone());
        // The output pump: read, decode, append, emit one event per chunk (the JS host emits
        // node-pty's chunks the same way; boundaries are implementation-defined by nature).
        let pump = session.clone();
        let pump_emit = self.emit.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buffer = [0u8; 65536];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let (decoded, sequence) = {
                            let mut session = pump.lock().expect("session lock");
                            let decoded = decode_chunk(&mut session.tail, &buffer[..read]);
                            session.push_output(&decoded);
                            /* The seed handshake's eyes: before a paste this is the settle clock,
                               after one it is the echo that decides whether Enter is ever sent. */
                            let at = now_ms();
                            session.last_output_at = Some(at);
                            if let Some(watch) = session.seed.as_mut() {
                                watch.saw_output(&decoded, at);
                            }
                            (decoded, session.sequence)
                        };
                        (pump_emit.lock().expect("emit lock"))(json!({ "type": "output", "id": pump.lock().expect("session lock").id, "sequence": sequence, "data": decoded }));
                    }
                    Err(_) => break,
                }
            }
        });
        // The exit watcher: the child handle lives here (it alone waits), so waiting never
        // holds the session lock the other operations take.
        let watcher = session.clone();
        let watch_emit = self.emit.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            // portable-pty 0.8 exposes exit_code() but not the signal (its field is private):
            // normal exits report exactly, and signal reporting is F178's recorded decision
            // (name-table, Debug parse, or waitpid interposition).
            let (code, signal): (Option<i64>, Option<i64>) = match status {
                Ok(status) => (Some(status.exit_code() as i64), None),
                Err(_) => (None, None),
            };
            let snapshot = {
                let mut session = watcher.lock().expect("session lock");
                session.state = "exited";
                session.exit_code = code;
                session.signal = signal.map(|value| value as i64);
                session.ended_at = Some(now_ms());
                session.event_snapshot()
            };
            (watch_emit.lock().expect("emit lock"))(json!({ "type": "session", "session": snapshot }));
        });
        /* The seed handshake, when this launch asked for one: a slow poll beside the pump, because
           the decision depends on the pane going QUIET and silence is not an event. It writes twice
           at most — the paste, then the Enter the echo earns — and records which happened on the
           pane's own record, so a brief that never arrived cannot read like one that did. */
        if session.lock().expect("session lock").seed.is_some() {
            watch_handshake(session.clone(), self.emit.clone(), "seed", "unconfirmed");
        }
        let announced = session.lock().expect("session lock").event_snapshot();
        let snapshot = session.lock().expect("session lock").core_snapshot();
        /* Announced, not just answered. The caller gets this snapshot as its result, but every
           OTHER host attached to this directory has to learn the pane exists somehow, and waiting
           for its first record change or its exit would leave a live pane that a second host
           answers `Unknown session.` about (charter D62). */
        (self.emit.lock().expect("emit lock"))(json!({ "type": "session", "session": announced }));
        Ok(snapshot)
    }

    fn get(&self, id: &str) -> Result<Arc<Mutex<PtySession>>> {
        self.sessions.get(id).cloned().ok_or_else(|| Fail::new("Unknown session.", 404))
    }

    pub fn input(&mut self, id: &str, data: &str) -> Result<()> {
        if data.encode_utf16().count() > INPUT_LIMIT {
            return Err(Fail::new("Invalid terminal input.", 400));
        }
        let session = self.get(id)?;
        let mut session = session.lock().expect("session lock");
        if session.state != "running" {
            return Err(Fail::new("Session is not running.", 409));
        }
        /* When somebody last typed here, whoever they were. A relay reads it to refuse a pane a
           person is using, and this is the one place every keystroke passes through (F222). */
        session.last_input_at = Some(now_ms());
        session.writer.write_all(data.as_bytes()).map_err(|error| Fail::raw(error.to_string()))
    }

    /// Say one line to a pane that is already running (F222, spec 148).
    ///
    /// The same handshake a spawn's seed gets, attached to a pane nobody is spawning. What is here
    /// rather than in the watcher are the four refusals that only make sense for a pane already in
    /// use, and they ATTACH NOTHING when they fire: a caller that is refused can be certain the
    /// pane was not typed into.
    ///
    /// It returns as soon as the watcher is attached, deliberately. This service takes one lock
    /// around its whole dispatch, so a verb that waited five seconds for an echo would freeze every
    /// other pane in the workspace while it did; the outcome arrives on the pane's own record and
    /// its session event, exactly as a seed's does.
    pub fn message(&mut self, id: &str, seed: Seed, now: u64) -> Result<Value> {
        let session = self.get(id)?;
        {
            let mut held = session.lock().expect("session lock");
            if held.state != "running" {
                return Err(Fail::new("Session is not running.", 409));
            }
            if held.seed.as_ref().is_some_and(|watch| !watch.settled()) {
                return Err(Fail::new("This pane is already being typed into, and that handshake has not finished.", 409));
            }
            let Some(spoke) = held.last_output_at else {
                return Err(Fail::new("This pane has not said anything yet, so there is no composer to type into.", 409));
            };
            if now.saturating_sub(spoke) < MESSAGE_SETTLE_MS {
                return Err(Fail::new("This pane is talking. A message goes to a settled composer, never into a turn in progress.", 409));
            }
            if held.last_input_at.is_some_and(|typed| now.saturating_sub(typed) < MESSAGE_INPUT_QUIET_MS) {
                return Err(Fail::new("This pane was typed into moments ago, so somebody is using it, and a message appends to whatever the composer already holds.", 409));
            }
            held.seed = Some(SeedWatch::listening(seed, now, spoke));
        }
        watch_handshake(session.clone(), self.emit.clone(), "message", "undelivered");
        Ok(json!({ "accepted": true }))
    }

    pub fn resize(&mut self, id: &str, cols: u16, rows: u16) -> Result<()> {
        if cols < 2 || cols > 500 || rows < 1 || rows > 300 {
            return Err(Fail::new("Invalid terminal dimensions.", 400));
        }
        let session = self.get(id)?;
        let mut session = session.lock().expect("session lock");
        if session.state != "running" {
            return Ok(());
        }
        session
            .master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|error| Fail::raw(error.to_string()))?;
        session.cols = cols;
        session.rows = rows;
        let snapshot = session.event_snapshot();
        drop(session);
        /* Announced for the same reason a spawn is: the dimensions are this service's, and a host
           that resized through another host would otherwise keep describing a pane the wrong size
           to the person looking at it (charter D62). */
        (self.emit.lock().expect("emit lock"))(json!({ "type": "session", "session": snapshot }));
        Ok(())
    }

    /// The pane's record, changed by whichever host knows something new about it (charter D62).
    ///
    /// `meta` was written once at spawn, so the NEXT host could name what it adopts. That is no
    /// longer enough: two hosts read one directory now, and a record only one of them can change is
    /// a record the other answers from wrongly — a door refusing input for a pane whose gate the
    /// host serving the socket has already released. So the record lives here, one owner, and a
    /// change is broadcast the way an exit is.
    ///
    /// A `null` removes its key rather than storing a null, because a pane that cannot forget a
    /// conversation would offer to resume the wrong one.
    pub fn describe(&mut self, id: &str, patch: &Value) -> Result<Value> {
        let Some(fields) = patch.as_object() else {
            return Err(Fail::new("Invalid pane record.", 400));
        };
        let session = self.get(id)?;
        let snapshot = {
            let mut session = session.lock().expect("session lock");
            if !session.meta.is_object() {
                session.meta = json!({});
            }
            let record = session.meta.as_object_mut().expect("a record");
            for (name, value) in fields {
                if value.is_null() {
                    record.remove(name);
                } else {
                    record.insert(name.clone(), value.clone());
                }
            }
            /* A bound on what a host may store about a pane: this service holds records for panes
               that outlive their hosts, and an unbounded one is a leak with a long life. */
            if serde_json::to_string(&session.meta).map(|text| text.len()).unwrap_or(usize::MAX) > RECORD_LIMIT {
                return Err(Fail::new("Pane record exceeds the 64 KiB limit.", 400));
            }
            session.event_snapshot()
        };
        (self.emit.lock().expect("emit lock"))(json!({ "type": "session", "session": snapshot }));
        self.snapshot(id)
    }

    pub fn snapshot(&self, id: &str) -> Result<Value> {
        Ok(self.get(id)?.lock().expect("session lock").core_snapshot())
    }

    pub fn list(&self) -> Vec<Value> {
        self.sessions.values().map(|session| session.lock().expect("session lock").core_snapshot()).collect()
    }

    /// stop: SIGTERM to the tree, a 2 s grace, then SIGKILL — the same ps table the JS side
    /// reads (never pgrep). Blocks the way the JS stop does.
    pub fn stop(&mut self, id: &str) -> Result<Value> {
        let session = self.get(id)?;
        let pid = session.lock().expect("session lock").pid;
        {
            let mut guard = session.lock().expect("session lock");
            if guard.state == "exited" {
                return Ok(guard.core_snapshot());
            }
            guard.state = "stopping";
        }
        signal_tree(pid, "TERM")?;
        wait_for_exit(&session, 2000);
        if session.lock().expect("session lock").state != "exited" {
            signal_tree(pid, "KILL")?;
            /* And wait for the ending this call just caused. A `stop` that answered "stopping"
               would hand its caller a death it has already arranged and leave it polling for the
               news — and two hosts would poll for it separately (charter D62). */
            wait_for_exit(&session, 2000);
        }
        let snapshot = session.lock().expect("session lock").core_snapshot();
        Ok(snapshot)
    }
}

/// The process table walk the JS signalTree does: descendants first, then the pid, with the
/// signal to each; a process that vanished between the two reads is not an error (ESRCH).
fn signal_tree(pid: u32, signal: &str) -> Result<()> {
    if cfg!(windows) {
        let status = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .map_err(|error| Fail::raw(error.to_string()))?;
        if !status.success() {
            return Err(Fail::raw(format!("taskkill failed for {pid}")));
        }
        return Ok(());
    }
    let output = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid="])
        .output()
        .map_err(|error| Fail::raw(error.to_string()))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut children_of: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in text.lines() {
        let parts: Vec<u32> = line.split_whitespace().filter_map(|part| part.parse().ok()).collect();
        if let [child, parent] = parts[..] {
            children_of.entry(parent).or_default().push(child);
        }
    }
    let mut descendants = Vec::new();
    let visit = |parent: u32, descendants: &mut Vec<u32>| {
        let mut stack = vec![parent];
        while let Some(next) = stack.pop() {
            for child in children_of.get(&next).cloned().unwrap_or_default() {
                if child != parent {
                    descendants.push(child);
                    stack.push(child);
                }
            }
        }
    };
    visit(pid, &mut descendants);
    for target in descendants.iter().chain(std::iter::once(&pid)) {
        let status = std::process::Command::new("kill")
            .args(["-s", signal, &target.to_string()])
            /* Its complaint is read below when it fails; letting it also reach this process's own
               stderr puts "No such process" in the middle of a test report for a child that was
               already gone, which is exactly the case this code then decides to ignore. */
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|error| Fail::raw(error.to_string()))?;
        if !status.success() {
            let message = String::from_utf8_lossy(
                &std::process::Command::new("kill").args(["-s", signal, &target.to_string()]).output().map_err(|error| Fail::raw(error.to_string()))?.stderr,
            )
            .into_owned();
            if !message.contains("No such process") {
                return Err(Fail::raw(format!("kill -s {signal} {target}: {message}")));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watching() -> SeedWatch {
        SeedWatch::new(Seed { paste: "Your brief is the file /s/ec36a646.brief.md. Read it.".into(), confirm: "ec36a646".into() }, 0)
    }

    /* F221, spec 146. The handshake in the order it happens: the pane speaks, falls quiet, is typed
       into, echoes what it was given, and only then is Enter pressed. */
    #[test]
    fn a_seed_is_typed_once_the_pane_is_quiet_and_submitted_once_it_comes_back() {
        let mut watch = watching();
        watch.saw_output("welcome", 100);
        assert_eq!(watch.step(400), SeedStep::Wait, "still talking");
        watch.saw_output("drawing", 500);
        assert_eq!(watch.step(900), SeedStep::Wait, "quiet, but not for long enough yet");
        assert_eq!(watch.step(1_400), SeedStep::Paste);
        assert_eq!(watch.step(1_500), SeedStep::Wait, "nothing came back yet, so nothing is pressed");
        /* What a composer does to a line it wrapped inside a box: the token arrives in two pieces,
           separated by the frame. Normalisation is what makes it one token again. */
        watch.saw_output(" \u{2502} Your brief is the file /s/ec36a6 \u{2502}\n \u{2502} 46.brief.md. Read it.    \u{2502}", 1_600);
        assert_eq!(watch.step(1_700), SeedStep::Submit);
        assert_eq!(watch.step(1_800), SeedStep::Wait, "a settled handshake answers once");
    }

    /* The hazard this shape exists for: a CLI showing a modal that ignores a paste. Measured at six
       bytes of redraw and nothing else (spec 146), so retrying is safe — and Enter is never pressed,
       because an Enter into a modal answers a question a person was being asked. */
    #[test]
    fn a_paste_nothing_echoes_is_retried_and_then_given_up_on_without_an_enter() {
        let mut watch = watching();
        let mut pastes = 0;
        let mut verdict = SeedStep::Wait;
        for tick in 1..=1_200 {
            let now = tick * 100;
            watch.saw_output("", now.min(200));
            match watch.step(now) {
                SeedStep::Paste => pastes += 1,
                SeedStep::Submit => panic!("an unechoed paste must never be submitted"),
                SeedStep::GiveUp => { verdict = SeedStep::GiveUp; break }
                SeedStep::Wait => {}
            }
        }
        assert_eq!(pastes, 3, "three attempts, for the person answering a trust prompt in between");
        assert_eq!(verdict, SeedStep::GiveUp);
    }

    /* The other side of that: a CLI that never STOPS saying things — a spinner, a clock in a status
       line — must not wait forever for a silence that is not coming. It is typed into anyway, which
       is safe for the same reason the retries are: only the echo earns the Enter. */
    #[test]
    fn a_pane_that_never_falls_silent_is_still_typed_into() {
        let mut watch = watching();
        let mut pasted_at = None;
        for tick in 1..=200 {
            let now = tick * 100;
            watch.saw_output("spinning", now);          // never a quiet moment
            if watch.step(now) == SeedStep::Paste {
                pasted_at = Some(now);
                break;
            }
        }
        // The clock starts at the pane's FIRST word, which here is 100 ms in.
        assert_eq!(pasted_at, Some(10_100), "typed into once it has plainly been up for a while");
    }

    /* A CLI that never says anything is never typed at: there is nothing to say it is listening. */
    #[test]
    fn a_pane_that_says_nothing_is_given_up_on_rather_than_typed_at() {
        let mut watch = watching();
        assert_eq!(watch.step(50_000), SeedStep::Wait);
        assert_eq!(watch.step(90_000), SeedStep::GiveUp);
    }

    /* F222, spec 148. The one behavioural difference a relay needs: a pane that has been quiet for
       an hour has nothing left to say, and the spawn watcher — which types only after it has heard
       SOMETHING — would wait for a byte that is never coming. The caller supplies when the pane
       last spoke, so the line goes in at the first tick. */
    #[test]
    fn a_message_to_a_pane_that_fell_silent_long_ago_is_typed_at_the_first_look() {
        let seed = Seed { paste: "continue at F1765 [ab12cd34]".into(), confirm: "ab12cd34".into() };
        let mut watch = SeedWatch::listening(seed, 3_600_000, 1_000);
        assert_eq!(watch.step(3_600_000), SeedStep::Paste, "no first byte is waited for");
        assert_eq!(watch.step(3_600_100), SeedStep::Wait);
        watch.saw_output("  > continue at F1765 [ab12cd34]", 3_600_200);
        assert_eq!(watch.step(3_600_300), SeedStep::Submit);
    }

    /* And the other half: ONE attempt. A spawn retries three times to reach a composer through a
       trust dialog; a relay is refused unless the pane is already settled, so a second paste would
       only ever be a second copy of the line in somebody's composer. */
    #[test]
    fn an_unechoed_message_is_tried_once_and_never_submitted() {
        let seed = Seed { paste: "a line [ab12cd34]".into(), confirm: "ab12cd34".into() };
        let mut watch = SeedWatch::listening(seed, 10_000, 1_000);
        let mut pastes = 0;
        let mut verdict = SeedStep::Wait;
        for tick in 0..400 {
            let now = 10_000 + tick * 100;
            match watch.step(now) {
                SeedStep::Paste => pastes += 1,
                SeedStep::Submit => panic!("an unechoed paste must never be submitted"),
                SeedStep::GiveUp => { verdict = SeedStep::GiveUp; break }
                SeedStep::Wait => {}
            }
        }
        assert_eq!(pastes, 1, "one attempt, so a relay can never leave two copies in a composer");
        assert_eq!(verdict, SeedStep::GiveUp);
        assert!(watch.settled(), "and a settled handshake lets the next relay attach");
    }

    /* The paste is bracketed and carries no carriage return, which is what keeps a multi-line
       composer entry from submitting itself and a modal from being answered by the text. */
    #[test]
    fn the_typed_bytes_are_one_bracketed_paste_and_press_nothing() {
        let bytes = watching().paste_bytes();
        assert!(bytes.starts_with(b"\x1b[200~") && bytes.ends_with(b"\x1b[201~"));
        assert!(!bytes.contains(&b'\r') && !bytes.contains(&b'\n'));
    }

    #[test]
    fn decode_holds_an_incomplete_tail_and_replaces_invalid_bytes() {
        let mut tail = Vec::new();
        let first = decode_chunk(&mut tail, "é".as_bytes());
        assert_eq!(first, "é");
        let euro = "€".as_bytes();
        let first_half = decode_chunk(&mut tail, &euro[..2]);
        assert_eq!(first_half, "", "the incomplete sequence is held, not replaced");
        let rest = decode_chunk(&mut tail, &euro[2..]);
        assert_eq!(rest, "€", "the character emerges whole across the read boundary");
        let invalid = decode_chunk(&mut tail, &[0xff, b'a']);
        assert_eq!(invalid, "\u{fffd}a");
    }

    #[test]
    fn truncation_counts_utf16_units_and_keeps_the_tail() {
        let mut session_output: Vec<u16> = Vec::new();
        let mut push = |decoded: &str| {
            session_output.extend(decoded.encode_utf16());
            if session_output.len() > OUTPUT_LIMIT {
                let drop = session_output.len() - OUTPUT_LIMIT;
                session_output.drain(..drop);
            }
        };
        // '😀' + 'a' × (LIMIT-1): one unit over the limit, so the dropped unit is the emoji's
        // HIGH surrogate and the scrollback starts with its LOW half — exactly what JS
        // .slice(-LIMIT) produces at this boundary.
        push("😀");
        push(&"a".repeat(OUTPUT_LIMIT - 1));
        assert_eq!(session_output.len(), OUTPUT_LIMIT);
        assert_eq!(session_output[0], 0xDE00, "the slice splits the emoji exactly as JS .slice does: a lone LOW surrogate leads");
        assert_eq!(session_output[1], b'a' as u16);
    }

    #[test]
    fn base64_round_trip_holds_a_lone_surrogate() {
        let units: Vec<u16> = vec![0xDE00, 0xD83D, 0xDE00, b'a' as u16];
        let mut bytes = Vec::new();
        for unit in &units {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(base64_encode(&bytes), "AN492ADeYQA=");
    }
}

/// Wait for the exit watcher to record an ending, up to `limit` milliseconds. The watcher owns the
/// child handle, so this is how any other thread learns the child is gone.
fn wait_for_exit(session: &Arc<Mutex<PtySession>>, limit: u64) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(limit);
    while session.lock().expect("session lock").state != "exited" && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// Milliseconds since the epoch, the way `Date.now()` counts them: this record travels to a JS host
/// that shows it to a person, so it is that clock or it is nothing.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}
