//! The browser sign-in a workspace runs for a tracker (F154, spec 083).
//!
//! `red_project::tracker_auth` owns the flow's rules — the client id, the PKCE challenge, the
//! authorize URL, the grant on disk, the exchange. What is HERE is the part that is a running
//! process: **one loopback listener, for the duration of one sign-in**, which the browser comes back
//! to with a code.
//!
//! The listener is what makes this the worker's rather than a library's. It holds a port, it holds a
//! one-time secret, and there is at most one at a time per workspace — a second start replaces the
//! first rather than leaving a listener and a pending state behind, because two pending sign-ins
//! mean a callback that could belong to either.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use red_project::tracker_auth as auth;

/// How long a person has to finish in the browser before the listener closes. Five minutes, the
/// JavaScript's: long enough to find a password, short enough that a forgotten tab does not hold a
/// port until the workspace closes.
pub const SIGN_IN_TIMEOUT_MS: u64 = 5 * 60 * 1000;

/// The page the browser lands on. A person reads it and closes the tab, so it says which of the
/// four things happened rather than a status code.
pub fn page(message: &str) -> String {
    format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{product}</title>\n<body style=\"font:14px system-ui;padding:3rem;color:#242424\"><p>{message}</p></body>",
        product = red_core::theme::PRODUCT_NAME
    )
}

/// What a callback turned out to be. The three that are not a grant each have their own sentence,
/// because a person who got here and saw nothing has no way to tell them apart.
#[derive(Debug, Clone, PartialEq)]
pub enum Came {
    /// The one-time state did not match: this callback is not this workspace's sign-in.
    Mismatched,
    /// The person declined, or the provider did.
    Declined(String),
    /// A code, to exchange.
    Code(String),
}

/// What a callback request says, judged before anything is exchanged.
///
/// The state is compared in CONSTANT TIME and by length first: the callback carries no workspace
/// credential, so this one-time value is the whole of what authorises it.
pub fn came(target: &str, expected_state: &str) -> Option<Came> {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != auth::CALLBACK_PATH {
        return None;
    }
    let value = |name: &str| {
        query
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .find(|(key, _)| *key == name)
            .map(|(_, value)| decode(value))
    };
    let returned = value("state").unwrap_or_default();
    if !same_secret(&returned, expected_state) {
        return Some(Came::Mismatched);
    }
    if let Some(denied) = value("error").filter(|denied| !denied.is_empty()) {
        return Some(Came::Declined(denied));
    }
    Some(Came::Code(value("code").unwrap_or_default()))
}

/// Equal length, then every byte: the comparison must not tell a caller how much of its guess was
/// right by how long the answer took.
fn same_secret(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut different = 0u8;
    for (a, b) in left.bytes().zip(right.bytes()) {
        different |= a ^ b;
    }
    different == 0
}

fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'%' if at + 2 < bytes.len() => {
                match u8::from_str_radix(&value[at + 1..at + 3], 16) {
                    Ok(byte) => {
                        out.push(byte);
                        at += 3;
                    }
                    Err(_) => {
                        out.push(bytes[at]);
                        at += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                at += 1;
            }
            byte => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// The sign-in in flight, if there is one. At most one per workspace.
#[derive(Default)]
pub struct SigningIn {
    held: Mutex<Option<Arc<Pending>>>,
}

struct Pending {
    /// Closing this ends the listener's thread, which is how a replacement cancels the one before.
    listener: std::net::TcpListener,
    ended: std::sync::atomic::AtomicBool,
}

impl SigningIn {
    pub fn new() -> SigningIn {
        SigningIn::default()
    }

    /// Start one, replacing whatever was in flight.
    ///
    /// `settled` is called with the outcome once the browser has come back — or never, if nobody
    /// does, in which case the listener closes on its own after `SIGN_IN_TIMEOUT_MS`.
    pub fn begin(
        &self,
        state_directory: &str,
        project: &str,
        settled: Box<dyn Fn(&Value) + Send + 'static>,
    ) -> Result<Value, String> {
        let Some(client_id) = auth::client(state_directory) else {
            return Err("409|No Linear application is registered for this workspace yet.".to_string());
        };
        self.cancel();
        /* A FIXED port, which is the one place this departs from the usual native-app shape: the
           provider matches redirect URIs exactly and implements no port wildcard, so an OS-assigned
           one would never be accepted. Several are registered so a busy one does not end it. */
        let listener = auth::CALLBACK_PORTS
            .iter()
            .find_map(|port| std::net::TcpListener::bind(("127.0.0.1", *port)).ok())
            .ok_or_else(|| {
                format!(
                    "503|Every sign-in port is busy ({}). Close what is using one and try again.",
                    auth::CALLBACK_PORTS.iter().map(u16::to_string).collect::<Vec<_>>().join(", ")
                )
            })?;
        let port = listener.local_addr().map(|address| address.port()).unwrap_or_default();
        let redirect = auth::callback_uri(port);
        let verifier = auth::base64url(&red_core::service::secret().into_bytes()[..32]);
        let state = auth::base64url(&red_core::service::secret().into_bytes()[..24]);
        let started = auth::authorize(&client_id, &redirect, &verifier, &state);

        let pending = Arc::new(Pending { listener, ended: std::sync::atomic::AtomicBool::new(false) });
        *self.held.lock().expect("signing in") = Some(pending.clone());
        let (directory, project, redirect_for) = (state_directory.to_string(), project.to_string(), redirect.clone());
        let serving = pending.clone();
        std::thread::spawn(move || {
            serve_callback(&serving, &directory, &project, &client_id, &redirect_for, &verifier, &state, settled)
        });
        /* The deadline is its own thread because the listener blocks: a forgotten tab must not hold
           a registered port until the workspace closes. */
        let deadline = pending;
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(SIGN_IN_TIMEOUT_MS));
            end(&deadline);
        });
        Ok(json!({ "ok": true, "url": started.url, "redirect": redirect }))
    }

    /// End whatever is in flight. A second start replaces the first rather than leaving a listener
    /// and a pending state behind: two pending sign-ins mean a callback that could belong to either.
    pub fn cancel(&self) {
        if let Some(pending) = self.held.lock().expect("signing in").take() {
            end(&pending);
        }
    }
}

fn end(pending: &Arc<Pending>) {
    if pending.ended.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    /* Waking the accept by connecting to it, then letting the listener drop: there is no portable
       way to interrupt a blocking accept, and a thread left in one holds the port. */
    if let Ok(address) = pending.listener.local_addr() {
        let _ = std::net::TcpStream::connect(address);
    }
}

#[allow(clippy::too_many_arguments)]
fn serve_callback(
    pending: &Arc<Pending>,
    state_directory: &str,
    project: &str,
    client_id: &str,
    redirect: &str,
    verifier: &str,
    state: &str,
    settled: Box<dyn Fn(&Value) + Send + 'static>,
) {
    for stream in pending.listener.incoming() {
        if pending.ended.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let Ok(mut stream) = stream else { continue };
        let mut buffer = [0u8; 8192];
        let Ok(read) = stream.read(&mut buffer) else { continue };
        let text = String::from_utf8_lossy(&buffer[..read]).to_string();
        let target = text.split_whitespace().nth(1).unwrap_or("/").to_string();
        let Some(came) = came(&target, state) else {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
            continue;
        };
        let (status, said, outcome) = match came {
            Came::Mismatched => (
                400,
                page("That sign-in did not match this workspace. Nothing was stored."),
                /* Not an outcome: the sign-in this workspace began is still waiting, and a stranger's
                   callback must not end it. */
                None,
            ),
            Came::Declined(why) => (200, page("Sign-in was declined. You can close this tab."), Some(json!({ "ok": false, "error": why }))),
            Came::Code(code) => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|since| since.as_millis() as i64)
                    .unwrap_or(0);
                match auth::exchange(client_id, &code, redirect, verifier, now)
                    .and_then(|grant| auth::store(state_directory, project, &grant).map(|()| grant))
                {
                    Ok(_) => (
                        200,
                        page(&format!("Signed in. You can close this tab and go back to {}.", red_core::theme::PRODUCT_NAME)),
                        Some(json!({ "ok": true })),
                    ),
                    Err(fail) => (500, page(&format!("Sign-in failed: {}", fail.message)), Some(json!({ "ok": false, "error": fail.message }))),
                }
            }
        };
        let _ = stream.write_all(
            format!(
                "HTTP/1.1 {status} OK\r\nContent-Type: text/html\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{said}",
                said.len()
            )
            .as_bytes(),
        );
        if let Some(outcome) = outcome {
            settled(&outcome);
            end(pending);
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATE: &str = "a-one-time-state";

    /* The callback carries no workspace credential, so the one-time state is the whole of what
       authorises it — and a callback that does not match must not END the sign-in this workspace is
       still waiting on, or a stranger could cancel it by guessing the path. */
    #[test]
    fn a_callback_that_is_not_this_workspaces_is_not_this_workspaces() {
        assert_eq!(came("/tracker/callback?state=wrong&code=c", STATE), Some(Came::Mismatched));
        assert_eq!(came("/tracker/callback?code=c", STATE), Some(Came::Mismatched), "and one that names no state at all");
        /* A path that is not the callback is not a callback: nothing else is served here. */
        assert_eq!(came("/", STATE), None);
        assert_eq!(came("/favicon.ico", STATE), None);
        assert_eq!(came("/tracker/callback/extra?state=a-one-time-state", STATE), None);
    }

    #[test]
    fn a_code_and_a_refusal_are_told_apart() {
        assert_eq!(came(&format!("/tracker/callback?state={STATE}&code=abc123"), STATE), Some(Came::Code("abc123".to_string())));
        assert_eq!(
            came(&format!("/tracker/callback?state={STATE}&error=access_denied"), STATE),
            Some(Came::Declined("access_denied".to_string()))
        );
        /* The error wins over a code, because a provider that sent both is refusing. */
        assert_eq!(
            came(&format!("/tracker/callback?state={STATE}&code=abc&error=access_denied"), STATE),
            Some(Came::Declined("access_denied".to_string()))
        );
        /* A code that arrived percent-encoded is the code, not the encoding. */
        assert_eq!(came(&format!("/tracker/callback?state={STATE}&code=a%2Fb"), STATE), Some(Came::Code("a/b".to_string())));
    }

    /* Constant time and length-first: the comparison must not tell a caller how much of its guess
       was right by how long the answer took. */
    #[test]
    fn the_one_time_state_is_compared_without_saying_how_close_a_guess_was() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abc", "abd"));
        assert!(!same_secret("abc", "ab"), "a prefix is not a match");
        assert!(!same_secret("", "a"));
        assert!(same_secret("", ""));
    }

    /* A person reads this page and closes the tab, so it says which of the four things happened. */
    #[test]
    fn the_page_names_the_product_a_person_came_from() {
        let said = page("Signed in.");
        assert!(said.contains(red_core::theme::PRODUCT_NAME), "{said}");
        assert!(said.starts_with("<!doctype html>"), "{said}");
    }
}

/* --- where the workspace keeps its state ------------------------------------------------------ */

/// The directory the SESSION HOST keeps its state in, which is where a tracker credential lives.
///
/// A host from this checkout says so on `/api/state`. A RETAINED one does not, and is found the way
/// `--replace-host` finds it: the `main.mjs --state DIR` row in the process table whose
/// `sidecar.json` names this host's instance.
///
/// **The instance is the key, never the URL** — a worker is often handed a proxy's URL — and never
/// the first host row, since a machine runs many.
pub fn host_state_directory(state: &serde_json::Value, instance: &str, table: &str) -> Result<String, String> {
    if let Some(said) = state.get("stateDir").and_then(serde_json::Value::as_str).filter(|path| path.starts_with('/')) {
        return Ok(said.to_string());
    }
    for row in table.lines() {
        let Some(directory) = host_arguments(row) else { continue };
        let descriptor = std::path::Path::new(&directory).join("sidecar.json");
        let Ok(text) = std::fs::read_to_string(&descriptor) else { continue };
        let named = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|held| held.get("instance").and_then(serde_json::Value::as_str).map(str::to_string));
        if named.as_deref() == Some(instance) {
            return Ok(directory);
        }
    }
    Err(format!(
        "the session host does not say where its state lives, and no main.mjs --state process serves instance {instance}"
    ))
}

/// `<anything>server/main.mjs --state <directory>` at the end of a command line.
fn host_arguments(command: &str) -> Option<String> {
    let at = command.find("server/main.mjs")?;
    let rest = command[at + "server/main.mjs".len()..].trim_start();
    let directory = rest.strip_prefix("--state")?.trim();
    (!directory.is_empty()).then(|| directory.trim_end().to_string())
}

/// What a caller is told when the directory cannot be found. It names the consequence and the two
/// ways out, because a person reading it has to choose one.
pub fn unknown_directory(why: &str) -> String {
    format!(
        "The workspace state directory is unknown to this worker: {why}. The local backend still reads; a remote tracker needs a host that reports its state directory (start it from this checkout, or --replace-host)."
    )
}

#[cfg(test)]
mod directory_tests {
    use super::*;

    fn scratch(name: &str) -> String {
        let at = std::env::temp_dir().join(format!("red-worker-signin-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&at);
        std::fs::create_dir_all(&at).expect("a directory");
        at.to_string_lossy().to_string()
    }

    /* A host from this checkout says where its state lives, and that is the end of it. */
    #[test]
    fn a_host_that_says_where_its_state_is_needs_no_process_table() {
        let said = serde_json::json!({ "stateDir": "/work/state", "instance": "i" });
        assert_eq!(host_state_directory(&said, "i", "").expect("found"), "/work/state");
        /* A relative path is not an answer: this reaches a credential's filename. */
        let relative = serde_json::json!({ "stateDir": "state" });
        assert!(host_state_directory(&relative, "i", "").is_err());
    }

    /* A RETAINED host does not say, and is found the way `--replace-host` finds it. The INSTANCE is
       the key: a machine runs many hosts, and the first row is somebody else's workspace. */
    #[test]
    fn a_retained_host_is_found_by_its_instance_and_never_by_being_first() {
        let mine = scratch("mine");
        let theirs = scratch("theirs");
        std::fs::write(std::path::Path::new(&theirs).join("sidecar.json"), r#"{"instance":"somebody-else"}"#).expect("written");
        std::fs::write(std::path::Path::new(&mine).join("sidecar.json"), r#"{"instance":"ours"}"#).expect("written");
        let table = format!(
            "  100   1 /usr/bin/node /x/orchestrator/server/main.mjs --state {theirs}\n  200   1 /usr/bin/node /x/orchestrator/server/main.mjs --state {mine}\n"
        );
        assert_eq!(host_state_directory(&serde_json::json!({}), "ours", &table).expect("found"), mine);
        assert_eq!(host_state_directory(&serde_json::json!({}), "somebody-else", &table).expect("found"), theirs);
        /* An instance nobody serves is a named absence, not the first row. */
        let refused = host_state_directory(&serde_json::json!({}), "nobody", &table).expect_err("refused");
        assert!(refused.contains("nobody"), "{refused}");
        /* And a row that is not a session host is not one, however much it looks like a command. */
        assert_eq!(host_arguments("/usr/bin/node /x/orchestrator/runtime/worker.mjs"), None);
        assert_eq!(host_arguments("/usr/bin/node /x/server/main.mjs"), None, "with no --state it names no directory");
        assert_eq!(host_arguments("node /x/server/main.mjs --state /a/b"), Some("/a/b".to_string()));
        let _ = std::fs::remove_dir_all(&mine);
        let _ = std::fs::remove_dir_all(&theirs);
    }

    /* The sentence names the consequence and the two ways out, because a person reading it has to
       choose one. */
    #[test]
    fn a_directory_nobody_can_find_is_said_out_loud_with_what_to_do() {
        let said = unknown_directory("the process table could not be read");
        assert!(said.contains("The local backend still reads"), "{said}");
        assert!(said.contains("--replace-host"), "{said}");
    }
}
