//! The two descriptors a local workspace publishes, and the one way they are read (F159, spec 144).
//!
//! `sidecar.json` names the **session host** — the process that holds the PTYs and the store.
//! `runtime.json` names the **supervisor** in front of it. They are the same kind of fact: a
//! loopback URL, a 64-hex token, an instance uuid, and the pid that serves them. Both are read the
//! same way and for the same purpose, which is never "is there a file?" but:
//!
//! > Is somebody serving this directory, and is it the one I think it is?
//!
//! The three answers are **yes** (a connection), **no** (nobody is; start one), and **something is
//! there and I could not reach it** — and the third is an error rather than a `None` on purpose. A
//! live pid that will not answer must never become "start another one": two session hosts on one
//! state directory is two writers of the same store, and two supervisors is two owners of the same
//! desktops. Every refusal below says *no second one was started*, because that is the fact the
//! person reading it needs.
//!
//! `runtime/protocol.mjs`, `launcher/sidecar.mjs` and `runtime/discovery.mjs` are what this
//! replaces, and `red-mcp` had a fourth partial copy of the runtime half.

use std::path::Path;

use serde_json::Value;

/// A local workspace one can reach: where it is, what it answers to, and which one it is.
#[derive(Debug, Clone, PartialEq)]
pub struct Connection {
    pub url: String,
    pub token: String,
    pub instance: String,
    /// The process serving it, when the descriptor named one. Absent is not "dead": the session
    /// host's own context files leave it out, and a connection is proved by asking, not by a pid.
    pub pid: Option<i64>,
}

/// The sentences a caller may be shown, kept as constants because they are read by people and
/// matched by specs. `runtime.test.mjs` asserts the runtime one by its two halves.
pub const INVALID: &str = "Invalid local workspace connection.";
pub const INVALID_SIDECAR: &str = "Invalid sidecar descriptor.";
pub const SIDECAR_IDENTITY: &str = "Sidecar identity mismatch.";
pub const WORKSPACE_IDENTITY: &str = "Workspace identity mismatch.";
pub const ANOTHER_HOST: &str = "Runtime descriptor belongs to another session host.";
pub const RUNTIME_IDENTITY: &str = "Runtime identity/capability mismatch.";

/// A live process that will not answer, in the words the JavaScript used. Two sentences for two
/// descriptors, and both end by saying nothing was started, because that is what the reader needs.
pub fn sidecar_unavailable(pid: i64, why: &str) -> String {
    format!("Existing sidecar PID {pid} is alive but unavailable: {why}. No second sidecar was started.")
}

pub fn runtime_unavailable(pid: i64, why: &str) -> String {
    format!("Runtime PID {pid} is alive but unavailable. No duplicate was started: {why}")
}

fn hex(text: &str, length: usize) -> bool {
    text.len() == length && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// `/^[0-9a-f-]{36}$/`, which is looser than a uuid and is deliberately the JavaScript's rule: the
/// instance is compared for EQUALITY everywhere it matters, so its shape only has to be a shape.
fn instance_shaped(text: &str) -> bool {
    text.len() == 36 && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-')
}

/// `http://127.0.0.1[:port]` with nothing after the host but an optional `/`.
///
/// Loopback and nothing else, because the token in this descriptor is a capability: a URL naming
/// another machine would send it there. Hand-parsed rather than pulled through a URL crate for one
/// shape — and stricter than `new URL` in exactly one degenerate way, an empty `?` or `#`, which
/// that parser normalises away and nothing here has ever written.
fn local_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else { return false };
    if rest.contains('@') || rest.contains('?') || rest.contains('#') {
        return false;
    }
    let authority = rest.strip_suffix('/').unwrap_or(rest);
    if authority.contains('/') {
        return false;
    }
    match authority.split_once(':') {
        None => authority == "127.0.0.1",
        Some((host, port)) => host == "127.0.0.1" && !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()),
    }
}

/// A descriptor read as a connection, or the one sentence that says it is not one.
pub fn check_connection(value: &Value) -> Result<Connection, String> {
    let string = |name: &str| value.get(name).and_then(Value::as_str).unwrap_or_default();
    let (url, token, instance) = (string("url"), string("token"), string("instance"));
    if !local_url(url) || !hex(token, 64) || !instance_shaped(instance) {
        return Err(INVALID.to_string());
    }
    Ok(Connection {
        url: url.to_string(),
        token: token.to_string(),
        instance: instance.to_string(),
        pid: value.get("pid").and_then(Value::as_i64).filter(|pid| *pid > 0 && *pid <= 9_007_199_254_740_991),
    })
}

/// Is this process still there?
///
/// Signal 0 asks without delivering anything. `EPERM` is a **yes**: a process we are not allowed to
/// signal is a process. Treating it as gone is how a workspace starts a second host beside a live
/// one, so the permission error is the one case worth spelling out.
pub fn alive(pid: i64) -> bool {
    if pid < 1 || pid > i32::MAX as i64 {
        return false;
    }
    #[cfg(unix)]
    {
        /* EPERM is 1 on every platform this runs on, and one `extern "C"` for one signal is cheaper
           than a dependency that would have to be pinned and vendored for it. */
        let answer = unsafe { kill(pid as i32, 0) };
        answer == 0 || std::io::Error::last_os_error().raw_os_error() == Some(1)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}

/// One authenticated call on a workspace's own API, by the descriptor that names it.
pub fn request(connection: &Connection, route: &str, data: Option<&Value>, headers: &[(String, String)]) -> Result<Value, String> {
    let path = format!("/api/{route}");
    match data {
        Some(body) => crate::http::post(&connection.url, &connection.token, &path, body, headers),
        None => crate::http::get_as(&connection.url, &connection.token, &path, headers),
    }
}

fn read_descriptor(path: &Path) -> Result<Option<Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|error| format!("{} is not readable JSON: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{} cannot be read: {error}", path.display())),
    }
}

/// The session host serving this state directory, if one is.
///
/// `Ok(None)` means nobody is and a caller may start one. An `Err` means something is there — the
/// descriptor is wrong, or its process is alive and will not answer — and starting a second one
/// would be the actual mistake.
pub fn discover_sidecar(directory: &Path) -> Result<Option<Connection>, String> {
    let Some(document) = read_descriptor(&directory.join("sidecar.json"))? else { return Ok(None) };
    /* Looser than `check_connection` on purpose, and this is the JavaScript's shape: a sidecar
       descriptor is checked for a loopback URL and a token, and its instance is whatever it says —
       it is about to be compared against what the process itself answers. */
    let url = document.get("url").and_then(Value::as_str).unwrap_or_default();
    let token = document.get("token").and_then(Value::as_str).unwrap_or_default();
    if !local_url(url) || !hex(token, 64) {
        return Err(INVALID_SIDECAR.to_string());
    }
    let instance = document.get("instance").and_then(Value::as_str).unwrap_or_default().to_string();
    let pid = document.get("pid").and_then(Value::as_i64).unwrap_or(0);
    if !alive(pid) {
        return Ok(None);
    }
    let connection = Connection { url: url.to_string(), token: token.to_string(), instance, pid: Some(pid) };
    match reachable_sidecar(&connection) {
        Ok(()) => Ok(Some(connection)),
        /* Asked again before reporting: a process that exited while we were asking is simply gone,
           and answering `None` lets the caller start the one that is missing. */
        Err(why) if !alive(pid) => {
            let _ = why;
            Ok(None)
        }
        Err(why) => Err(sidecar_unavailable(pid, &why)),
    }
}

fn reachable_sidecar(connection: &Connection) -> Result<(), String> {
    let health = crate::http::get(&connection.url, &connection.token, "/health")?;
    if health.get("protocol").and_then(Value::as_i64) != Some(1)
        || health.get("instance").and_then(Value::as_str).unwrap_or_default() != connection.instance
    {
        return Err(SIDECAR_IDENTITY.to_string());
    }
    let state = request(connection, "state", None, &[])?;
    if state.get("instance").and_then(Value::as_str).unwrap_or_default() != connection.instance {
        return Err(WORKSPACE_IDENTITY.to_string());
    }
    Ok(())
}

/// The supervisor serving this host, if one is — and the whole descriptor, because callers want
/// fields a [`Connection`] does not carry (`toolWorker`, `idePort`, `connectorGeneration`).
///
/// The identity check is the load-bearing part: a descriptor left behind by a DIFFERENT session
/// host names a live supervisor bound to somebody else's sessions, and adopting it would route this
/// workspace's panes into another one.
pub fn discover_runtime(host: &Connection, directory: &Path) -> Result<Option<Value>, String> {
    let Some(document) = read_descriptor(&directory.join("runtime.json"))? else { return Ok(None) };
    let connection = check_connection(&document)?;
    if !belongs(host, &document) {
        return Err(ANOTHER_HOST.to_string());
    }
    let pid = document.get("pid").and_then(Value::as_i64).unwrap_or(0);
    if !alive(pid) {
        return Ok(None);
    }
    match reachable_runtime(&connection, host) {
        Ok(()) => Ok(Some(document)),
        Err(why) => Err(runtime_unavailable(pid, &why)),
    }
}

/// Is this runtime descriptor THIS host's?
///
/// Four fields, and all four matter. A descriptor left behind by a different session host names a
/// live supervisor bound to somebody else's sessions, and the token in it would even work.
pub fn belongs(host: &Connection, document: &Value) -> bool {
    let at = |path: &[&str]| -> &str {
        let mut held = document;
        for step in path {
            match held.get(*step) {
                Some(next) => held = next,
                None => return "",
            }
        }
        held.as_str().unwrap_or_default()
    };
    document.get("version").and_then(Value::as_i64) == Some(1)
        && at(&["host", "url"]) == host.url
        && at(&["host", "token"]) == host.token
        && at(&["host", "instance"]) == host.instance
        && at(&["instance"]) == host.instance
}

/// Where this host's routes are served from right now, WITHOUT asking: the supervisor when a
/// descriptor names a live one belonging to this host, and nothing otherwise.
///
/// The quiet half of [`discover_runtime`], for a caller that must not fail when the supervisor is
/// missing — a pane's tool call falls back to the session host rather than refusing, because the
/// host answers most of the same routes and a dead supervisor is not a reason to break a pane.
pub fn runtime_for(host: &Connection, directory: &Path) -> Option<Connection> {
    let document = read_descriptor(&directory.join("runtime.json")).ok().flatten()?;
    let connection = check_connection(&document).ok()?;
    let pid = document.get("pid").and_then(Value::as_i64).unwrap_or(0);
    if !belongs(host, &document) || !alive(pid) {
        return None;
    }
    Some(connection)
}

fn reachable_runtime(connection: &Connection, host: &Connection) -> Result<(), String> {
    let state = request(connection, "state", None, &[])?;
    let same = state.get("instance").and_then(Value::as_str).unwrap_or_default() == host.instance;
    /* `layeredUpdates` is the promise a supervisor makes, and it is what tells a live supervisor
       from a bare session host answering on the port a stale descriptor named. */
    let layered = state.get("capabilities").and_then(|held| held.get("layeredUpdates")).and_then(Value::as_i64) == Some(1);
    if same && layered {
        Ok(())
    } else {
        Err(RUNTIME_IDENTITY.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn token() -> String {
        "a".repeat(64)
    }

    fn descriptor() -> Value {
        json!({ "url": "http://127.0.0.1:8931", "token": token(), "instance": "11111111-2222-3333-4444-555555555555", "pid": 42 })
    }

    #[test]
    fn a_descriptor_is_a_connection_or_it_is_not_one() {
        let held = check_connection(&descriptor()).expect("a connection");
        assert_eq!(held.url, "http://127.0.0.1:8931");
        assert_eq!(held.pid, Some(42));
        /* A trailing slash and a bare host are the same URL, because `new URL` normalises both. */
        for url in ["http://127.0.0.1:8931/", "http://127.0.0.1"] {
            let mut value = descriptor();
            value["url"] = json!(url);
            assert!(check_connection(&value).is_ok(), "{url}");
        }
    }

    /* The token in a descriptor is a CAPABILITY: a URL naming another machine would send it there,
       and a path or userinfo on it is a URL that was built by something other than this workspace. */
    #[test]
    fn a_url_that_is_not_this_machine_is_refused() {
        for url in [
            "https://127.0.0.1:8931",
            "http://localhost:8931",
            "http://127.0.0.2:8931",
            "http://example.test",
            "http://user:pass@127.0.0.1:8931",
            "http://127.0.0.1:8931/api/state",
            "http://127.0.0.1:8931?token=x",
            "http://127.0.0.1:8931#x",
            "http://127.0.0.1:notaport",
            "127.0.0.1:8931",
            "",
        ] {
            let mut value = descriptor();
            value["url"] = json!(url);
            assert_eq!(check_connection(&value), Err(INVALID.to_string()), "{url}");
        }
    }

    #[test]
    fn a_token_or_an_instance_of_the_wrong_shape_is_refused() {
        for bad in [json!("A".repeat(64)), json!("a".repeat(63)), json!("a".repeat(65)), json!(""), json!(64), Value::Null] {
            let mut value = descriptor();
            value["token"] = bad.clone();
            assert_eq!(check_connection(&value), Err(INVALID.to_string()), "{bad}");
        }
        for bad in [json!("1111"), json!("z1111111-2222-3333-4444-555555555555"), json!("")] {
            let mut value = descriptor();
            value["instance"] = bad.clone();
            assert_eq!(check_connection(&value), Err(INVALID.to_string()), "{bad}");
        }
    }

    /* A connection with no pid is a connection: the context files a host mints for a pane carry no
       pid at all, and a check that demanded one would refuse every agent's own context. */
    #[test]
    fn a_pid_is_kept_when_it_is_one_and_dropped_when_it_is_not() {
        for (given, kept) in [(json!(42), Some(42)), (json!(0), None), (json!(-1), None), (json!(1.5), None), (Value::Null, None)] {
            let mut value = descriptor();
            value["pid"] = given.clone();
            assert_eq!(check_connection(&value).expect("a connection").pid, kept, "{given}");
        }
        let mut value = descriptor();
        value.as_object_mut().expect("an object").remove("pid");
        assert_eq!(check_connection(&value).expect("a connection").pid, None);
    }

    /* This process is alive; pid 1 exists and we may not signal it, which is the EPERM case and the
       one that matters — treating it as gone is how a second host gets started beside a live one. */
    #[test]
    fn a_live_process_is_alive_even_when_it_cannot_be_signalled() {
        assert!(alive(std::process::id() as i64));
        assert!(alive(1), "pid 1 is a process whether or not this user may signal it");
        assert!(!alive(0));
        assert!(!alive(-1));
        assert!(!alive(i64::MAX), "a number that is not a pid is not a live one");
    }

    #[test]
    fn a_directory_with_no_descriptor_is_nobody_serving_it() {
        let directory = std::env::temp_dir().join(format!("red-descriptor-empty-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("a directory");
        assert_eq!(discover_sidecar(&directory).expect("no error"), None);
        let host = check_connection(&descriptor()).expect("a connection");
        assert_eq!(discover_runtime(&host, &directory).expect("no error"), None);
        std::fs::remove_dir_all(&directory).ok();
    }

    /* A descriptor whose process is gone is nobody serving it — so the caller starts one, which is
       the whole point of separating this from the error case below. */
    #[test]
    fn a_descriptor_naming_a_dead_process_is_nobody_serving_it() {
        let directory = std::env::temp_dir().join(format!("red-descriptor-dead-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("a directory");
        let mut document = descriptor();
        /* A pid this large is not a live process on any platform this runs on. */
        document["pid"] = json!(4_194_303);
        std::fs::write(directory.join("sidecar.json"), document.to_string()).expect("written");
        assert_eq!(discover_sidecar(&directory).expect("no error"), None);
        std::fs::remove_dir_all(&directory).ok();
    }

    /* A runtime descriptor left by a DIFFERENT session host names a live supervisor bound to
       somebody else's sessions. Adopting it would route this workspace's panes into another one, so
       it is refused BEFORE the pid is even looked at. */
    #[test]
    fn a_runtime_descriptor_belonging_to_another_host_is_refused_rather_than_adopted() {
        let directory = std::env::temp_dir().join(format!("red-descriptor-foreign-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("a directory");
        let host = check_connection(&descriptor()).expect("a connection");
        let mine = json!({ "version": 1, "url": "http://127.0.0.1:8932", "token": "b".repeat(64),
                           "instance": host.instance, "pid": std::process::id(),
                           "host": { "url": host.url, "token": host.token, "instance": host.instance } });
        for (name, change) in [
            ("a different host token", json!({ "url": host.url, "token": "c".repeat(64), "instance": host.instance })),
            ("a different host url", json!({ "url": "http://127.0.0.1:9999", "token": host.token, "instance": host.instance })),
            ("a different instance", json!({ "url": host.url, "token": host.token, "instance": "99999999-2222-3333-4444-555555555555" })),
        ] {
            let mut document = mine.clone();
            document["host"] = change;
            std::fs::write(directory.join("runtime.json"), document.to_string()).expect("written");
            assert_eq!(discover_runtime(&host, &directory), Err(ANOTHER_HOST.to_string()), "{name}");
        }
        /* And a descriptor from a version that did not write `version` at all. */
        let mut older = mine.clone();
        older["version"] = json!(0);
        std::fs::write(directory.join("runtime.json"), older.to_string()).expect("written");
        assert_eq!(discover_runtime(&host, &directory), Err(ANOTHER_HOST.to_string()));
        std::fs::remove_dir_all(&directory).ok();
    }

    /* The third answer, and the reason it is an error rather than a `None`: a live process that
       will not answer must never become "start another one". Two session hosts on one state
       directory is two writers of the same store. */
    #[test]
    fn a_live_process_that_will_not_answer_is_an_error_that_says_nothing_was_started() {
        let directory = std::env::temp_dir().join(format!("red-descriptor-silent-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("a directory");
        /* Port 1 is nothing this user can bind and nothing is listening on it; the pid is OURS, so
           it is unambiguously alive. */
        let mut document = descriptor();
        document["url"] = json!("http://127.0.0.1:1");
        document["pid"] = json!(std::process::id());
        std::fs::write(directory.join("sidecar.json"), document.to_string()).expect("written");
        let refused = discover_sidecar(&directory).expect_err("an error, never a None");
        assert!(refused.starts_with(&format!("Existing sidecar PID {} is alive but unavailable", std::process::id())), "{refused}");
        assert!(refused.ends_with("No second sidecar was started."), "{refused}");

        let host = check_connection(&descriptor()).expect("a connection");
        let mut runtime = json!({ "version": 1, "url": "http://127.0.0.1:1", "token": "b".repeat(64),
                                  "instance": host.instance, "pid": std::process::id(),
                                  "host": { "url": host.url, "token": host.token, "instance": host.instance } });
        runtime["pid"] = json!(std::process::id());
        std::fs::write(directory.join("runtime.json"), runtime.to_string()).expect("written");
        let refused = discover_runtime(&host, &directory).expect_err("an error, never a None");
        assert!(refused.starts_with(&format!("Runtime PID {} is alive but unavailable. No duplicate was started", std::process::id())), "{refused}");
        std::fs::remove_dir_all(&directory).ok();
    }

    /// The sentences, checked against the JavaScript that still says them — and against the record
    /// when it does not (F173: a parity proof cannot outlive the side it compares against).
    #[test]
    fn the_sentences_are_the_ones_a_person_used_to_get() {
        let checkout = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().and_then(Path::parent).expect("the checkout");
        let sources = ["orchestrator/runtime/protocol.mjs", "orchestrator/launcher/sidecar.mjs", "orchestrator/runtime/discovery.mjs"];
        let text: String = sources
            .iter()
            .filter_map(|name| std::fs::read_to_string(checkout.join(name)).ok())
            .collect::<Vec<String>>()
            .join("\n");
        if text.is_empty() {
            /* The JavaScript is gone. The constants above ARE the record then, and this test says
               so rather than passing silently on a file it could not find. */
            return;
        }
        for sentence in [INVALID, INVALID_SIDECAR, SIDECAR_IDENTITY, WORKSPACE_IDENTITY, ANOTHER_HOST, RUNTIME_IDENTITY] {
            assert!(text.contains(sentence), "the JavaScript no longer says: {sentence}");
        }
        /* The two interpolated ones, by the halves that survive the template. */
        for fragment in [
            "is alive but unavailable: ${error.message}. No second sidecar was started.",
            "is alive but unavailable. No duplicate was started: ${error.message}",
        ] {
            assert!(text.contains(fragment), "the JavaScript no longer says: {fragment}");
        }
        assert!(sidecar_unavailable(7, "connection refused").contains("PID 7 is alive but unavailable: connection refused."));
        assert!(runtime_unavailable(7, "connection refused").contains("PID 7 is alive but unavailable. No duplicate"));
    }
}
