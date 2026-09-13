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
    pub cols: u16,
    pub rows: u16,
    pub sequence: u64,
    output: Vec<u16>,
    tail: Vec<u8>,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
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

    pub fn core_snapshot(&self) -> Value {
        json!({
            "id": self.id,
            "pid": self.pid,
            "state": self.state,
            "exitCode": self.exit_code,
            "signal": self.signal,
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

pub struct PtyHost<F: FnMut(Value) + Send> {
    sessions: HashMap<String, Arc<Mutex<PtySession>>>,
    emit: Arc<Mutex<F>>,
    pty_system: Box<dyn PtySystem + Send>,
}

impl<F: FnMut(Value) + Send + 'static> PtyHost<F> {
    pub fn new(emit: F) -> Self {
        PtyHost { sessions: HashMap::new(), emit: Arc::new(Mutex::new(emit)), pty_system: native_pty_system() }
    }

    pub fn spawn(&mut self, id: String, file: &str, argv: &[String], env: &HashMap<String, String>, cwd: &str, cols: u16, rows: u16, meta: Value) -> Result<Value> {
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
            cols,
            rows,
            sequence: 0,
            output: Vec::new(),
            tail: Vec::new(),
            writer,
            master: pair.master,
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
                session.core_snapshot()
            };
            (watch_emit.lock().expect("emit lock"))(json!({ "type": "session", "session": snapshot }));
        });
        let snapshot = session.lock().expect("session lock").core_snapshot();
        /* Announced, not just answered. The caller gets this snapshot as its result, but every
           OTHER host attached to this directory has to learn the pane exists somehow, and waiting
           for its first record change or its exit would leave a live pane that a second host
           answers `Unknown session.` about (charter D62). */
        (self.emit.lock().expect("emit lock"))(json!({ "type": "session", "session": snapshot }));
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
        session.writer.write_all(data.as_bytes()).map_err(|error| Fail::raw(error.to_string()))
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
            session.core_snapshot()
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
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2000);
        loop {
            if session.lock().expect("session lock").state == "exited" {
                break;
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        if session.lock().expect("session lock").state != "exited" {
            signal_tree(pid, "KILL")?;
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
