//! Every declared server for one project root, and the diagnostics they have published between
//! them (F161).
//!
//! One store with two readers — the editor pane and `mcp__ide__getDiagnostics` — so a person and an
//! agent cannot be told different things about the same file.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::wire::{frame, matches, Framer};

const RESTART_BASE_MS: u64 = 500;
const RESTART_CEILING_MS: u64 = 30_000;
const RESTART_GIVE_UP: u32 = 5;
const INITIALIZE_TIMEOUT_MS: u64 = 10_000;

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// The diagnostics every server has published, and the version a reader polls with.
#[derive(Default)]
struct Store {
    /// uri -> [(server id, items)] — one entry per server, so a second server's opinion does not
    /// erase the first's.
    published: HashMap<String, Vec<(String, Vec<Value>)>>,
    version: u64,
}

impl Store {
    fn record(&mut self, uri: &str, from: &str, items: Vec<Value>) {
        let entries = self.published.entry(uri.to_string()).or_default();
        entries.retain(|(who, _)| who != from);
        if !items.is_empty() {
            entries.push((from.to_string(), items));
        }
        /* Bumped on every publish, INCLUDING one that clears. A reader polls with the version it
           drew and is told "nothing new" rather than being handed the same list to re-render. */
        self.version += 1;
    }

    fn items(&self, uri: &str) -> Vec<Value> {
        self.published.get(uri).map(|entries| entries.iter().flat_map(|(_, items)| items.clone()).collect()).unwrap_or_default()
    }
}

struct Document {
    version: u64,
    text: String,
}

/// The mutable half of one server: what is running, what it has been told, and why it is not here.
#[derive(Default)]
struct Live {
    stdin: Option<ChildStdin>,
    child: Option<Child>,
    next: i64,
    pending: HashMap<i64, mpsc::Sender<Value>>,
    documents: Vec<(String, Document)>,
    failures: u32,
    unavailable: Option<String>,
    stopping: bool,
    generation: u64,
}

pub struct Server {
    declared: Value,
    root_path: PathBuf,
    store: Arc<Mutex<Store>>,
    live: Mutex<Live>,
}

impl Server {
    fn id(&self) -> &str {
        text(&self.declared, "id")
    }

    fn command(&self) -> Vec<String> {
        self.declared
            .get("command")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default()
    }

    /// Start the process and complete the handshake, or record why it is not here.
    fn start(self: &Arc<Self>) -> bool {
        {
            let live = self.live.lock().expect("server lock");
            if live.child.is_some() || live.stopping {
                return live.child.is_some();
            }
        }
        let argv = self.command();
        let Some((program, rest)) = argv.split_first() else { return false };
        let spawned = Command::new(program)
            .args(rest)
            .current_dir(&self.root_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(error) => {
                /* ENOENT is the ordinary case: the project declares a server this machine does not
                   have. rEngine runs a declared language server but never installs one. */
                let said = if error.kind() == std::io::ErrorKind::NotFound {
                    format!("{}: {program} is not on this machine; rEngine runs a declared language server but never installs one", self.id())
                } else {
                    format!("{}: {program} failed to start ({error})", self.id())
                };
                self.live.lock().expect("server lock").unavailable = Some(said);
                return false;
            }
        };
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let stdin = child.stdin.take().expect("piped stdin");
        let generation = {
            let mut live = self.live.lock().expect("server lock");
            live.generation += 1;
            live.stdin = Some(stdin);
            live.generation
        };
        let said: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        {
            let said = said.clone();
            std::thread::spawn(move || {
                let mut reader = stderr;
                let mut buffer = [0u8; 4096];
                while let Ok(read) = reader.read(&mut buffer) {
                    if read == 0 {
                        return;
                    }
                    let mut kept = said.lock().expect("stderr lock");
                    kept.push_str(&String::from_utf8_lossy(&buffer[..read]));
                    let over = kept.chars().count().saturating_sub(4000);
                    if over > 0 {
                        *kept = kept.chars().skip(over).collect();
                    }
                }
            });
        }
        let reading = self.clone();
        std::thread::spawn(move || reading.read_from(stdout));
        let waiting = self.clone();
        let ended = said.clone();
        std::thread::spawn(move || {
            /* Bound to a variable FIRST, deliberately. `{ lock().child.take() }` looks like it
               releases the lock at the end of the block, and does not: the guard is a temporary of
               the enclosing statement, so it would be held across `wait()` — which is held until
               the server exits, which is forever for a server that is working. Every other call on
               this struct then blocks, and the symptom is an `initialize` that is never even sent. */
            let mut taken = waiting.live.lock().expect("server lock").child.take();
            let status = taken.as_mut().map(|child| child.wait());
            let code = status.and_then(Result::ok).and_then(|status| status.code()).unwrap_or(-1);
            let said = ended.lock().expect("stderr lock").clone();
            waiting.on_exit(generation, code, &said);
        });
        self.live.lock().expect("server lock").child = Some(child);

        let mut params = json!({
            "processId": std::process::id(),
            /* What a server's log calls us (spec 108). */
            "clientInfo": { "name": red_core::PRODUCT_NAME, "version": "1.0.0" },
            "rootUri": uri_for(&self.root_path),
            "workspaceFolders": [{ "uri": uri_for(&self.root_path), "name": self.root_path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default() }],
            "capabilities": { "textDocument": { "publishDiagnostics": { "relatedInformation": false } }, "workspace": { "workspaceFolders": true } },
        });
        if let Some(options) = self.declared.get("initializationOptions") {
            params.as_object_mut().expect("an object").insert("initializationOptions".into(), options.clone());
        }
        if self.request("initialize", &params, INITIALIZE_TIMEOUT_MS).is_none() {
            self.live.lock().expect("server lock").unavailable =
                Some(format!("{}: did not answer initialize within {INITIALIZE_TIMEOUT_MS} ms", self.id()));
            return false;
        }
        self.notify("initialized", &json!({}));
        {
            let mut live = self.live.lock().expect("server lock");
            live.unavailable = None;
            live.failures = 0;
        }
        /* Documents survive a restart, so a server that crashed comes back knowing what is open. */
        let open: Vec<(String, String)> = {
            let live = self.live.lock().expect("server lock");
            live.documents.iter().map(|(uri, document)| (uri.clone(), document.text.clone())).collect()
        };
        for (uri, text) in open {
            self.open(&uri, &text, true);
        }
        true
    }

    fn read_from(self: Arc<Self>, stdout: std::process::ChildStdout) {
        let mut framer = Framer::default();
        let mut reader = stdout;
        let mut buffer = [0u8; 8192];
        loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) | Err(_) => return,
                Ok(read) => read,
            };
            for message in framer.feed(&buffer[..read]) {
                self.receive(&message);
            }
        }
    }

    fn receive(&self, message: &Value) {
        if message.get("method").and_then(Value::as_str) == Some("textDocument/publishDiagnostics") {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            if let Some(uri) = params.get("uri").and_then(Value::as_str) {
                let items = params.get("diagnostics").and_then(Value::as_array).cloned().unwrap_or_default();
                self.store.lock().expect("store lock").record(uri, self.id(), items);
            }
            return;
        }
        if let Some(id) = message.get("id").and_then(Value::as_i64) {
            let waiting = self.live.lock().expect("server lock").pending.remove(&id);
            if let Some(sender) = waiting {
                let _ = sender.send(message.clone());
                return;
            }
            /* A server request we do not implement still needs an answer, or it waits forever. */
            if message.get("method").is_some() {
                self.send(&json!({ "jsonrpc": "2.0", "id": id, "result": Value::Null }));
            }
        }
    }

    fn on_exit(self: &Arc<Self>, generation: u64, code: i32, said: &str) {
        {
            let mut live = self.live.lock().expect("server lock");
            if live.generation != generation {
                return;
            }
            live.child = None;
            live.stdin = None;
            for (_, sender) in live.pending.drain() {
                drop(sender);
            }
            if live.stopping {
                return;
            }
            live.failures += 1;
        }
        /* Its diagnostics go with it: keeping them would mean reporting a file as broken on the word
           of a process that is no longer running and may have been wrong when it died. */
        let open: Vec<String> = { self.live.lock().expect("server lock").documents.iter().map(|(uri, _)| uri.clone()).collect() };
        {
            let mut store = self.store.lock().expect("store lock");
            for uri in &open {
                store.record(uri, self.id(), Vec::new());
            }
        }
        let failures = self.live.lock().expect("server lock").failures;
        if failures > RESTART_GIVE_UP {
            self.live.lock().expect("server lock").unavailable = Some(format!(
                "{}: exited {failures} times (last code {code}); not restarted again. {}",
                self.id(),
                said.trim().chars().rev().take(200).collect::<Vec<_>>().into_iter().rev().collect::<String>()
            ));
            return;
        }
        let wait = (RESTART_BASE_MS * 2u64.pow(failures - 1)).min(RESTART_CEILING_MS);
        self.live.lock().expect("server lock").unavailable = Some(format!("{}: exited (code {code}); restarting in {wait} ms", self.id()));
        let restarting = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(wait));
            if !restarting.live.lock().expect("server lock").stopping {
                restarting.start();
            }
        });
    }

    fn send(&self, message: &Value) {
        let mut live = self.live.lock().expect("server lock");
        if let Some(stdin) = live.stdin.as_mut() {
            let _ = stdin.write_all(&frame(message)).and_then(|()| stdin.flush());
        }
    }

    fn notify(&self, method: &str, params: &Value) {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    /// One request. A timeout answers `None` rather than failing: a server that never replies to
    /// `initialize` is unavailable, not a crash of the workspace.
    fn request(&self, method: &str, params: &Value, timeout: u64) -> Option<Value> {
        let (sender, receiver) = mpsc::channel();
        let id = {
            let mut live = self.live.lock().expect("server lock");
            live.next += 1;
            let id = live.next;
            live.pending.insert(id, sender);
            id
        };
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        match receiver.recv_timeout(Duration::from_millis(timeout)) {
            Ok(answer) => {
                if answer.get("error").is_some() {
                    None
                } else {
                    Some(answer.get("result").cloned().unwrap_or(Value::Null))
                }
            }
            Err(_) => {
                self.live.lock().expect("server lock").pending.remove(&id);
                None
            }
        }
    }

    fn open(&self, uri: &str, body: &str, reopening: bool) {
        let (version, first) = {
            let mut live = self.live.lock().expect("server lock");
            let existing = live.documents.iter().position(|(seen, _)| seen == uri);
            let version = match (existing, reopening) {
                (Some(index), true) => live.documents[index].1.version,
                (Some(index), false) => live.documents[index].1.version + 1,
                (None, _) => 1,
            };
            match existing {
                Some(index) => live.documents[index].1 = Document { version, text: body.to_string() },
                None => live.documents.push((uri.to_string(), Document { version, text: body.to_string() })),
            }
            (version, existing.is_none() || reopening)
        };
        let language = self.declared.get("languageId").and_then(Value::as_str).unwrap_or_else(|| self.id());
        if first {
            self.notify(
                "textDocument/didOpen",
                &json!({ "textDocument": { "uri": uri, "languageId": language, "version": version, "text": body } }),
            );
        } else {
            self.notify(
                "textDocument/didChange",
                &json!({ "textDocument": { "uri": uri, "version": version }, "contentChanges": [{ "text": body }] }),
            );
        }
    }

    fn close(&self, uri: &str) {
        let known = {
            let mut live = self.live.lock().expect("server lock");
            let before = live.documents.len();
            live.documents.retain(|(seen, _)| seen != uri);
            before != live.documents.len()
        };
        if known {
            self.notify("textDocument/didClose", &json!({ "textDocument": { "uri": uri } }));
        }
    }

    fn stop(self: &Arc<Self>) {
        {
            let mut live = self.live.lock().expect("server lock");
            live.stopping = true;
            if live.child.is_none() {
                return;
            }
        }
        let _ = self.request("shutdown", &Value::Null, 2000);
        self.notify("exit", &Value::Null);
        for _ in 0..40 {
            if self.live.lock().expect("server lock").child.is_none() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if let Some(child) = self.live.lock().expect("server lock").child.as_mut() {
            let _ = child.kill();
        }
    }

    fn unavailable(&self) -> Option<String> {
        self.live.lock().expect("server lock").unavailable.clone()
    }
}

/// `pathToFileURL(file).href`.
pub fn uri_for(file: &Path) -> String {
    let mut out = String::from("file://");
    for byte in file.to_string_lossy().bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' | b'@' | b'+' | b'$' | b',' | b'!' | b'*' | b'(' | b')' | b'\'' | b';' | b'=' | b'&' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

pub struct Servers {
    root_path: PathBuf,
    servers: Vec<Arc<Server>>,
    store: Arc<Mutex<Store>>,
}

impl Servers {
    pub fn new(root_path: &str, declared: &Value) -> Servers {
        let store: Arc<Mutex<Store>> = Arc::new(Mutex::new(Store::default()));
        let servers = declared
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|entry| {
                        Arc::new(Server {
                            declared: entry.clone(),
                            root_path: PathBuf::from(root_path),
                            store: store.clone(),
                            live: Mutex::new(Live::default()),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Servers { root_path: PathBuf::from(root_path), servers, store }
    }

    fn serving(&self, file: &Path) -> Vec<Arc<Server>> {
        let relative = file.strip_prefix(&self.root_path).unwrap_or(file).to_string_lossy().into_owned();
        self.servers
            .iter()
            .filter(|server| {
                server
                    .declared
                    .get("match")
                    .and_then(Value::as_array)
                    .map(|patterns| patterns.iter().filter_map(Value::as_str).any(|pattern| matches(pattern, &relative)))
                    .unwrap_or(false)
            })
            .cloned()
            .collect()
    }

    /// Ask about a file: the servers that serve it are started and told the text, and whatever they
    /// have said so far is returned. A caller never waits for a server to have an opinion.
    pub fn open(&self, file: &Path, body: &str) -> Value {
        let uri = uri_for(file);
        let serving = self.serving(file);
        for server in &serving {
            if server.start() {
                server.open(&uri, body, false);
            }
        }
        json!({ "uri": uri, "servers": serving.iter().map(|server| server.id()).collect::<Vec<_>>() })
    }

    pub fn close(&self, file: &Path) {
        let uri = uri_for(file);
        for server in self.serving(file) {
            server.close(&uri);
        }
        self.store.lock().expect("store lock").published.remove(&uri);
    }

    pub fn items(&self, uri: &str) -> Vec<Value> {
        self.store.lock().expect("store lock").items(uri)
    }

    pub fn version(&self) -> u64 {
        self.store.lock().expect("store lock").version
    }

    pub fn unavailable(&self) -> Vec<String> {
        self.servers.iter().filter_map(|server| server.unavailable()).collect()
    }

    pub fn stop(&self) {
        for server in &self.servers {
            server.stop();
        }
    }
}
