//! The pane's stable MCP endpoint, with a worker that can be replaced underneath it (F163, spec 146).
//!
//! `agents/mcp.mjs`. It is NOT a shim, and that is the whole reason it exists: a CLI
//! opens one stdio connection to its MCP server and keeps it for the life of the session, so a
//! workspace that wants to update its tools while an agent is mid-conversation has to keep that
//! connection while changing what is behind it. This process is the part that does not move.
//!
//! What it holds is one **worker** — `red-mcp` in its ordinary mode, which may be a DIFFERENT build
//! from this one — and the generation the supervisor published. When the generation changes, or the
//! descriptor names a different worker binary, a new worker is started and checked BEFORE the old
//! one is let go, and the CLI is told `notifications/tools/list_changed` so a client that refreshes
//! has the new list by its next turn.
//!
//! Three rules are worth stating because each is a failure that has happened:
//!
//! 1. **A candidate that will not start does not replace a working worker.** It is asked for its
//!    tool list before it is made current, and a failure keeps the previous one and says so on
//!    stderr — an agent mid-turn must not lose its tools because an update was attempted.
//! 2. **Requests are serialised.** The swap happens between requests, never inside one, so a
//!    `tools/call` cannot be answered by a worker that was replaced while it ran.
//! 3. **A name the current worker does not have is answered with the way back**, not with a bare
//!    "not found": the tool list changed after this CLI read it, and the answer says what to do
//!    about it in words that are true for every CLI rather than for a named one (F220, spec 141).

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};

/// What this facade tells a CLI it is. The name and instructions are the JavaScript's, because a
/// CLI reads them and they are part of the surface.
const NAME: &str = "rengine-workspace";
const VERSION: &str = "1.1.0";
const INSTRUCTIONS: &str = "Tools retain the original project/session-host binding. Views detach; Stop explicitly ends a process. Poll update_status after update_workspace. Native/service/tool updates retain the CLI; session-host replacement requires quiescence.";

struct Worker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    generation: i64,
    file: PathBuf,
    /// The last answer to `tools/list`, kept so a stale name can be answered without asking again.
    tools: Vec<String>,
}

impl Worker {
    /// One request, written and read back. The worker answers in order on one stream, so the reply
    /// to the line just written is the next line that carries an id.
    fn ask(&mut self, message: &Value) -> Result<Value, String> {
        writeln!(self.stdin, "{message}").map_err(|error| format!("the tool worker closed its input: {error}"))?;
        self.stdin.flush().map_err(|error| format!("the tool worker closed its input: {error}"))?;
        loop {
            let mut line = String::new();
            match self.stdout.read_line(&mut line) {
                Ok(0) => return Err("the tool worker closed its output".to_string()),
                Ok(_) => {}
                Err(error) => return Err(format!("the tool worker could not be read: {error}")),
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(answer): Result<Value, _> = serde_json::from_str(trimmed) else { continue };
            /* A notification the worker sent on its own is not the answer to this request. It is
               dropped rather than forwarded: the facade owns what the CLI is told about the tool
               list, because only the facade knows when a swap happened. */
            if answer.get("id").is_some() {
                return Ok(answer);
            }
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct Facade {
    context: PathBuf,
    snapshot: String,
    descriptor: PathBuf,
    sibling: PathBuf,
    worker: Option<Worker>,
    /// The id this facade uses for its own asks, counting DOWN so it can never collide with the
    /// CLI's, which count up — the same split the supervisor's control channel uses (spec 144).
    next_id: i64,
}

impl Facade {
    pub fn new(context: &Path, snapshot: String, descriptor: PathBuf, sibling: PathBuf) -> Self {
        Self { context: context.to_path_buf(), snapshot, descriptor, sibling, worker: None, next_id: -1 }
    }

    fn id(&mut self) -> i64 {
        let id = self.next_id;
        self.next_id -= 1;
        id
    }

    /// The descriptor the supervisor publishes: which worker to run, and which generation it is.
    /// A descriptor that is not there names none, and the sibling serves — which is the ordinary
    /// case for a workspace with no supervisor in front of it.
    fn declared(&self) -> (PathBuf, i64) {
        let Ok(text) = std::fs::read_to_string(&self.descriptor) else { return (self.sibling.clone(), 0) };
        let Ok(value): Result<Value, _> = serde_json::from_str(&text) else { return (self.sibling.clone(), 0) };
        let generation = value.get("connectorGeneration").and_then(Value::as_i64).unwrap_or(0);
        let named = value.get("toolWorker").and_then(Value::as_str).filter(|path| Path::new(path).is_absolute());
        (named.map(PathBuf::from).unwrap_or_else(|| self.sibling.clone()), generation)
    }

    /// Start a worker and prove it answers before anything depends on it.
    fn start(&mut self, file: &Path, generation: i64) -> Result<Worker, String> {
        let mut child = Command::new(file)
            .arg("--context")
            .arg(&self.context)
            .env("RENGINE_MCP_CONTEXT_SNAPSHOT", &self.snapshot)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("MCP tool worker failed to start: {error}"))?;
        let stdin = child.stdin.take().ok_or("the tool worker has no input")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("the tool worker has no output")?);
        let mut worker = Worker { child, stdin, stdout, generation, file: file.to_path_buf(), tools: Vec::new() };
        /* Initialise and list, which is what proves it is a worker rather than merely a process. */
        let id = self.id();
        worker.ask(&json!({ "jsonrpc": "2.0", "id": id, "method": "initialize", "params": {
            "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "rengine-tool-facade", "version": "1.0.0" } } }))?;
        let _ = writeln!(worker.stdin, "{}", json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
        let _ = worker.stdin.flush();
        let id = self.id();
        let listed = worker.ask(&json!({ "jsonrpc": "2.0", "id": id, "method": "tools/list", "params": {} }))?;
        worker.tools = listed
            .get("result")
            .and_then(|result| result.get("tools"))
            .and_then(Value::as_array)
            .map(|tools| tools.iter().filter_map(|tool| tool.get("name").and_then(Value::as_str)).map(str::to_string).collect())
            .unwrap_or_default();
        Ok(worker)
    }

    /// The worker to use for the next request, replacing the current one if the workspace has
    /// published a different generation. Answers whether the CLI should be told the list changed.
    fn ready(&mut self) -> Result<bool, String> {
        let (file, generation) = self.declared();
        let current = self.worker.as_ref().map(|worker| (worker.file.clone(), worker.generation));
        if current.as_ref() == Some(&(file.clone(), generation)) {
            return Ok(false);
        }
        match self.start(&file, generation) {
            Ok(worker) => {
                let had = self.worker.is_some();
                /* The previous worker is dropped — and therefore closed — only once the new one has
                   answered, so a candidate that will not start never costs the CLI its tools. */
                self.worker = Some(worker);
                Ok(had)
            }
            Err(why) => {
                if self.worker.is_some() {
                    eprintln!("{why}; keeping previous tool worker.");
                    Ok(false)
                } else {
                    Err(why)
                }
            }
        }
    }

    /// Ask the current worker, starting a fresh one if the one we held has gone.
    ///
    /// A worker whose pipe is broken is a worker that EXITED — which is the ordinary end of a
    /// layered update, where the previous worker is retired the moment the switch commits. The
    /// JavaScript handled it by dropping a closed client and letting the next `ready()` start one;
    /// answering the CLI "broken pipe" instead would turn a successful update into a failed tool
    /// call. The retry is once, and only after a NEW worker answered, so a worker that is genuinely
    /// broken is reported rather than retried forever.
    fn ask_once(&mut self, message: &Value) -> Result<Value, String> {
        if let Some(worker) = self.worker.as_mut() {
            match worker.ask(message) {
                Ok(answer) => return Ok(answer),
                Err(why) => {
                    if self.worker.as_mut().is_some_and(|worker| worker.child.try_wait().ok().flatten().is_none()) {
                        /* Still running, so the failure is this request's rather than the worker's. */
                        return Err(why);
                    }
                    self.worker = None;
                }
            }
        }
        self.ready()?;
        let worker = self.worker.as_mut().ok_or("no tool worker is running")?;
        worker.ask(message)
    }

    /// What to say when a CLI calls a name the current worker does not have. Said once, for every
    /// CLI: whether a particular one refreshes was written out per agent in the JavaScript, which
    /// meant the sentence was wrong for the next CLI to arrive (F220, spec 141).
    fn stale(&self, name: &str) -> Value {
        let worker = self.worker.as_ref();
        let names = worker.map(|worker| worker.tools.join(", ")).unwrap_or_default();
        let generation = worker.map(|worker| worker.generation).unwrap_or(0);
        json!({ "isError": true, "content": [{ "type": "text", "text": format!(
            "{name} is not in this workspace\u{2019}s current tool set (connector generation {generation}): the tool list changed after this CLI read it. \
Current tools: {names}. A CLI that refreshes on tools/list_changed has the new list by its next turn; one that does not needs restarting before a NEW name is reachable \
\u{2014} behaviour behind an existing name is already current either way.") }] })
    }

    fn is_missing(answer: &Value, name: &str) -> bool {
        /* The SDK answers an unknown name as an isError result carrying exactly this text; older
           releases raised it as an error object instead. Both are the same fact. */
        if let Some(error) = answer.get("error") {
            let message = error.get("message").and_then(Value::as_str).unwrap_or("");
            return error.get("code").and_then(Value::as_i64) == Some(-32602) && message.contains(&format!("Tool {name} not found"));
        }
        let result = answer.get("result");
        let is_error = result.and_then(|result| result.get("isError")).and_then(Value::as_bool) == Some(true);
        let content = result.and_then(|result| result.get("content")).and_then(Value::as_array);
        is_error
            && content.is_some_and(|items| {
                items.len() == 1
                    && items[0].get("type").and_then(Value::as_str) == Some("text")
                    && matches!(items[0].get("text").and_then(Value::as_str),
                        Some(text) if text == format!("MCP error -32602: Tool {name} not found") || text == format!("Tool {name} not found"))
            })
    }

    /// Serve the CLI until its stream ends.
    ///
    /// **A watcher runs beside the loop**, because an update the agent did not ask for still has to
    /// reach it: a CLI that is idle is exactly when an update happens, and a facade that only looked
    /// between requests would leave that CLI on the old tool list until it happened to ask for
    /// something. The watcher and the loop share one lock, which is also what serialises the swap
    /// against a request in flight — rule 2.
    pub fn serve(mut self) -> Result<(), String> {
        self.ready()?;
        let descriptor = self.descriptor.clone();
        let shared = std::sync::Arc::new(std::sync::Mutex::new(self));
        let watched = std::sync::Arc::clone(&shared);
        /* Detached on purpose: it ends when the process does, and the process ends when the CLI
           closes its stream. Nothing here owns a shutdown the main loop does not already have. */
        std::thread::spawn(move || {
            let mut seen = signature_of(&descriptor);
            loop {
                std::thread::sleep(Duration::from_millis(1000));
                let now = signature_of(&descriptor);
                if now == seen {
                    continue;
                }
                seen = now;
                let Ok(mut facade) = watched.lock() else { return };
                if matches!(facade.ready(), Ok(true)) {
                    facade.notify_list_changed();
                }
            }
        });

        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let mut facade = shared.lock().map_err(|_| "the facade lock was poisoned".to_string())?;
            facade.handle(trimmed);
        }
        Ok(())
    }

    /// Tell the CLI the tool list moved. Written straight out, because the only two callers already
    /// hold the lock that makes writing safe.
    fn notify_list_changed(&self) {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "{}", json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }));
        let _ = out.flush();
    }

    fn answer(&self, message: Value) {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "{message}");
        let _ = out.flush();
    }

    /// One line from the CLI, answered.
    fn handle(&mut self, line: &str) {
        let Ok(message): Result<Value, _> = serde_json::from_str(line) else {
            self.answer(json!({ "jsonrpc": "2.0", "id": Value::Null, "error": { "code": -32700, "message": "Parse error" } }));
            return;
        };
        let method = message.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        let Some(id) = message.get("id").cloned() else { return };
        /* The facade answers `initialize` itself: the CLI is connecting to THIS process, which is
           the thing that does not move, and its identity must not change under a swap. */
        if method == "initialize" {
            let asked = message.get("params").and_then(|params| params.get("protocolVersion")).and_then(Value::as_str);
            self.answer(json!({ "jsonrpc": "2.0", "id": id, "result": {
                "protocolVersion": asked.unwrap_or("2025-11-25"),
                "capabilities": { "tools": { "listChanged": true } },
                "serverInfo": { "name": NAME, "version": VERSION },
                "instructions": INSTRUCTIONS } }));
            return;
        }
        let changed = match self.ready() {
            Ok(changed) => changed,
            Err(why) => {
                self.answer(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": why } }));
                return;
            }
        };
        if changed {
            self.notify_list_changed();
        }
        let name = message.get("params").and_then(|params| params.get("name")).and_then(Value::as_str).unwrap_or("").to_string();
        let answer = match self.ask_once(&message) {
            Ok(answer) => answer,
            Err(why) => {
                self.answer(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": why } }));
                return;
            }
        };
        let answer = if method == "tools/call" && Self::is_missing(&answer, &name) {
            json!({ "jsonrpc": "2.0", "id": id, "result": self.stale(&name) })
        } else {
            answer
        };
        self.answer(answer);
    }

}

/// Enough of the descriptor's identity to tell a change from a re-read, as the JavaScript's
/// `ino:mtime:size` did. A free function, because the watcher reads it WITHOUT the lock — taking the
/// lock once a second to look at a file would block a request for no reason.
fn signature_of(descriptor: &Path) -> String {
    match std::fs::metadata(descriptor) {
        Ok(meta) => format!(
            "{}:{}:{}",
            meta.len(),
            meta.modified().unwrap_or(SystemTime::UNIX_EPOCH).duration_since(SystemTime::UNIX_EPOCH).unwrap_or(Duration::ZERO).as_millis(),
            inode(&meta)
        ),
        Err(_) => "absent".to_string(),
    }
}

#[cfg(unix)]
fn inode(meta: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.ino()
}

#[cfg(not(unix))]
fn inode(_meta: &std::fs::Metadata) -> u64 {
    0
}
