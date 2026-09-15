//! red-ide: one binary, one subcommand per question (F161, spec 133).
//!
//!   red-ide serve                 the bridge, over stdio, for the worker that spawned it
//!   red-ide directory             the lock directory this environment resolves to
//!   red-ide sweep <directory>     collect the locks of dead workers of ours
//!   red-ide offered               {directory, locks} on stdin -> the editors published for it
//!   red-ide auto-connect          {agent, ide, directory, locks, ourPids} on stdin -> the decision
//!
//! `serve` speaks newline-delimited JSON, the shape `red-lsp-serve` established: a request per line
//! in, an answer per line out, and the process ends when stdin closes — after unlinking its lock,
//! so a worker that died leaves nothing in anyone's `/ide` menu. Two things go the other way:
//! `{"event": ...}` when a retake settles, and `{"ask": N, "method": "diagnostics", "args": [uri]}`
//! when a CLI asks for diagnostics, which the worker answers with `{"answer": N, "result": [...]}`,
//! because the language servers are the worker's (spec 133, D3).

use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use red_ide::bridge::{Bridge, Options, Source};
use red_ide::discovery::{self, IdeOption};
use red_ide::lock;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

fn cwd() -> String {
    std::env::current_dir().map(|path| path.to_string_lossy().into_owned()).unwrap_or_else(|_| "/".to_string())
}

fn read_stdin_json() -> Result<Value, String> {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).map_err(|error| error.to_string())?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).map_err(|error| format!("the input is not JSON: {error}"))
}

fn print(value: &Value) {
    println!("{value}");
}

fn refused(message: &str) -> ExitCode {
    print(&json!({ "error": message, "status": Value::Null }));
    ExitCode::from(1)
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn ide_option(value: Option<&Value>) -> Option<IdeOption> {
    let value = value.filter(|value| !value.is_null())?;
    let flags = value.get("flags").and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
    Some(IdeOption { flags, env_var: text(value, "envVar").unwrap_or_default() })
}

/// The editor protocol this run speaks, from the recipe that declares one. The library implements
/// the protocol and names no CLI; the binary is the composition root that reads which CLI's it is
/// (F220, spec 141). A registry that declares none is a refusal, not a guess: there is no editor
/// protocol to speak.
fn protocol() -> Option<lock::Protocol> {
    let recipes = red_agents::shipped_recipes();
    recipes.iter().find_map(|(cli, _)| {
        red_agents::view(recipes.iter().find(|(name, _)| name == cli).map(|(_, raw)| raw)?)
            .get("ide")
            .and_then(lock::Protocol::declared)
    })
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().collect();
    let Some(protocol) = protocol() else {
        return refused("No agent recipe declares an editor protocol, so there is none to speak.");
    };
    match argv.get(1).map(String::as_str) {
        Some("serve") => serve(protocol),
        Some("directory") => {
            print(&json!(lock::directory(&env, &protocol)));
            ExitCode::SUCCESS
        }
        Some("sweep") => {
            let Some(directory) = argv.get(2) else { return refused("sweep takes a directory.") };
            let removed: Vec<String> = lock::sweep(&PathBuf::from(directory), &lock::alive).iter().map(|path| path.to_string_lossy().into_owned()).collect();
            print(&json!(removed));
            ExitCode::SUCCESS
        }
        Some("offered") => {
            let input = match read_stdin_json() { Ok(value) => value, Err(error) => return refused(&error) };
            let Some(directory) = text(&input, "directory") else { return refused("offered takes a directory.") };
            let locks = text(&input, "locks").unwrap_or_else(|| lock::directory(&env, &protocol));
            let editors: Vec<Value> = discovery::offered_editors(&directory, &PathBuf::from(locks), &cwd(), &discovery::living).iter().map(|editor| editor.to_value()).collect();
            print(&json!(editors));
            ExitCode::SUCCESS
        }
        Some("auto-connect") => {
            let input = match read_stdin_json() { Ok(value) => value, Err(error) => return refused(&error) };
            let Some(directory) = text(&input, "directory") else { return refused("auto-connect takes a directory.") };
            let agent = text(&input, "agent").unwrap_or_default();
            let locks = text(&input, "locks").unwrap_or_else(|| lock::directory(&env, &protocol));
            let our_pids: Vec<Value> = input.get("ourPids").and_then(Value::as_array).cloned().unwrap_or_default();
            let option = ide_option(input.get("ide"));
            print(&discovery::auto_connect(option.as_ref(), &agent, &directory, &PathBuf::from(locks), &cwd(), &our_pids, &discovery::living));
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: red-ide serve | directory | sweep <directory> | offered | auto-connect");
            ExitCode::from(2)
        }
    }
}

/* ---- serve ------------------------------------------------------------------------------------- */

/// What comes up the pipe: a request from the worker, or its answer to an ask of ours.
enum Line {
    Request { id: Value, method: String, args: Value },
    Answer { ask: u64, result: Result<Value, String> },
    Ignored,
}

fn classify(text: &str) -> Line {
    let Ok(value) = serde_json::from_str::<Value>(text) else { return Line::Ignored };
    if let Some(ask) = value.get("answer").and_then(Value::as_u64) {
        let result = match value.get("error") {
            Some(error) => Err(error.get("message").and_then(Value::as_str).unwrap_or("the worker refused the ask").to_string()),
            None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
        };
        return Line::Answer { ask, result };
    }
    match value.get("method").and_then(Value::as_str) {
        Some(method) => Line::Request {
            id: value.get("id").cloned().unwrap_or(Value::Null),
            method: method.to_string(),
            args: value.get("args").cloned().unwrap_or_else(|| json!([])),
        },
        None => Line::Ignored,
    }
}

/// The parent's pid: the process that asked is the worker, which is what `process.pid` meant in
/// the JavaScript's default. Elsewhere, this process's own.
fn caller_pid() -> Value {
    #[cfg(unix)]
    {
        json!(std::os::unix::process::parent_id())
    }
    #[cfg(not(unix))]
    {
        json!(std::process::id())
    }
}

fn options_from(value: &Value, protocol: &lock::Protocol) -> Result<Options, String> {
    let port = match value.get("port") {
        None | Some(Value::Null) => 0,
        Some(port) => u16::try_from(port.as_u64().unwrap_or(0)).map_err(|_| format!("{port} is not a port"))?,
    };
    Ok(Options {
        roots: value.get("roots").cloned().unwrap_or_else(|| json!([])),
        host_pid: value.get("hostPid").cloned().unwrap_or(Value::Null),
        worker_pid: value.get("workerPid").cloned().filter(|pid| !pid.is_null()).unwrap_or_else(caller_pid),
        port,
        directory: PathBuf::from(text(value, "directory").unwrap_or_else(|| lock::directory(&env, protocol))),
        host: text(value, "host").unwrap_or_else(|| "127.0.0.1".to_string()),
        retake_timeout_ms: value.get("retakeTimeoutMs").and_then(Value::as_u64).unwrap_or(lock::RETAKE_TIMEOUT_MS),
        protocol: protocol.clone(),
    })
}

/// The one writer of stdout, so an answer, an event and an ask never interleave.
fn say(value: &Value) {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

struct Serve {
    bridge: Mutex<Option<Arc<Bridge>>>,
    asks: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_ask: Mutex<u64>,
    /// The editor protocol this run speaks, read once at startup from the recipe that declares it.
    protocol: lock::Protocol,
}

impl Serve {
    /// The source `getDiagnostics` reads from: an ask up the pipe, answered by the worker.
    fn source(self: &Arc<Self>) -> Source {
        let serve = self.clone();
        Arc::new(move |uri: Value| {
            let serve = serve.clone();
            Box::pin(async move {
                let (sender, receiver) = oneshot::channel();
                let ask = {
                    let mut next = serve.next_ask.lock().expect("asks");
                    *next += 1;
                    *next
                };
                serve.asks.lock().expect("asks").insert(ask, sender);
                say(&json!({ "ask": ask, "method": "diagnostics", "args": [uri] }));
                match receiver.await {
                    Ok(answer) => answer,
                    Err(_) => Err("the worker went away before answering".to_string()),
                }
            })
        })
    }

    async fn dispatch(self: &Arc<Self>, method: &str, args: &Value) -> Result<Value, String> {
        let bridge = || self.bridge.lock().expect("bridge").clone().ok_or_else(|| "start the bridge first.".to_string());
        match method {
            "start" => {
                let input = args.get(0).cloned().unwrap_or_else(|| json!({}));
                let options = options_from(&input, &self.protocol)?;
                let source = if input.get("diagnostics").and_then(Value::as_bool).unwrap_or(false) { Some(self.source()) } else { None };
                let started = Bridge::start(options, source).await?;
                *self.bridge.lock().expect("bridge") = Some(started.clone());
                if !started.published() && started.reason().as_deref().is_some_and(|reason| reason.contains("still held")) {
                    /* A retake in progress: the outcome goes up the pipe as an event when it settles. */
                    let waiting = started.clone();
                    tokio::spawn(async move {
                        if waiting.ready().await {
                            say(&json!({ "event": "published", "port": waiting.port(), "lock": waiting.lock_path().map(|p| p.to_string_lossy().into_owned()) }));
                        } else {
                            say(&json!({ "event": "unpublished", "reason": waiting.reason() }));
                        }
                    });
                }
                Ok(answer_for(&started))
            }
            "selection" => Ok(json!(bridge()?.selection(&args.get(0).cloned().unwrap_or(Value::Null)))),
            "mention" => Ok(json!(bridge()?.mention(&args.get(0).cloned().unwrap_or(Value::Null)))),
            "clients" => Ok(json!(bridge()?.clients())),
            "observed" => Ok(json!(bridge()?.observed())),
            "close" => {
                if let Some(bridge) = self.bridge.lock().expect("bridge").clone() {
                    bridge.close().await;
                }
                Ok(Value::Null)
            }
            "sweep" => {
                let directory = args.get(0).and_then(Value::as_str).map(PathBuf::from).unwrap_or_else(|| PathBuf::from(lock::directory(&env, &self.protocol)));
                let removed: Vec<String> = lock::sweep(&directory, &lock::alive).iter().map(|path| path.to_string_lossy().into_owned()).collect();
                Ok(json!(removed))
            }
            other => Err(format!("Unknown ide method {other}.")),
        }
    }
}

fn answer_for(bridge: &Arc<Bridge>) -> Value {
    json!({
        "published": bridge.published(),
        "port": bridge.port(),
        "lock": bridge.lock_path().map(|path| path.to_string_lossy().into_owned()),
        "authToken": if bridge.auth_token.is_empty() { Value::Null } else { json!(bridge.auth_token) },
        "reason": bridge.reason(),
    })
}

fn serve(protocol: lock::Protocol) -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("red-ide: cannot start a runtime: {error}");
            return ExitCode::from(1);
        }
    };
    runtime.block_on(async {
        let serve = Arc::new(Serve { bridge: Mutex::new(None), asks: Mutex::new(HashMap::new()), next_ask: Mutex::new(0), protocol });
        say(&json!({ "started": true }));
        /* stdin on its own thread: a blocking read must not sit on a runtime worker. */
        let (lines, mut incoming) = mpsc::unbounded_channel::<String>();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let Ok(line) = line else { break };
                if lines.send(line).is_err() {
                    break;
                }
            }
        });
        while let Some(line) = incoming.recv().await {
            if line.trim().is_empty() {
                continue;
            }
            match classify(&line) {
                Line::Request { id, method, args } => {
                    let answer = match serve.dispatch(&method, &args).await {
                        Ok(result) => json!({ "id": id, "result": result }),
                        Err(message) => json!({ "id": id, "error": { "message": message } }),
                    };
                    say(&answer);
                }
                Line::Answer { ask, result } => {
                    if let Some(waiting) = serve.asks.lock().expect("asks").remove(&ask) {
                        let _ = waiting.send(result);
                    }
                }
                Line::Ignored => {}
            }
        }
        /* stdin closed: the worker is gone or done. The lock goes with this process. */
        let bridge = serve.bridge.lock().expect("bridge").clone();
        if let Some(bridge) = bridge {
            bridge.close().await;
        }
    });
    ExitCode::SUCCESS
}
