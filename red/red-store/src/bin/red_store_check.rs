//! Replays a store corpus captured from the live JS host and reports drift
//! (F169, F147a, spec 129, KI-091; the harness shape red-contract established in F140).
//!
//!   red-store-check <corpus.json> [--emit DIR]
//!
//! The corpus carries every op with its args, result, error and the workspace.json bytes after
//! it, a readback section, file ops on a recorded tree, and the schema cases. This binary
//! replays them all in a fresh working directory (DIR when --emit names one, a temporary one
//! otherwise, kept so the JS host can open the result). Exit 0 with a one-line summary when
//! every answer matched; exit 1 with one line per disagreement, naming the op and what differed.

use std::process::ExitCode;

use red_store::schema::validate_schema;
use red_store::store::{IdShape, Store};
use serde_json::{json, Value};

struct Replay {
    store: Store,
    dir: String,
    ops_counter: std::rc::Rc<std::cell::Cell<usize>>,
    drift: Vec<String>,
}

/// The ids the recorded run minted, in mint order: the two recorded addRoot results and the
/// root every fileOp drives. The replay answers with exactly these, so nothing depends on how
/// the capture numbered its placeholders.
fn mint_queue(corpus: &Value) -> Vec<String> {
    let mut queue = Vec::new();
    // Every recorded addRoot's NEW id, in op order (an idempotent re-add records the id it
    // already had and mints nothing) — the replay answers with exactly these.
    for op in corpus.get("ops").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        if op.get("op").and_then(Value::as_str) == Some("addRoot") {
            if let Some(id) = op.pointer("/result/id").and_then(Value::as_str) {
                if !queue.contains(&id.to_string()) {
                    queue.push(id.to_string());
                }
            }
        }
    }
    queue
}

const STAMPS: [i64; 4] = [1_800_000_000_000, 1_800_000_060_000, 1_800_000_120_000, 1_800_000_180_000];

fn placeholder(index: usize) -> String {
    format!("00000000-0000-4000-8000-{index:012}")
}

impl Replay {
    fn new(dir: &std::path::Path, minted: std::collections::VecDeque<String>) -> Result<Self, String> {
        let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        let state_dir = dir.join("state");
        let mut store = Store::open(&state_dir).map_err(|fail| fail.message)?;
        let ops_counter = std::rc::Rc::new(std::cell::Cell::new(0usize));
        let minted = std::rc::Rc::new(std::cell::RefCell::new(minted));
        let now = {
            let ops_counter = ops_counter.clone();
            move || STAMPS[ops_counter.get().min(STAMPS.len() - 1)]
        };
        let mint = move || minted.borrow_mut().pop_front().unwrap_or_else(|| placeholder(999));
        let temp_counter = std::rc::Rc::new(std::cell::Cell::new(0usize));
        let temp = move || {
            temp_counter.set(temp_counter.get() + 1);
            format!("replay-temp-{}", temp_counter.get())
        };
        store.now = Box::new(now);
        store.mint = Box::new(mint);
        store.temp = Box::new(temp);
        Ok(Replay { store, dir: dir.to_string_lossy().into_owned(), ops_counter, drift: Vec::new() })
    }

    fn map_paths(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(text.replace("<DIR>", &self.dir)),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.map_paths(item)).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(key, value)| (key.clone(), self.map_paths(value))).collect()),
            _ => value.clone(),
        }
    }

    fn judge(&mut self, op: &str, expected: &Value, actual: &Value) {
        if expected != actual {
            self.drift.push(format!("{op}: expected {expected}, got {actual}"));
        }
    }

    fn run_op(&mut self, op: &Value) -> Result<(), String> {
        let name = op.get("op").and_then(Value::as_str).unwrap_or("");
        let args = self.map_paths(op.get("args").unwrap_or(&Value::Null));
        let outcome = self.dispatch(name, &args);
        self.ops_counter.set(self.ops_counter.get() + 1);
        let (result, error) = match outcome {
            Ok(value) => (value, Value::Null),
            Err(fail) => {
                let mut object = serde_json::Map::new();
                object.insert("message".to_string(), json!(fail.message.replace(&self.dir, "<DIR>")));
                object.insert("status".to_string(), fail.status.map(|status| json!(status)).unwrap_or(Value::Null));
                (Value::Null, Value::Object(object))
            }
        };
        let result = self.unmap_paths(result);
        self.judge(&format!("op {} result", op_label(op)), op.get("result").unwrap_or(&Value::Null), &result);
        self.judge(&format!("op {} error", op_label(op)), op.get("error").unwrap_or(&Value::Null), &error);
        let file = std::fs::read_to_string(self.dir.clone() + "/state/workspace.json")
            .map(|text| text.replace(&self.dir, "<DIR>"))
            .unwrap_or_default();
        self.judge(&format!("op {} file", op_label(op)), op.get("file").unwrap_or(&Value::Null), &Value::String(file));
        Ok(())
    }

    fn dispatch(&mut self, name: &str, args: &Value) -> Result<Value, red_store::store::Fail> {
        let arg = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
        match name {
            "addRoot" => {
                let declaration = arg(1).as_str().map(str::to_string);
                self.store.add_root(arg(0).as_str().unwrap_or(""), declaration.as_deref())
            }
            "preferences" => self.store.preferences(&arg(0)),
            "putDraft" => self.store.put_draft(&arg(0)),
            "discardDraft" => {
                self.store.discard_draft(arg(0).as_str().unwrap_or(""), arg(1).as_str().unwrap_or(""))?;
                Ok(Value::Null)
            }
            "recordConversation" => {
                let input = arg(1);
                let agent = input.get("agent").and_then(Value::as_str);
                let shape = match agent {
                    Some("kimi") => IdShape::KimiSession,
                    _ => IdShape::Uuid,
                };
                self.store.record_conversation(arg(0).as_str().unwrap_or(""), &input, shape)
            }
            "saveLayout" => {
                self.store.save_layout(&arg(0))?;
                Ok(Value::Null)
            }
            "list" | "list-hidden" => self.store.list(arg(0).as_str().unwrap_or(""), arg(1).as_str().unwrap_or(""), arg(2).as_bool().unwrap_or(false)),
            "readText" => self.store.read_text(arg(0).as_str().unwrap_or(""), arg(1).as_str().unwrap_or("")),
            "resolve" => {
                let (absolute, relative) = self.store.resolve(arg(0).as_str().unwrap_or(""), arg(1).as_str().unwrap_or(""), false)?;
                Ok(json!({ "absolute": absolute, "relative": relative }))
            }
            "saveText" => self.store.save_text(&arg(0)),
            other => panic!("unknown op {other}"),
        }
    }
}

fn op_label(op: &Value) -> String {
    let name = op.get("op").and_then(Value::as_str).unwrap_or("?");
    let args = op.get("args").map(|args| args.to_string()).unwrap_or_default();
    format!("{name}({})", &args[..args.len().min(80)])
}

fn build_tree(dir: &std::path::Path, spec: &[Value]) -> Result<(), String> {
    for entry in spec {
        let rel = entry.get("path").and_then(Value::as_str).unwrap_or("");
        let target = if rel.starts_with("<DIR>") {
            std::path::PathBuf::from(rel.replace("<DIR>", &dir.to_string_lossy().into_owned()))
        } else {
            dir.join("tree").join(rel)
        };
        if entry.get("dir") == Some(&Value::Bool(true)) {
            std::fs::create_dir_all(&target).map_err(|error| error.to_string())?;
        } else if let Some(destination) = entry.get("symlink").and_then(Value::as_str) {
            #[cfg(unix)]
            {
                let _ = std::os::unix::fs::symlink(destination.replace("<DIR>", &dir.to_string_lossy().into_owned()), &target);
            }
        } else if let Some(base64) = entry.get("base64").and_then(Value::as_str) {
            std::fs::write(&target, decode_base64(base64)?).map_err(|error| error.to_string())?;
        } else if let Some(repeat) = entry.get("repeat").and_then(Value::as_array) {
            let text = repeat[0].as_str().unwrap_or("").repeat(repeat[1].as_u64().unwrap_or(0) as usize);
            std::fs::write(&target, text).map_err(|error| error.to_string())?;
        } else if let Some(text) = entry.get("text").and_then(Value::as_str) {
            std::fs::write(&target, text).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn decode_base64(text: &str) -> Result<Vec<u8>, String> {
    let table = |byte: u8| -> Result<u8, String> {
        match byte {
            b'A'..=b'Z' => Ok(byte - b'A'),
            b'a'..=b'z' => Ok(byte - b'a' + 26),
            b'0'..=b'9' => Ok(byte - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("bad base64 byte {byte}")),
        }
    };
    let mut out = Vec::new();
    let mut acc = 0u32;
    let mut bits = 0;
    for byte in text.bytes().filter(|byte| *byte != b'=') {
        acc = (acc << 6) | table(byte)? as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(corpus_path) = args.next() else {
        eprintln!("usage: red-store-check <corpus.json> [--emit DIR]");
        return ExitCode::from(2);
    };
    let emit = match (args.next().as_deref(), args.next()) {
        (None, None) => None,
        (Some("--emit"), Some(dir)) => Some(dir),
        _ => {
            eprintln!("usage: red-store-check <corpus.json> [--emit DIR]");
            return ExitCode::from(2);
        }
    };
    let text = match std::fs::read_to_string(&corpus_path) {
        Ok(text) => text,
        Err(error) => {
            eprintln!("red-store-check: cannot read {corpus_path}: {error}");
            return ExitCode::from(2);
        }
    };
    let corpus: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("red-store-check: {corpus_path} is not JSON: {error}");
            return ExitCode::from(2);
        }
    };
    let dir = match emit {
        Some(dir) => std::path::PathBuf::from(dir),
        None => std::env::temp_dir().join(format!("red-store-check-{}", std::process::id())),
    };
    let _ = std::fs::remove_dir_all(&dir);
    if let Err(error) = std::fs::create_dir_all(&dir) {
        eprintln!("red-store-check: cannot create {}: {error}", dir.display());
        return ExitCode::from(2);
    }
    let mut checked = 0usize;
    let mut drift: Vec<String> = Vec::new();

    if let Err(error) = build_tree(&dir, corpus.get("tree").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])) {
        eprintln!("red-store-check: the recorded tree would not build: {error}");
        return ExitCode::from(2);
    }
    for project in ["project-a", "project-b"] {
        let _ = std::fs::create_dir_all(dir.join(project));
    }
    let _ = std::fs::create_dir_all(dir.join("project-a").join("notes"));
    let _ = std::fs::write(dir.join("decl.json"), "{}");

    let mut replay = match Replay::new(&dir, mint_queue(&corpus).into()) {
        Ok(replay) => replay,
        Err(error) => {
            eprintln!("red-store-check: the store would not open: {error}");
            return ExitCode::from(2);
        }
    };
    for op in corpus.get("ops").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        if let Err(error) = replay.run_op(op) {
            eprintln!("red-store-check: replay broke: {error}");
            return ExitCode::from(2);
        }
        checked += 1;
    }
    drift.extend(replay.drift.drain(..));

    /* The read-back questions, answered against the replayed state. */
    if let Some(readback) = corpus.get("readback") {
        let root_a = corpus.pointer("/ops/0/result/id").and_then(Value::as_str).unwrap_or("");
        let root_b = corpus.pointer("/ops/2/result/id").and_then(Value::as_str).unwrap_or("");
        let answers = json!({
            "draft": replay.store.get_draft(root_a, "notes/todo.md"),
            "conversationsA": replay.store.list_conversations(root_a),
            "conversationsB": replay.store.list_conversations(root_b),
            "preferences": replay.store.state.get("preferences").cloned().unwrap_or(Value::Null),
        });
        if &answers != readback {
            drift.push(format!("readback: expected {readback}, got {answers}"));
        }
        checked += 1;
    }

    for op in corpus.get("fileOps").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        let name = op.get("op").and_then(Value::as_str).unwrap_or("");
        let args = replay.map_paths(op.get("args").unwrap_or(&Value::Null));
        let outcome = if name == "fileBytes" {
            let target = format!("{}/tree/{}", replay.dir, args.get(0).and_then(Value::as_str).unwrap_or(""));
            std::fs::read_to_string(&target).map(Value::String).map_err(|error| red_store::store::Fail { message: error.to_string(), status: None })
        } else {
            replay.dispatch(name, &args)
        };
        let (result, error) = match outcome {
            Ok(value) => (value, Value::Null),
            Err(fail) => {
                let mut object = serde_json::Map::new();
                object.insert("message".to_string(), json!(fail.message.replace(&replay.dir, "<DIR>")));
                object.insert("status".to_string(), fail.status.map(|status| json!(status)).unwrap_or(Value::Null));
                (Value::Null, Value::Object(object))
            }
        };
        let result = match result {
            Value::String(text) if name == "fileBytes" => Value::String(text),
            other => replay.unmap_paths(other),
        };
        replay.judge(&format!("fileOp {} result", op_label(op)), op.get("result").unwrap_or(&Value::Null), &result);
        replay.judge(&format!("fileOp {} error", op_label(op)), op.get("error").unwrap_or(&Value::Null), &error);
        checked += 1;
    }
    drift.extend(replay.drift.drain(..));

    for case in corpus.get("schema").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        let name = case.get("name").and_then(Value::as_str).unwrap_or("?");
        let errors: Vec<String> = validate_schema(case.get("schema").unwrap_or(&Value::Null), case.get("value").unwrap_or(&Value::Null));
        let expected: Vec<String> = case.get("errors").and_then(Value::as_array).map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect()).unwrap_or_default();
        if errors != expected {
            drift.push(format!("schema {name}: expected {expected:?}, got {errors:?}"));
        }
        checked += 1;
    }

    if drift.is_empty() {
        println!("red-store-check: {checked} judgements, no drift");
        ExitCode::SUCCESS
    } else {
        for line in &drift {
            println!("{line}");
        }
        println!("red-store-check: {} disagreement(s) over {checked} judgements", drift.len());
        ExitCode::from(1)
    }
}

impl Replay {
    fn unmap_paths(&self, value: Value) -> Value {
        match value {
            Value::String(text) => Value::String(text.replace(&self.dir, "<DIR>")),
            Value::Array(items) => Value::Array(items.into_iter().map(|item| self.unmap_paths(item)).collect()),
            Value::Object(map) => Value::Object(map.into_iter().map(|(key, value)| (key, self.unmap_paths(value))).collect()),
            _ => value,
        }
    }
}
