//! A service that belongs to a state directory, not to whichever host is running (charter D60 for
//! PTYs, D61 for the store).
//!
//! Both of those services want the same thing and had no business inventing it twice: bind
//! loopback, publish a descriptor the way `sidecar.json` is published, take one `attach` handshake
//! carrying a token and a protocol number, then speak newline-delimited JSON-RPC to every attached
//! client — and, when it holds nothing and nobody is listening, remove its own descriptor and go
//! away. What differs between them is the dispatch and whether the service is *holding* something,
//! which is what [`Served`] leaves to its caller.
//!
//! The transport is blocking `std::net` on threads, deliberately: this module is used by crates
//! that have no async runtime and should not gain one for a loopback socket that carries a few
//! requests a second.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// What a service does with a request, and whether it may be reaped.
pub trait Served: Send + Sync + 'static {
    /// One request, one answer object — `{id, result}` or `{id, error}`. The envelope is the
    /// caller's, because the two services already answer in shapes their clients know.
    fn answer(&self, request: &Value) -> Value;

    /// True while the service holds something that must outlive an idle moment — a running PTY,
    /// say. A service that holds nothing and has no clients reaps itself.
    fn holding(&self) -> bool {
        false
    }

    /// What an `attach` answer carries beyond the protocol handshake: the sessions a PTY service
    /// is holding, the state a store service opens with.
    fn greeting(&self) -> Value {
        json!({})
    }
}

/// One attached client, from the server's side: the socket its answers and events go out on.
struct Attached {
    out: Arc<Mutex<TcpStream>>,
}

pub struct Service<S: Served> {
    inner: Arc<S>,
    clients: Arc<Mutex<Vec<Attached>>>,
    idle_since: Mutex<Instant>,
    token: String,
    instance: String,
    protocol: u64,
    name: &'static str,
    descriptor: PathBuf,
    /// The directory this service belongs to. When it goes, so does the service.
    directory: PathBuf,
}

/// Everything a caller needs to talk about the service it just started.
pub struct Published {
    pub url: String,
    pub token: String,
    pub instance: String,
}

fn send(out: &Arc<Mutex<TcpStream>>, line: &str) -> bool {
    let mut stream = out.lock().expect("client lock");
    stream.write_all(line.as_bytes()).and_then(|_| stream.flush()).is_ok()
}

/// 64 hex characters, the shape `discoverSidecar` already validates for the session host.
pub fn secret() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the operating system answers randomness");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the operating system answers randomness");
    bytes[6] = bytes[6] & 0x0f | 0x40;
    bytes[8] = bytes[8] & 0x3f | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

/// No early exit on the first differing byte: the comparison takes the same time either way.
pub fn same_secret(left: &str, right: &str) -> bool {
    left.len() == right.len() && left.bytes().zip(right.bytes()).fold(0u8, |seen, (a, b)| seen | (a ^ b)) == 0
}

/// tmp + rename, 0600 — a reader never sees half a descriptor, and nobody else can read the token
/// out of it.
fn write_descriptor(path: &Path, document: &Value) -> std::io::Result<()> {
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&temporary, format!("{document}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&temporary, path)
}

/// A service already serving this directory answers its own port. Asking the port rather than the
/// PID is the portable question and the more honest one: it tests the service, not a number.
pub fn already_serving(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    let document: Value = serde_json::from_str(&text).ok()?;
    let url = document.get("url").and_then(Value::as_str)?;
    let address = url.strip_prefix("tcp://")?;
    let target: std::net::SocketAddr = address.parse().ok()?;
    TcpStream::connect_timeout(&target, Duration::from_millis(500)).ok()?;
    Some(document)
}

/// The binary that serves one of these: `$VARIABLE`, then this checkout's debug or release build.
///
/// A missing binary is NAMED rather than worked around, and the sentence says how to make one —
/// this is the failure a person meets when they run a workspace out of a fresh clone, and the
/// difference between a two-word fix and an afternoon.
pub fn serve_binary(variable: &str, basename: &str) -> Result<std::path::PathBuf, String> {
    if let Some(declared) = std::env::var(variable).ok().filter(|value| !value.is_empty()) {
        let path = std::path::PathBuf::from(&declared);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!("{variable} names {declared}, which does not exist."));
    }
    let checkout = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.ancestors().nth(4).map(Path::to_path_buf))
        .ok_or_else(|| format!("cannot find {basename}: this binary is nowhere it recognises."))?;
    for profile in ["debug", "release"] {
        let candidate = checkout.join("red/target").join(profile).join(basename);
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "The {basename} binary is required (run: cargo build --manifest-path red/Cargo.toml --bins, or set {variable})."
    ))
}

/// Start the service serving `directory` if none is, and say nothing if one already is.
///
/// **One service per directory**, so the start is taken under a lock: two processes attaching at
/// once must not each spawn one, and a lock whose owner died must not block the survivor forever.
/// The discipline is `service-client.mjs`'s, which is the only thing that has ever started one of
/// these — and a Rust process that started them differently would be a second convention for the
/// same file.
///
/// Detached, with its own log beside the descriptor, because the service outlives whoever started
/// it: that is the whole of D60/D61.
pub fn start_service(
    directory: &Path,
    name: &str,
    protocol: u64,
    binary: &Path,
    args: &[String],
) -> Result<(), String> {
    std::fs::create_dir_all(directory).map_err(|error| format!("{} cannot be created: {error}", directory.display()))?;
    let descriptor = directory.join(format!("{name}.json"));
    if serving_this_protocol(&descriptor, protocol) {
        return Ok(());
    }
    let lock = directory.join(format!("{name}-startup.lock"));
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&lock) {
            Ok(mut held) => {
                use std::io::Write;
                let _ = write!(held, "{{\"pid\":{}}}", std::process::id());
                let outcome = under_lock(directory, name, protocol, binary, args, &descriptor);
                let _ = std::fs::remove_file(&lock);
                return outcome;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                /* Somebody else is starting one. If it arrived, that is the answer; if the holder is
                   gone, the lock is theirs no longer. */
                if serving_this_protocol(&descriptor, protocol) {
                    return Ok(());
                }
                let owner = std::fs::read_to_string(&lock)
                    .ok()
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                    .and_then(|held| held.get("pid").and_then(Value::as_i64));
                match owner {
                    Some(pid) if pid_is_live(pid) => {}
                    /* A lock with no readable owner is a lock nobody is holding. */
                    _ => {
                        let _ = std::fs::remove_file(&lock);
                        continue;
                    }
                }
                if std::time::Instant::now() > deadline {
                    return Err(format!(
                        "{} is held by a live process; no second {name} service was started.",
                        lock.display()
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => return Err(format!("{} cannot be taken: {error}", lock.display())),
        }
    }
}

fn under_lock(
    directory: &Path,
    name: &str,
    protocol: u64,
    binary: &Path,
    args: &[String],
    descriptor: &Path,
) -> Result<(), String> {
    /* Checked again with the lock held: whoever we waited behind may have started it. */
    if serving_this_protocol(descriptor, protocol) {
        return Ok(());
    }
    let log_path = directory.join(format!("{name}-serve.log"));
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("{} cannot be opened: {error}", log_path.display()))?;
    let mut command = std::process::Command::new(binary);
    command.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(log);
    /* Its own session, so it is not in this process's group and does not die with it. */
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                libc_setsid();
                Ok(())
            });
        }
    }
    command.spawn().map_err(|error| format!("cannot start {}: {error}", binary.display()))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while std::time::Instant::now() < deadline {
        if serving_this_protocol(descriptor, protocol) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(format!(
        "{} did not write {} within 15s; see {}.",
        binary.display(),
        descriptor.display(),
        log_path.display()
    ))
}

/// A descriptor that names a service this build can speak to, and that answers.
fn serving_this_protocol(descriptor: &Path, protocol: u64) -> bool {
    already_serving(descriptor)
        .and_then(|document| document.get("protocol").and_then(Value::as_u64))
        .is_some_and(|named| named == protocol)
}

/// `process.kill(pid, 0)` — is anything still there? EPERM is something, owned by somebody else.
/// Is this process still there? One implementation, in `descriptor` — every layer of this workspace
/// asks it about a pid out of a descriptor, and two answers to that question is how a second host
/// gets started beside a live one.
fn pid_is_live(pid: i64) -> bool {
    crate::descriptor::alive(pid)
}

#[cfg(unix)]
extern "C" {
    fn setsid() -> i32;
}

#[cfg(unix)]
fn libc_setsid() {
    unsafe {
        setsid();
    }
}

/// Start the service and serve until it reaps itself. `name` is the descriptor's basename and the
/// word this service calls itself in a refusal; `idle` is how long it waits, holding nothing and
/// unattached, before removing its descriptor and exiting.
pub fn serve<S: Served>(
    directory: &Path,
    name: &'static str,
    protocol: u64,
    idle: Duration,
    inner: S,
    emitter: impl FnOnce(Emitter),
) -> Result<(), String> {
    std::fs::create_dir_all(directory).map_err(|error| format!("{} cannot be created: {error}", directory.display()))?;
    let descriptor = directory.join(format!("{name}.json"));
    if let Some(existing) = already_serving(&descriptor) {
        return Err(format!(
            "{} is already served by PID {} at {}. Nothing was started.",
            directory.display(),
            existing.get("pid").and_then(Value::as_u64).unwrap_or(0),
            existing.get("url").and_then(Value::as_str).unwrap_or("?")
        ));
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| format!("loopback is unavailable: {error}"))?;
    let port = listener.local_addr().expect("the bound address").port();
    let clients: Arc<Mutex<Vec<Attached>>> = Arc::new(Mutex::new(Vec::new()));
    let service = Arc::new(Service {
        inner: Arc::new(inner),
        clients: clients.clone(),
        idle_since: Mutex::new(Instant::now()),
        token: secret(),
        instance: uuid_v4(),
        protocol,
        name,
        descriptor: descriptor.clone(),
        directory: directory.to_path_buf(),
    });
    emitter(Emitter { clients });
    let document = json!({
        "url": format!("tcp://127.0.0.1:{port}"),
        "token": service.token,
        "instance": service.instance,
        "pid": std::process::id(),
        "protocol": protocol,
    });
    write_descriptor(&descriptor, &document).map_err(|error| format!("{} cannot be written: {error}", descriptor.display()))?;
    println!("{}", json!({ "role": name, "url": format!("tcp://127.0.0.1:{port}"), "instance": service.instance, "pid": std::process::id() }));
    let _ = std::io::stdout().flush();

    reap_when_idle(service.clone(), idle);
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let service = service.clone();
        std::thread::spawn(move || connection(service, stream));
    }
    Ok(())
}

/// The handle a service uses to push unsolicited lines at whoever is attached. A service that
/// never pushes takes one and drops it.
pub struct Emitter {
    clients: Arc<Mutex<Vec<Attached>>>,
}

impl Emitter {
    pub fn say(&self, event: &Value) {
        let line = format!("{event}\n");
        self.clients.lock().expect("clients lock").retain(|client| send(&client.out, &line));
    }
}

impl Clone for Emitter {
    fn clone(&self) -> Self {
        Emitter { clients: self.clients.clone() }
    }
}

/// A service that holds nothing and that nobody is attached to removes its own descriptor and goes
/// away. One that is holding something never does, however long it waits — that is what "the
/// service belongs to the directory" means.
fn reap_when_idle<S: Served>(service: Arc<Service<S>>, idle: Duration) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(250));
        /* A service serves a DIRECTORY. When the directory is gone there is nothing left to serve,
           and holding a shell for it is holding a shell for nobody — which is exactly what a suite
           that deletes its scratch directories leaves behind, one process at a time. This is the
           only reason a service stops while it is still holding something: the thing it was holding
           belongs to a workspace that no longer exists. `ENOENT` specifically, because a directory
           that cannot be READ is not a directory that is gone. */
        if matches!(std::fs::metadata(&service.directory), Err(error) if error.kind() == std::io::ErrorKind::NotFound) {
            std::process::exit(0);
        }
        let attached = !service.clients.lock().expect("clients lock").is_empty();
        if attached || service.inner.holding() {
            continue;
        }
        if service.idle_since.lock().expect("idle lock").elapsed() < idle {
            continue;
        }
        forget_descriptor(&service);
        std::process::exit(0);
    });
}

/// Only ours. A successor's descriptor is not this process's to delete.
fn forget_descriptor<S: Served>(service: &Service<S>) {
    let ours = std::fs::read_to_string(&service.descriptor)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|document| document.get("instance").and_then(Value::as_str).map(str::to_string))
        .is_some_and(|instance| instance == service.instance);
    if ours {
        let _ = std::fs::remove_file(&service.descriptor);
    }
}

fn connection<S: Served>(service: Arc<Service<S>>, stream: TcpStream) {
    let Ok(reading) = stream.try_clone() else { return };
    let out = Arc::new(Mutex::new(stream));
    let mut attached = false;
    for line in BufReader::new(reading).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                send(&out, &format!("{}\n", json!({ "id": Value::Null, "error": { "message": format!("not JSON: {error}"), "status": null } })));
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        if method == "attach" {
            match attach(&service, &request) {
                Ok(result) => {
                    if !attached {
                        attached = true;
                        service.clients.lock().expect("clients lock").push(Attached { out: out.clone() });
                    }
                    send(&out, &format!("{}\n", json!({ "id": id, "result": result })));
                }
                Err((status, message)) => {
                    /* A wrong token is 401 and a wrong protocol is 409: one says "not you", the
                       other says "not this version of you", and a client acts on them differently
                       — the version mismatch is what makes it end this service and start its own. */
                    send(&out, &format!("{}\n", json!({ "id": id, "error": { "message": message, "status": status } })));
                    break;
                }
            }
            continue;
        }
        if !attached {
            let message = format!("{}: attach with this service's token before anything else.", service.name);
            send(&out, &format!("{}\n", json!({ "id": id, "error": { "message": message, "status": 401 } })));
            continue;
        }
        let answer = service.inner.answer(&request);
        if !send(&out, &format!("{answer}\n")) {
            break;
        }
    }
    if attached {
        let mut clients = service.clients.lock().expect("clients lock");
        clients.retain(|client| !Arc::ptr_eq(&client.out, &out));
        if clients.is_empty() {
            *service.idle_since.lock().expect("idle lock") = Instant::now();
        }
    }
}

/// The token gates everything; the protocol number is checked too, so a client that would misread
/// this service is told rather than served.
fn attach<S: Served>(service: &Service<S>, request: &Value) -> Result<Value, (u16, String)> {
    let options = request
        .get("args")
        .and_then(Value::as_array)
        .and_then(|args| args.first())
        .cloned()
        .unwrap_or(Value::Null);
    let token = options.get("token").and_then(Value::as_str).unwrap_or("");
    if !same_secret(token, &service.token) {
        return Err((401, format!("{}: the attach token does not match this service.", service.name)));
    }
    let asked = options.get("protocol").and_then(Value::as_u64).unwrap_or(service.protocol);
    if asked != service.protocol {
        return Err((
            409,
            format!("{}: this service speaks protocol {}; the client asked for {asked}.", service.name, service.protocol),
        ));
    }
    let mut greeting = service.inner.greeting();
    if let Some(map) = greeting.as_object_mut() {
        map.insert("started".into(), json!(true));
        map.insert("instance".into(), json!(service.instance));
        map.insert("protocol".into(), json!(service.protocol));
        map.insert("pid".into(), json!(std::process::id()));
    }
    Ok(greeting)
}

#[cfg(test)]
mod starting {
    use super::*;

    /// A stand-in service: a script that writes the descriptor its client is waiting for.
    fn stand_in(directory: &Path, listening: u16) -> std::path::PathBuf {
        let script = directory.join("stand-in.sh");
        std::fs::write(
            &script,
            format!(
                "#!/bin/bash\necho started >> \"$2/runs.txt\"\nprintf '%s' '{{\"url\":\"tcp://127.0.0.1:{listening}\",\"token\":\"{}\",\"pid\":'$$',\"protocol\":1,\"instance\":\"x\"}}' > \"$2/token.json\"\nsleep 30\n",
                "a".repeat(64)
            ),
        )
        .expect("a script");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("executable");
        }
        script
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let at = std::env::temp_dir().join(format!("red-core-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&at);
        std::fs::create_dir_all(&at).expect("a directory");
        at
    }

    /// Something to connect to, since `already_serving` asks whether the address ANSWERS.
    fn listening() -> (std::net::TcpListener, u16) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a port");
        let port = listener.local_addr().expect("an address").port();
        (listener, port)
    }

    #[test]
    fn a_service_is_started_once_and_then_found() {
        let at = scratch("started");
        let (_held, port) = listening();
        let script = stand_in(&at, port);
        let args = vec!["--state".to_string(), at.to_string_lossy().to_string()];
        start_service(&at, "token", 1, &script, &args).expect("started");
        assert!(at.join("token.json").exists(), "the descriptor a client reads");
        /* The second call FINDS it rather than starting another. Counted by what actually ran,
           because the service refuses to be a second one itself — so a client that spawned one
           anyway would leave the descriptor looking right and a doomed process in the log. The
           assertion has to be about the process, or the service's own refusal masks it. */
        start_service(&at, "token", 1, &script, &args).expect("found");
        std::thread::sleep(Duration::from_millis(300));
        let runs = std::fs::read_to_string(at.join("runs.txt")).unwrap_or_default();
        assert_eq!(runs.lines().count(), 1, "one service per directory: {runs:?}");
        let _ = std::fs::remove_dir_all(&at);
    }

    /* A lock whose owner died must not block the survivor forever — a workspace that would not open
       because a process crashed mid-start is a workspace nobody can recover without a manual
       delete, and the person has no reason to know which file. */
    #[test]
    fn a_lock_whose_owner_is_gone_is_taken_by_whoever_is_still_here() {
        let at = scratch("stale");
        let (_held, port) = listening();
        let script = stand_in(&at, port);
        /* PID 2^31-1 is not a process on any machine this runs on. */
        std::fs::write(at.join("token-startup.lock"), "{\"pid\":2147483647}").expect("a lock");
        start_service(&at, "token", 1, &script, &vec!["--state".to_string(), at.to_string_lossy().to_string()])
            .expect("the stale lock was reclaimed");
        assert!(at.join("token.json").exists());
        assert!(!at.join("token-startup.lock").exists(), "and released again");
        let _ = std::fs::remove_dir_all(&at);
    }

    /* A lock held by something that IS alive is somebody else starting one, and a caller that waited
       forever would be a workspace that hangs. It is named instead, with nothing started. */
    #[test]
    fn a_lock_held_by_a_live_process_is_refused_by_name() {
        let at = scratch("live");
        let script = stand_in(&at, 1);
        std::fs::write(at.join("token-startup.lock"), format!("{{\"pid\":{}}}", std::process::id())).expect("a lock");
        let refused = start_service(&at, "token", 1, &script, &[]).expect_err("refused");
        assert!(refused.contains("held by a live process"), "{refused}");
        assert!(refused.contains("no second token service was started"), "{refused}");
        assert!(!at.join("token.json").exists(), "and nothing was");
        let _ = std::fs::remove_dir_all(&at);
    }

    #[test]
    fn a_binary_nobody_has_is_named_with_the_command_that_makes_one() {
        let refused = serve_binary("RENGINE_A_VARIABLE_NOBODY_SET", "red-nothing-serve").expect_err("refused");
        assert!(refused.contains("red-nothing-serve"), "{refused}");
        assert!(refused.contains("cargo build"), "it says how to make one: {refused}");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_secret_is_sixty_four_hex_characters() {
        let secret = super::secret();
        assert_eq!(secret.len(), 64);
        assert!(secret.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn secrets_are_compared_whole() {
        let secret = super::secret();
        assert!(super::same_secret(&secret, &secret.clone()));
        assert!(!super::same_secret(&secret, &secret[..63].to_string()), "a prefix is not a match");
    }
}

/* ---- the other side of the same door ---------------------------------------------------------- */

/// A client of a per-state-directory service: find it by its descriptor, attach with its token,
/// then speak the same newline-delimited JSON-RPC the JS clients speak.
///
/// The JS side of this (`pty-client.mjs`, `store-client.mjs`) also starts a service when there is
/// none. This one deliberately does not: the processes that run these services are started by the
/// host that owns the directory, and a front door that raced to start one would be the second
/// owner the whole arrangement exists to prevent. A caller that finds nothing is told so and can
/// decide — forwarding, in red-host's case.
///
/// One thread owns the reading, because the other lines on this socket are not answers: a store
/// pushes its new state after every change and a PTY service pushes output and pane records as they
/// happen (charter D62). A client that only read while waiting for an answer would learn what it
/// holds when it next asked something — which, for a door deciding whether a pane accepts input, is
/// exactly one request too late.
pub struct Client {
    writing: Mutex<TcpStream>,
    pending: Arc<Mutex<std::collections::HashMap<u64, std::sync::mpsc::Sender<Value>>>>,
    sequence: std::sync::atomic::AtomicU64,
    /// The last unsolicited `state` this service pushed, if it pushes one.
    state: Arc<Mutex<Option<Value>>>,
    /// What the `attach` answer carried: a PTY service's sessions, a store's opening state.
    pub greeting: Value,
    pub instance: String,
}

impl Client {
    /// Attach to the service `name` serves in `directory`, or `Ok(None)` when there is none.
    pub fn attach(directory: &Path, name: &str, protocol: u64) -> Result<Option<Client>, String> {
        Client::attaching(directory, name, protocol, Box::new(|_| {}))
    }

    /// The same, with a handler for every line that is not an answer to a request.
    pub fn attaching(
        directory: &Path,
        name: &str,
        protocol: u64,
        on_event: Box<dyn Fn(&Value) + Send + 'static>,
    ) -> Result<Option<Client>, String> {
        let descriptor = directory.join(format!("{name}.json"));
        let Some(document) = already_serving(&descriptor) else { return Ok(None) };
        let token = document.get("token").and_then(Value::as_str).unwrap_or_default().to_string();
        let named = document.get("protocol").and_then(Value::as_u64).unwrap_or(protocol);
        if named != protocol {
            return Err(format!(
                "{} speaks protocol {named}; this build speaks {protocol}.",
                descriptor.display()
            ));
        }
        let url = document.get("url").and_then(Value::as_str).unwrap_or_default();
        let address: std::net::SocketAddr = url
            .strip_prefix("tcp://")
            .and_then(|rest| rest.parse().ok())
            .ok_or_else(|| format!("{} does not name a loopback address", descriptor.display()))?;
        let stream = TcpStream::connect_timeout(&address, Duration::from_secs(5))
            .map_err(|error| format!("cannot reach {url}: {error}"))?;
        let reading = stream.try_clone().map_err(|error| error.to_string())?;
        let pending: Arc<Mutex<std::collections::HashMap<u64, std::sync::mpsc::Sender<Value>>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        let state: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
        read_answers(reading, pending.clone(), state.clone(), on_event);
        let client = Client {
            writing: Mutex::new(stream),
            pending,
            sequence: std::sync::atomic::AtomicU64::new(0),
            state,
            greeting: Value::Null,
            instance: String::new(),
        };
        let hello = client.call("attach", json!([{ "token": token, "protocol": protocol }]))?;
        let instance = hello.get("instance").and_then(Value::as_str).unwrap_or_default().to_string();
        if let Some(opening) = hello.get("state") {
            *client.state.lock().expect("state lock") = Some(opening.clone());
        }
        Ok(Some(Client { greeting: hello, instance, ..client }))
    }

    /// The service's current state, as of the last line it pushed.
    pub fn state(&self) -> Option<Value> {
        self.state.lock().expect("state lock").clone()
    }

    /// One request, one answer. Errors carry the service's own status as `"<status>|<message>"`,
    /// because a refusal a client acts on — 404 for an unknown root, 409 for a stale save — is not
    /// the same thing as a service that broke.
    pub fn call(&self, method: &str, args: Value) -> Result<Value, String> {
        let id = self.sequence.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let (sender, receiver) = std::sync::mpsc::channel();
        self.pending.lock().expect("pending lock").insert(id, sender);
        let line = format!("{}\n", json!({ "id": id, "method": method, "args": args }));
        let written = {
            let mut writing = self.writing.lock().expect("writing lock");
            writing.write_all(line.as_bytes()).and_then(|()| writing.flush())
        };
        if let Err(error) = written {
            self.pending.lock().expect("pending lock").remove(&id);
            return Err(format!("cannot ask {method}: {error}"));
        }
        /* A bound rather than forever: a service that has stopped answering must not take the door
           down with it. The reader drops every pending sender when the socket ends, so the ordinary
           failure arrives at once and this timeout is for the extraordinary one. */
        let answer = match receiver.recv_timeout(Duration::from_secs(30)) {
            Ok(answer) => answer,
            Err(_) => {
                self.pending.lock().expect("pending lock").remove(&id);
                return Err(format!("no answer to {method}"));
            }
        };
        if let Some(error) = answer.get("error") {
            let message = error.get("message").and_then(Value::as_str).unwrap_or("the service refused").to_string();
            let status = error.get("status").and_then(Value::as_u64).unwrap_or(500) as u16;
            return Err(format!("{status}|{message}"));
        }
        Ok(answer.get("result").cloned().unwrap_or(Value::Null))
    }
}

/// The reading thread: an answer goes to whoever is waiting for its id, and everything else is an
/// event. A line carrying `state` updates what this client knows either way, because the store
/// pushes its state both in an answer's wake and on its own.
fn read_answers(
    stream: TcpStream,
    pending: Arc<Mutex<std::collections::HashMap<u64, std::sync::mpsc::Sender<Value>>>>,
    state: Arc<Mutex<Option<Value>>>,
    on_event: Box<dyn Fn(&Value) + Send + 'static>,
) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
            if let Some(pushed) = value.get("state") {
                *state.lock().expect("state lock") = Some(pushed.clone());
            }
            match value.get("id").and_then(Value::as_u64) {
                Some(id) => {
                    let waiting = pending.lock().expect("pending lock").remove(&id);
                    if let Some(sender) = waiting {
                        let _ = sender.send(value);
                    }
                }
                None => on_event(&value),
            }
        }
        /* The socket ended: every caller still waiting is told now rather than at its timeout. */
        pending.lock().expect("pending lock").clear();
    });
}
