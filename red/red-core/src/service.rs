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
pub struct Client {
    stream: TcpStream,
    reader: BufReader<TcpStream>,
    sequence: u64,
    /// The last unsolicited `state` this service pushed, if it pushes one.
    pub state: Option<Value>,
    pub instance: String,
}

impl Client {
    /// Attach to the service `name` serves in `directory`, or `Ok(None)` when there is none.
    pub fn attach(directory: &Path, name: &str, protocol: u64) -> Result<Option<Client>, String> {
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
        let reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
        let mut client = Client { stream, reader, sequence: 0, state: None, instance: String::new() };
        let hello = client.call("attach", json!([{ "token": token, "protocol": protocol }]))?;
        client.instance = hello.get("instance").and_then(Value::as_str).unwrap_or_default().to_string();
        if let Some(state) = hello.get("state") {
            client.state = Some(state.clone());
        }
        Ok(Some(client))
    }

    /// One request, one answer — and every unsolicited line before it is taken as the service's
    /// current state, which is how an attached client stays in step with the other hosts.
    pub fn call(&mut self, method: &str, args: Value) -> Result<Value, String> {
        self.sequence += 1;
        let id = self.sequence;
        let line = format!("{}\n", json!({ "id": id, "method": method, "args": args }));
        self.stream.write_all(line.as_bytes()).map_err(|error| format!("cannot ask {method}: {error}"))?;
        self.stream.flush().ok();
        loop {
            let mut answer = String::new();
            let read = self.reader.read_line(&mut answer).map_err(|error| format!("no answer to {method}: {error}"))?;
            if read == 0 {
                return Err(format!("the service closed while answering {method}"));
            }
            let value: Value = match serde_json::from_str(&answer) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if let Some(state) = value.get("state") {
                self.state = Some(state.clone());
            }
            match value.get("id").and_then(Value::as_u64) {
                Some(answered) if answered == id => {
                    if let Some(error) = value.get("error") {
                        let message = error.get("message").and_then(Value::as_str).unwrap_or("the service refused").to_string();
                        let status = error.get("status").and_then(Value::as_u64).unwrap_or(500) as u16;
                        return Err(format!("{status}|{message}"));
                    }
                    return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                }
                /* An unsolicited line — a state push, or an event a PTY service emits — is not an
                   answer to this request, and waiting for the right id is what keeps them apart. */
                _ => continue,
            }
        }
    }
}
