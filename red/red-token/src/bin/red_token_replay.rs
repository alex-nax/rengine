//! The judge (F157, spec 132): replays a recorded script against this ledger and prints the same
//! document `orchestrator/tests/token-transcript.mjs` printed from the JavaScript one.
//!
//!   red-token-replay < script.json > answers.json
//!
//! The script arrives on stdin so the suite that owns it stays its single source — the frozen
//! record is the ANSWERS, not the questions, and a script duplicated here could drift away from
//! the one the record was made with.
//!
//!   { "rootId", "windowMs", "startedAt", "mints": [...], "script": [ { "name", "step" } ] }
//!
//! A ledger is a state machine, so the comparison is a transcript rather than a set of independent
//! answers: each step's answer, the status it leaves, and — at the end — both files on disk, because
//! an implementation that agreed step for step and left a different `token.json` would be one that
//! agreed about everything except what happens next.

use std::collections::{HashSet, VecDeque};
use std::io::Read;
use std::sync::{Arc, Mutex};

use red_token::ledger::{FromDesktop, Ledger};
use red_token::{uuid_v4, Identity, Refused};
use serde_json::{json, Value};

fn caller_of(step: &Value) -> Option<Identity> {
    step.get("caller").and_then(Identity::from_value)
}

struct Replay {
    ledger: Ledger,
    clock: Arc<Mutex<i64>>,
    dead: Arc<Mutex<HashSet<i64>>>,
    window: Arc<Mutex<i64>>,
}

impl Replay {
    fn answer(&mut self, step: &Value) -> Result<Value, Refused> {
        if let Some(advance) = step.get("advance").and_then(Value::as_i64) {
            *self.clock.lock().expect("clock lock") += advance;
            return Ok(json!({ "advanced": advance }));
        }
        if let Some(window) = step.get("window").and_then(Value::as_i64) {
            *self.window.lock().expect("window lock") = window;
            return Ok(json!({ "window": window }));
        }
        let caller = caller_of(step);
        let reason = step.get("reason").and_then(Value::as_str).unwrap_or("");
        match step.get("call").and_then(Value::as_str).unwrap_or("") {
            /* What a caller goes through, which is `settle` and then `status`: the ledger's own
               status is a read that settles nothing, and the worker awaits a settle before every
               answer. Both views are recorded, so a replacement cannot skip the settle. */
            "status" => {
                self.ledger.settle();
                Ok(self.ledger.status(caller.as_ref()))
            }
            "rawStatus" => Ok(self.ledger.status(caller.as_ref())),
            "segment" => Ok(self.ledger.segment()),
            "refusal" => Ok(json!({
                "refusal": self.ledger.refusal(caller.as_ref(), step.get("tool").and_then(Value::as_str)),
            })),
            "feed" => Ok(self.ledger.feed.after(step.get("cursor").and_then(Value::as_i64).unwrap_or(0), self.ledger.feed.limit)),
            "gone" => {
                let pid = step.get("pid").and_then(Value::as_i64).unwrap_or(0);
                self.dead.lock().expect("dead lock").insert(pid);
                Ok(json!({ "gone": pid }))
            }
            "contest" => self.ledger.contest(&caller.expect("a caller"), reason),
            "reject" => self.ledger.reject(&caller.expect("a caller"), reason),
            "release" => self.ledger.release(&caller.expect("a caller")),
            "desktop" => {
                /* `open` stands for whatever contest is open now, so the script can name it without
                   knowing which id the mint produced. */
                let named = step.get("contestId").and_then(Value::as_str);
                let contest_id = match named {
                    Some("open") => self.ledger.state.contest.as_ref().map(|contest| contest.id.clone()),
                    other => other.map(str::to_string),
                };
                let request = FromDesktop {
                    contest_id,
                    desktop_id: step.get("desktopId").and_then(Value::as_str).map(str::to_string),
                    reason: reason.to_string(),
                    agent_id: step.get("agentId").and_then(Value::as_str).map(str::to_string),
                    lookup: None,
                };
                self.ledger.desktop(step.get("action").and_then(Value::as_str).unwrap_or(""), &request)
            }
            other => Err(red_token::refuse(format!("unknown call {other}"), 500)),
        }
    }
}

fn main() -> std::process::ExitCode {
    let mut text = String::new();
    if std::io::stdin().read_to_string(&mut text).is_err() {
        eprintln!("red-token-replay: the script is read from stdin");
        return std::process::ExitCode::from(2);
    }
    let document: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("red-token-replay: the script is not JSON: {error}");
            return std::process::ExitCode::from(2);
        }
    };
    let root_id = document.get("rootId").and_then(Value::as_str).unwrap_or_default().to_string();
    let window_ms = document.get("windowMs").and_then(Value::as_i64).unwrap_or(red_token::DEFAULT_WINDOW_MS);
    let started_at = document.get("startedAt").and_then(Value::as_i64).unwrap_or(0);
    let mints: VecDeque<String> = document
        .get("mints")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let empty = Vec::new();
    let script = document.get("script").and_then(Value::as_array).unwrap_or(&empty);

    let directory = std::env::temp_dir().join(format!("red-token-replay-{}", uuid_v4()));
    /* A clock that only moves when the script says so, ids that count, and a set of processes that
       have gone away — every input this ledger has, made data. */
    let clock = Arc::new(Mutex::new(started_at));
    let dead: Arc<Mutex<HashSet<i64>>> = Arc::new(Mutex::new(HashSet::new()));
    let minted = Arc::new(Mutex::new(mints));
    let now = {
        let clock = clock.clone();
        Arc::new(move || *clock.lock().expect("clock lock"))
    };
    let alive = {
        let dead = dead.clone();
        Arc::new(move |pid: i64| !dead.lock().expect("dead lock").contains(&pid))
    };
    let mint = Arc::new(move || minted.lock().expect("mint lock").pop_front().unwrap_or_else(uuid_v4));
    let window = Arc::new(Mutex::new(window_ms));
    let reads_window = {
        let window = window.clone();
        Arc::new(move || *window.lock().expect("window lock"))
    };
    let root = directory.join(&root_id);
    let ledger = match Ledger::open(&root, &root_id, reads_window, alive, now, mint) {
        Ok(ledger) => ledger,
        Err(message) => {
            eprintln!("red-token-replay: {message}");
            return std::process::ExitCode::from(1);
        }
    };
    let mut replay = Replay { ledger, clock, dead, window };

    let mut steps = Vec::new();
    for entry in script {
        let name = entry.get("name").cloned().unwrap_or(Value::Null);
        let step = entry.get("step").cloned().unwrap_or(Value::Null);
        let mut recorded = serde_json::Map::new();
        recorded.insert("name".into(), name);
        match replay.answer(&step) {
            Ok(result) => {
                recorded.insert("ok".into(), result);
            }
            Err(refused) => {
                recorded.insert(
                    "refused".into(),
                    json!({ "message": refused.message, "status": refused.status.map_or(Value::Null, |status| json!(status)) }),
                );
            }
        }
        recorded.insert("status".into(), replay.ledger.status(caller_of(&step).as_ref()));
        steps.push(Value::Object(recorded));
    }
    /* The two files the ledger leaves behind, which is what a replaced worker reads. */
    let file = |name: &str| -> Value {
        std::fs::read_to_string(root.join(name)).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or(Value::Null)
    };
    let answer = json!({ "steps": steps, "ledger": file("token.json"), "feed": file("feed.json") });
    println!("{}", serde_json::to_string_pretty(&answer).unwrap_or_default());
    let _ = std::fs::remove_dir_all(&directory);
    std::process::ExitCode::SUCCESS
}
