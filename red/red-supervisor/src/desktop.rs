//! The desktop window as a child process (F159, spec 144).
//!
//! Two things live here, and they are the two halves of "the supervisor owns the windows":
//!
//! **What a desktop is launched with.** A handful of `RENGINE_*` variables and one argument, and
//! they are a CONTRACT with the native side rather than an internal detail — the desktop reads them
//! at startup to learn which workspace it belongs to, which window it is, and what to open in it. A
//! port that renamed one, or set one that should have been absent, would produce a window that
//! starts and is quietly wrong: bound to nothing, or resuming an agent nobody asked to resume.
//!
//! The **absences** are the part worth being careful about. JavaScript drops an `undefined` value
//! from a spawn environment entirely, so a desktop that is not a project window has no
//! `RENGINE_WINDOW_ID` at all, while one with no terminal has `RENGINE_INITIAL_TERMINAL=""` — two
//! different facts, and a port that wrote `""` for both would collapse them. `Option` is that
//! distinction, and `orchestrator/tests/desktop-launch-corpus.json` is the record of it, taken from
//! a process that actually received the environment rather than from the object handed to `spawn`.
//!
//! **How it is asked things.** One newline-framed JSON request per line down stdin, one answer per
//! line back up stdout, and the ids count DOWN from -1 because the desktop's own requests count up.
//! Everything else on that stream is the native side's diagnostics and is skipped rather than
//! parsed — a window that printed a warning must not fail an inspection.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

/// Which desktop this is, and what it opens on. Every field is exactly one `RENGINE_*` variable.
#[derive(Debug, Clone, Default)]
pub struct Binding {
    /// The project window this desktop IS, when it is one. Absent for an ordinary desktop.
    pub window_id: Option<String>,
    /// The title the window store kept for it. Absent unless the store had one.
    pub title: Option<String>,
    /// The project it opens on — the empty string for an empty workspace, which is a root the
    /// person has not chosen rather than a missing field.
    pub root: String,
    pub terminal: Option<String>,
    pub agent: Option<String>,
    pub game: Option<String>,
    /// Resume the agent rather than start a fresh conversation. Absent, not `0`, when false.
    pub resume: bool,
    pub owner: String,
    pub view: String,
}

/// Where the supervisor is, and what a desktop presents to reach it.
#[derive(Debug, Clone)]
pub struct Instance {
    pub url: String,
    pub token: String,
}

/// `--control` for a window a person uses, `--automation` for one a test drives.
pub fn arguments(inspect_ui: bool) -> [&'static str; 1] {
    if inspect_ui {
        ["--automation"]
    } else {
        ["--control"]
    }
}

/// The variables the supervisor writes, in the order `runtime/desktop.mjs` writes them.
///
/// Only the ones it writes: a desktop inherits the rest of the environment, and this composes the
/// supervisor's own layer over it. A name absent from this list is a name the desktop must not see
/// set by the supervisor.
pub fn environment(instance: &Instance, binding: &Binding) -> Vec<(String, String)> {
    let mut written: Vec<(String, String)> = Vec::new();
    let mut set = |name: &str, value: &str| written.push((name.to_string(), value.to_string()));
    set("RENGINE_WORKSPACE_URL", &instance.url);
    set("RENGINE_WORKSPACE_TOKEN", &instance.token);
    /* Absent rather than empty: a desktop that is not a project window has no window id, and the
       native side tells that from an empty one. */
    if let Some(window) = binding.window_id.as_deref() {
        set("RENGINE_WINDOW_ID", window);
    }
    if let Some(title) = binding.title.as_deref() {
        set("RENGINE_WINDOW_TITLE", title);
    }
    set("RENGINE_INITIAL_ROOT", &binding.root);
    set("RENGINE_INITIAL_TERMINAL", binding.terminal.as_deref().unwrap_or_default());
    set("RENGINE_INITIAL_AGENT", binding.agent.as_deref().unwrap_or_default());
    set("RENGINE_INITIAL_GAME", binding.game.as_deref().unwrap_or_default());
    if binding.resume {
        set("RENGINE_RESUME_AGENT", "1");
    }
    set("RENGINE_LAYERED_CHILD", "1");
    set("RENGINE_CAN_RELOAD", "1");
    set("RENGINE_DESKTOP_OWNER", &binding.owner);
    set("RENGINE_DESKTOP_VIEW", &binding.view);
    written
}

/// The sentences a caller is shown when the channel cannot answer. All four are read by a person
/// looking at why a window would not inspect, close or focus.
pub const TOO_MUCH: &str = "Native inspection exceeded its bounded response.";
pub const EXITED: &str = "Native window exited.";
pub const SILENT: &str = "Native window did not respond.";
pub const NO_INSPECTION: &str = "Native window does not support inspection.";

/// How long a native window gets to answer, and how much it may say while doing it.
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(5);
pub const REPLY_LIMIT: usize = 8 * 1024 * 1024;

type Pending = Arc<Mutex<HashMap<i64, Sender<Result<Value, String>>>>>;

/// The control channel to one desktop window.
///
/// Requests go down as one JSON line each and answers come back the same way. Lines that are not
/// JSON are the native side's diagnostics and are skipped: a window that printed a warning must not
/// fail the inspection that was in flight.
pub struct Control {
    inbox: Mutex<Box<dyn Write + Send>>,
    pending: Pending,
    /// Counts DOWN from -1. The desktop numbers its own requests upward, so a negative id can never
    /// be mistaken for one of them.
    next: Mutex<i64>,
}

fn settle(pending: &Pending, id: i64, answer: Result<Value, String>) {
    if let Some(waiting) = pending.lock().expect("pending lock").remove(&id) {
        let _ = waiting.send(answer);
    }
}

fn settle_all(pending: &Pending, why: &str) {
    let waiting: Vec<Sender<Result<Value, String>>> = pending.lock().expect("pending lock").drain().map(|(_, sender)| sender).collect();
    for sender in waiting {
        let _ = sender.send(Err(why.to_string()));
    }
}

impl Control {
    /// Take the child's two pipes. The reader runs on its own thread for the window's whole life.
    pub fn over(inbox: impl Write + Send + 'static, outbox: impl Read + Send + 'static) -> Arc<Self> {
        let control = Arc::new(Self {
            inbox: Mutex::new(Box::new(inbox)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: Mutex::new(-1),
        });
        let pending = control.pending.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(outbox);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                /* The bound is on ONE line, because that is what a reply is. A native side that
                   printed megabytes without a newline would otherwise be buffered without limit. */
                if line.len() > REPLY_LIMIT {
                    settle_all(&pending, TOO_MUCH);
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(line.trim_end()) else { continue };
                let Some(id) = value.get("id").and_then(Value::as_i64) else { continue };
                settle(&pending, id, Ok(value.get("result").cloned().unwrap_or(Value::Null)));
            }
            /* The stream ended, which is the window going away. Everyone waiting is told so rather
               than left to time out five seconds later on a process that is already gone. */
            settle_all(&pending, EXITED);
        });
        control
    }

    /// Ask the window something and wait for its answer.
    pub fn ask(&self, command: Value) -> Result<Value, String> {
        self.asking(command, REPLY_TIMEOUT)
    }

    pub fn asking(&self, command: Value, timeout: Duration) -> Result<Value, String> {
        let id = {
            let mut next = self.next.lock().expect("id lock");
            let id = *next;
            *next -= 1;
            id
        };
        let (sender, receiver) = channel();
        self.pending.lock().expect("pending lock").insert(id, sender);
        let mut framed = command;
        if let Some(fields) = framed.as_object_mut() {
            fields.insert("id".into(), json!(id));
        }
        let written = {
            let mut inbox = self.inbox.lock().expect("inbox lock");
            writeln!(inbox, "{framed}").and_then(|()| inbox.flush())
        };
        if let Err(error) = written {
            self.pending.lock().expect("pending lock").remove(&id);
            return Err(error.to_string());
        }
        match receiver.recv_timeout(timeout) {
            Ok(answer) => answer,
            Err(_) => {
                self.pending.lock().expect("pending lock").remove(&id);
                Err(SILENT.to_string())
            }
        }
    }

    /// The child exited. Everyone waiting is told, rather than left to time out on a dead process.
    pub fn ended(&self) {
        settle_all(&self.pending, EXITED);
    }
}

/// `control-state`, with the one field a caller never needs stripped.
///
/// `state.state` is the desktop's whole internal tree; what an inspection is for is the window's
/// shape, and carrying the tree would make every inspection a megabyte.
pub fn inspection(answer: &Value) -> Result<Value, String> {
    let Some(fields) = answer.as_object() else { return Err(NO_INSPECTION.to_string()) };
    let mut state = fields.clone();
    state.shift_remove("state");
    Ok(Value::Object(state))
}

/// `.cache/desktop/bin/rengine`, or the Windows layout beside it.
pub fn native_binary(checkout: &std::path::Path) -> std::path::PathBuf {
    if cfg!(windows) {
        checkout.join(".cache/desktop/bin/Release/rengine.exe")
    } else {
        checkout.join(".cache/desktop/bin/rengine")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recorded() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|red| red.parent())
            .expect("the checkout")
            .join("orchestrator/tests/desktop-launch-corpus.json");
        serde_json::from_str(&std::fs::read_to_string(&path).expect("the recorded launches")).expect("a record")
    }

    fn text(value: &Value, name: &str) -> Option<String> {
        value.get(name).and_then(Value::as_str).map(str::to_string)
    }

    /// The environment a desktop actually received, case for case — absences included, because the
    /// record was taken from a process rather than from the object handed to `spawn`.
    #[test]
    fn a_desktop_is_launched_with_what_the_javascript_launched_it_with() {
        let record = recorded();
        let instance = Instance {
            url: record["instance"]["url"].as_str().expect("a url").to_string(),
            token: record["instance"]["token"].as_str().expect("a token").to_string(),
        };
        let mut seen = 0;
        for case in record["cases"].as_array().expect("cases") {
            let given = &case["binding"];
            let binding = Binding {
                window_id: text(given, "windowId"),
                title: text(given, "title"),
                root: text(given, "root").unwrap_or_default(),
                terminal: text(given, "terminal"),
                agent: text(given, "agent"),
                game: text(given, "game"),
                resume: given.get("resume") == Some(&json!(true)),
                owner: text(given, "owner").unwrap_or_default(),
                view: text(given, "view").unwrap_or_default(),
            };
            let written = environment(&instance, &binding);
            let composed: serde_json::Map<String, Value> =
                written.iter().map(|(name, value)| (name.clone(), json!(value))).collect();
            assert_eq!(Value::Object(composed), case["env"], "{}", case["name"]);
            /* And what is NOT set, which is the half a port collapses by writing "" for both. */
            for absent in case["absent"].as_array().expect("absences") {
                let name = absent.as_str().expect("a name");
                assert!(!written.iter().any(|(written, _)| written == name), "{name} must be unset: {}", case["name"]);
            }
            let inspect = case["inspectUI"] == json!(true);
            let argv: Vec<Value> = arguments(inspect).iter().map(|value| json!(value)).collect();
            assert_eq!(Value::Array(argv), case["argv"], "{}", case["name"]);
            seen += 1;
        }
        assert!(seen >= 9, "the whole record was replayed: {seen}");
    }

    /// A stand-in window: it answers the ids it is asked about, and may say other things first.
    struct Window {
        inbox: std::sync::mpsc::Receiver<String>,
    }

    fn paired() -> (Arc<Control>, Window, std::sync::mpsc::Sender<String>) {
        /* Two in-memory pipes, so the channel is exercised end to end without a process. */
        let (asked, inbox) = std::sync::mpsc::channel::<String>();
        let (says, said) = std::sync::mpsc::channel::<String>();
        struct Writer(std::sync::mpsc::Sender<String>, Vec<u8>);
        impl Write for Writer {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.1.extend_from_slice(bytes);
                while let Some(at) = self.1.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<u8> = self.1.drain(..=at).collect();
                    let _ = self.0.send(String::from_utf8_lossy(&line[..line.len() - 1]).to_string());
                }
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        struct Reader(std::sync::mpsc::Receiver<String>, Vec<u8>);
        impl Read for Reader {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                if self.1.is_empty() {
                    match self.0.recv() {
                        Ok(line) => self.1 = line.into_bytes(),
                        Err(_) => return Ok(0),
                    }
                }
                let taken = self.1.len().min(out.len());
                out[..taken].copy_from_slice(&self.1[..taken]);
                self.1.drain(..taken);
                Ok(taken)
            }
        }
        (Control::over(Writer(asked, Vec::new()), Reader(said, Vec::new())), Window { inbox }, says)
    }

    #[test]
    fn a_question_goes_down_with_a_negative_id_and_its_answer_comes_back() {
        let (control, window, says) = paired();
        let held = control.clone();
        let asking = std::thread::spawn(move || held.ask(json!({ "op": "control-state" })));
        let line = window.inbox.recv_timeout(Duration::from_secs(5)).expect("the question");
        let asked: Value = serde_json::from_str(&line).expect("json");
        assert_eq!(asked["op"], json!("control-state"));
        assert_eq!(asked["id"], json!(-1), "ids count DOWN, so they never collide with the desktop's own");
        /* Diagnostics first, which is the case that matters: a window that printed a warning must
           not fail the inspection in flight. */
        says.send("starting renderer\n".to_string()).expect("sent");
        says.send(format!("{}\n", json!({ "id": -1, "result": { "panes": 2, "state": { "big": true } } }))).expect("sent");
        let answer = asking.join().expect("joined").expect("an answer");
        assert_eq!(answer["panes"], json!(2));
        /* And the next question takes the next id down. */
        let held = control.clone();
        let again = std::thread::spawn(move || held.ask(json!({ "op": "control-focus" })));
        let line = window.inbox.recv_timeout(Duration::from_secs(5)).expect("the question");
        assert_eq!(serde_json::from_str::<Value>(&line).expect("json")["id"], json!(-2));
        says.send(format!("{}\n", json!({ "id": -2, "result": true }))).expect("sent");
        assert_eq!(again.join().expect("joined").expect("an answer"), json!(true));
    }

    /// The window went away. Everyone waiting is told so, rather than left to time out five seconds
    /// later on a process that is already gone.
    #[test]
    fn a_window_that_exits_answers_everyone_waiting_on_it() {
        let (control, window, says) = paired();
        let held = control.clone();
        let asking = std::thread::spawn(move || held.ask(json!({ "op": "control-state" })));
        let _ = window.inbox.recv_timeout(Duration::from_secs(5)).expect("the question");
        drop(says);
        assert_eq!(asking.join().expect("joined"), Err(EXITED.to_string()));
    }

    #[test]
    fn a_window_that_says_nothing_is_reported_rather_than_waited_on_forever() {
        let (control, window, _says) = paired();
        let held = control.clone();
        let asking = std::thread::spawn(move || held.asking(json!({ "op": "control-state" }), Duration::from_millis(120)));
        let _ = window.inbox.recv_timeout(Duration::from_secs(5)).expect("the question");
        assert_eq!(asking.join().expect("joined"), Err(SILENT.to_string()));
    }

    /// The bound, and the reason it is on one LINE: a reply is a line, and a native side printing
    /// without a newline would otherwise be buffered without limit.
    #[test]
    fn a_window_that_says_too_much_is_cut_off_by_name() {
        let (control, window, says) = paired();
        let held = control.clone();
        let asking = std::thread::spawn(move || held.asking(json!({ "op": "control-state" }), Duration::from_secs(5)));
        let _ = window.inbox.recv_timeout(Duration::from_secs(5)).expect("the question");
        says.send(format!("{}\n", "x".repeat(REPLY_LIMIT + 1))).expect("sent");
        assert_eq!(asking.join().expect("joined"), Err(TOO_MUCH.to_string()));
    }

    /* An inspection is the window's SHAPE. The internal tree is what makes it a megabyte, and a
       caller never reads it. */
    #[test]
    fn an_inspection_carries_the_shape_and_not_the_whole_tree() {
        let answered = json!({ "panes": 2, "focus": "terminal", "state": { "everything": [1, 2, 3] } });
        let seen = inspection(&answered).expect("a state");
        assert_eq!(seen, json!({ "panes": 2, "focus": "terminal" }));
        for not_a_state in [json!(null), json!(true), json!("state"), json!([])] {
            assert_eq!(inspection(&not_a_state), Err(NO_INSPECTION.to_string()), "{not_a_state}");
        }
    }
}
