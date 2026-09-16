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

/// A code, for the grant it buys. The network step, handed in so the rest can be driven without one.
pub type Exchanging = Box<dyn Fn(&str, &str, &str, &str, i64) -> Result<Value, String> + Send + 'static>;

fn exchange_for_real(client_id: &str, code: &str, redirect: &str, verifier: &str, now: i64) -> Result<Value, String> {
    auth::exchange(client_id, code, redirect, verifier, now).map_err(|fail| fail.message)
}

/// The sign-in in flight, if there is one. At most one per workspace.
#[derive(Default)]
pub struct SigningIn {
    held: Mutex<Option<Arc<Pending>>>,
}

/// A sign-in in flight, as everything OTHER than the listening thread sees it.
///
/// It deliberately does not own the listener. The listener is moved into the thread that accepts on
/// it, so the port is released the moment that thread returns — and the thing that ends a sign-in
/// only needs to know where to knock. Holding it here instead is how the port came to be kept for
/// the worker's whole life: `held` keeps the last sign-in, and the deadline thread keeps another
/// reference for five minutes, so a person who signed in once never got that port back and the
/// fifth workspace on a machine was told every registered port was busy with nothing to close.
struct Pending {
    /// Where to knock to wake the blocking accept. There is no portable way to interrupt one.
    address: std::net::SocketAddr,
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
        self.beginning(state_directory, project, settled, Box::new(exchange_for_real))
    }

    /// The same, with the exchange handed in.
    ///
    /// The code-for-grant exchange is the one step that leaves this machine, and it is the last step
    /// of a flow whose earlier ones — a port bound, a browser sent somewhere, a state compared —
    /// have nothing to do with a network. Injecting it is what lets the whole sign-in be driven end
    /// to end without one, which is the only way this is tested at all.
    pub fn beginning(
        &self,
        state_directory: &str,
        project: &str,
        settled: Box<dyn Fn(&Value) + Send + 'static>,
        exchanging: Exchanging,
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

        let address = listener.local_addr().map_err(|error| format!("503|The sign-in port could not be read: {error}"))?;
        let pending = Arc::new(Pending { address, ended: std::sync::atomic::AtomicBool::new(false) });
        *self.held.lock().expect("signing in") = Some(pending.clone());
        let (directory, project, redirect_for) = (state_directory.to_string(), project.to_string(), redirect.clone());
        let serving = pending.clone();
        /* The listener is MOVED here and nowhere else, so when this thread returns the port is free
           — whether the browser came back, a replacement cancelled it, or the deadline passed. */
        std::thread::spawn(move || {
            serve_callback(listener, &serving, &directory, &project, &client_id, &redirect_for, &verifier, &state, settled, exchanging)
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
    /* Waking the accept by connecting to it, so the thread that owns the listener can see the flag
       and return: there is no portable way to interrupt a blocking accept, and a thread left in one
       holds the port. */
    let _ = std::net::TcpStream::connect(pending.address);
}

#[allow(clippy::too_many_arguments)]
fn serve_callback(
    listener: std::net::TcpListener,
    pending: &Arc<Pending>,
    state_directory: &str,
    project: &str,
    client_id: &str,
    redirect: &str,
    verifier: &str,
    state: &str,
    settled: Box<dyn Fn(&Value) + Send + 'static>,
    exchanging: Exchanging,
) {
    for stream in listener.incoming() {
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
                match exchanging(client_id, &code, redirect, verifier, now)
                    .and_then(|grant| auth::store(state_directory, project, &grant).map_err(|fail| fail.message).map(|()| grant))
                {
                    Ok(_) => (
                        200,
                        page(&format!("Signed in. You can close this tab and go back to {}.", red_core::theme::PRODUCT_NAME)),
                        Some(json!({ "ok": true })),
                    ),
                    Err(message) => (500, page(&format!("Sign-in failed: {message}")), Some(json!({ "ok": false, "error": message }))),
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

    fn scratch(name: &str) -> String {
        let at = std::env::temp_dir().join(format!("red-worker-flow-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&at);
        std::fs::create_dir_all(at.join("trackers")).expect("a directory");
        std::fs::write(at.join("trackers/oauth.json"), r#"{"linear":{"clientId":"client-123"}}"#).expect("written");
        at.to_string_lossy().to_string()
    }

    /// The browser's half: open the URL the sign-in gave, with a code.
    fn browser(url: &str, state: &str, query: &str) -> String {
        use std::io::{Read, Write};
        let port: u16 = url.split(':').nth(2).and_then(|rest| rest.split('/').next()).and_then(|port| port.parse().ok()).expect("a port");
        let Ok(mut socket) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
            /* Nothing is listening, which is itself an answer for a test asking whether anything is. */
            return String::new();
        };
        /* A deadline, because a listener that is gone leaves a connection in the backlog that nobody
           will ever answer — and a test that hangs says less than one that fails. */
        socket.set_read_timeout(Some(std::time::Duration::from_secs(5))).expect("a deadline");
        socket
            .write_all(format!("GET {}?state={state}&{query} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n", auth::CALLBACK_PATH).as_bytes())
            .expect("asked");
        let mut answer = String::new();
        let _ = socket.read_to_string(&mut answer);
        answer
    }

    /// The `state` a sign-in bound itself to, read out of the URL it handed back.
    /// The five callback ports are a FIXED, shared resource. Tests that bind one take turns, because
    /// otherwise they race each other for the same five numbers and fail for a reason that has
    /// nothing to do with what they assert — which is exactly the shape of the suite flake that
    /// found the leak these tests now cover.
    fn ports() -> std::sync::MutexGuard<'static, ()> {
        static TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());
        TURN.lock().unwrap_or_else(|held| held.into_inner())
    }

    /// The port a sign-in was given, read off the redirect it published.
    fn port_of(redirect: &str) -> u16 {
        redirect
            .split("127.0.0.1:")
            .nth(1)
            .and_then(|rest| rest.split('/').next())
            .and_then(|port| port.parse().ok())
            .expect("a port in the redirect")
    }

    fn state_of(url: &str) -> String {
        url.split("&state=").nth(1).and_then(|rest| rest.split('&').next()).expect("a state").to_string()
    }

    /* The whole flow, end to end, with only the network step handed in: a port bound, a browser sent
       somewhere, a code coming back, a grant on disk at 0600. This is what the JavaScript's own
       sign-in test proved, and the reason the exchange is injectable at all. */
    #[test]
    fn a_browser_sign_in_stores_a_grant_and_the_tab_says_so() {
        let _turn = ports();
        let at = scratch("stores");
        let signing = SigningIn::new();
        let outcome: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
        let heard = outcome.clone();
        let started = signing
            .beginning(
                &at,
                "kohai",
                Box::new(move |said| *heard.lock().expect("outcome") = Some(said.clone())),
                Box::new(|client_id, code, redirect, verifier, now| {
                    /* Everything the provider will check, and the verifier it proves the sign-in
                       with — which is never in the URL a browser was given. */
                    assert_eq!(client_id, "client-123");
                    assert_eq!(code, "the-code");
                    assert!(redirect.starts_with("http://127.0.0.1:"));
                    assert!(!verifier.is_empty());
                    Ok(auth::grant_from(&json!({ "access_token": "at", "refresh_token": "rt", "expires_in": 3600 }), now))
                }),
            )
            .expect("started");
        assert_eq!(started["ok"], json!(true));
        let url = started["url"].as_str().expect("a url").to_string();
        let redirect = started["redirect"].as_str().expect("a redirect").to_string();
        assert!(url.starts_with(auth::AUTHORIZE), "{url}");

        let said = browser(&redirect, &state_of(&url), "code=the-code");
        assert!(said.starts_with("HTTP/1.1 200"), "{said}");
        assert!(said.contains("Signed in"), "{said}");

        let grant = wait_for(|| auth::stored(&at, "kohai")).expect("a grant");
        assert_eq!(grant["accessToken"], json!("at"));
        assert_eq!(grant["refreshToken"], json!("rt"));
        assert_eq!(grant["kind"], json!("oauth"));
        assert_eq!(wait_for(|| outcome.lock().expect("outcome").clone()).expect("an outcome")["ok"], json!(true));
        let _ = std::fs::remove_dir_all(&at);
    }

    /* A callback that does not match this workspace stores NOTHING and does not end the sign-in
       this workspace is still waiting on — otherwise a stranger could cancel it by guessing a path. */
    #[test]
    fn a_callback_that_is_not_this_sign_in_stores_nothing_and_does_not_end_it() {
        let _turn = ports();
        let at = scratch("mismatched");
        let signing = SigningIn::new();
        let started = signing
            .beginning(&at, "kohai", Box::new(|_| {}), Box::new(|_, _, _, _, now| {
                Ok(auth::grant_from(&json!({ "access_token": "at" }), now))
            }))
            .expect("started");
        let redirect = started["redirect"].as_str().expect("a redirect").to_string();

        let said = browser(&redirect, "not-this-workspaces-state", "code=the-code");
        assert!(said.starts_with("HTTP/1.1 400"), "{said}");
        assert!(said.contains("did not match this workspace"), "{said}");
        assert_eq!(auth::stored(&at, "kohai"), None, "nothing was stored");

        /* And the real one still completes, because the stranger's callback did not end it. */
        let url = started["url"].as_str().expect("a url").to_string();
        let mine = browser(&redirect, &state_of(&url), "code=the-code");
        assert!(mine.starts_with("HTTP/1.1 200"), "{mine}");
        assert!(wait_for(|| auth::stored(&at, "kohai")).is_some(), "the sign-in was still waiting");
        let _ = std::fs::remove_dir_all(&at);
    }

    /* A person who declined is told so and left with nothing, which is a different answer from a
       sign-in that failed. */
    #[test]
    fn a_declined_sign_in_says_so_and_leaves_no_grant() {
        let _turn = ports();
        let at = scratch("declined");
        let signing = SigningIn::new();
        let outcome: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
        let heard = outcome.clone();
        let started = signing
            .beginning(&at, "kohai", Box::new(move |said| *heard.lock().expect("outcome") = Some(said.clone())),
                       Box::new(|_, _, _, _, _| panic!("a declined sign-in exchanges nothing")))
            .expect("started");
        let url = started["url"].as_str().expect("a url").to_string();
        let said = browser(started["redirect"].as_str().expect("a redirect"), &state_of(&url), "error=access_denied");
        assert!(said.contains("was declined"), "{said}");
        assert_eq!(auth::stored(&at, "kohai"), None);
        let answer = wait_for(|| outcome.lock().expect("outcome").clone()).expect("an outcome");
        assert_eq!(answer["ok"], json!(false));
        assert_eq!(answer["error"], json!("access_denied"));
        let _ = std::fs::remove_dir_all(&at);
    }

    /* Before an application is registered there is nothing to open, and a caller is told what to do
       rather than refused — which is the whole of the setup for a person who has never done this. */
    #[test]
    fn a_sign_in_with_no_application_registered_is_refused_by_name() {
        let at = std::env::temp_dir().join(format!("red-worker-flow-bare-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&at);
        std::fs::create_dir_all(&at).expect("a directory");
        let signing = SigningIn::new();
        let refused = signing
            .begin(&at.to_string_lossy(), "kohai", Box::new(|_| {}))
            .expect_err("refused");
        assert!(refused.starts_with("409|"), "{refused}");
        assert!(refused.contains("No Linear application is registered"), "{refused}");
        let _ = std::fs::remove_dir_all(&at);
    }

    /* At most one per workspace: a second start replaces the first rather than leaving a listener
       and a pending state behind, because two pending sign-ins mean a callback that could belong to
       either. */
    #[test]
    fn a_second_sign_in_replaces_the_first_rather_than_leaving_it_listening() {
        let _turn = ports();
        let at = scratch("second");
        let signing = SigningIn::new();
        let first = signing.beginning(&at, "kohai", Box::new(|_| {}), Box::new(|_, _, _, _, now| {
            Ok(auth::grant_from(&json!({ "access_token": "first" }), now))
        })).expect("started");
        let second = signing.beginning(&at, "kohai", Box::new(|_| {}), Box::new(|_, _, _, _, now| {
            Ok(auth::grant_from(&json!({ "access_token": "second" }), now))
        })).expect("started");
        let first_url = first["url"].as_str().expect("a url").to_string();
        let second_url = second["url"].as_str().expect("a url").to_string();
        assert_ne!(state_of(&first_url), state_of(&second_url), "a new sign-in is a new secret");

        /* The first is GONE, not merely superseded: its own callback, with its own state, completes
           nothing. A listener left behind would still hold a registered port — there are five — and
           would still store a grant for a sign-in the person abandoned. */
        let stale = browser(first["redirect"].as_str().expect("a redirect"), &state_of(&first_url), "code=c");
        assert!(stale.is_empty() || !stale.contains("Signed in"), "the replaced sign-in answered: {stale}");
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert_eq!(auth::stored(&at, "kohai"), None, "and stored nothing");

        /* The second is the one that works. */
        let said = browser(second["redirect"].as_str().expect("a redirect"), &state_of(&second_url), "code=c");
        assert!(said.contains("Signed in"), "{said}");
        assert_eq!(wait_for(|| auth::stored(&at, "kohai")).expect("a grant")["accessToken"], json!("second"));
        signing.cancel();
        let _ = std::fs::remove_dir_all(&at);
    }

    /* The port comes BACK. A sign-in that is over — settled, replaced or timed out — must release
       the port it was given, and this one did not: the listener was owned by the `Pending` that
       `held` keeps and that the five-minute deadline thread keeps a second reference to, so a
       workspace that signed in once never gave that port back. There are five registered ports and
       a machine runs several workspaces, so the fifth was told "Every sign-in port is busy. Close
       what is using one and try again" with nothing to close. Found as an intermittent suite
       failure, which is what a leak looks like from outside. */
    #[test]
    fn a_finished_sign_in_gives_its_port_back() {
        let _turn = ports();
        let at = scratch("port-returned");
        let signing = SigningIn::new();
        let started = signing
            .beginning(&at, "kohai", Box::new(|_| {}), Box::new(|_, _, _, _, now| {
                Ok(auth::grant_from(&json!({ "access_token": "t" }), now))
            }))
            .expect("started");
        let redirect = started["redirect"].as_str().expect("a redirect").to_string();
        let port = port_of(&redirect);
        assert!(auth::CALLBACK_PORTS.contains(&port), "a registered port: {port}");
        assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_err(), "it is held while the sign-in is open");

        /* Settled: the browser came back and the grant was stored. */
        let said = browser(&redirect, &state_of(started["url"].as_str().expect("a url")), "code=c");
        assert!(said.contains("Signed in"), "{said}");
        assert!(
            wait_for(|| std::net::TcpListener::bind(("127.0.0.1", port)).ok()).is_some(),
            "the port is free once the sign-in is over"
        );

        /* And a sign-in that is CANCELLED rather than finished gives it back too. */
        let again = signing
            .beginning(&at, "kohai", Box::new(|_| {}), Box::new(|_, _, _, _, now| {
                Ok(auth::grant_from(&json!({ "access_token": "t" }), now))
            }))
            .expect("started");
        let port = port_of(again["redirect"].as_str().expect("a redirect"));
        signing.cancel();
        assert!(
            wait_for(|| std::net::TcpListener::bind(("127.0.0.1", port)).ok()).is_some(),
            "a cancelled sign-in frees its port as well"
        );
        let _ = std::fs::remove_dir_all(&at);
    }

    /// A listener answers on its own thread, so a test waits for it rather than asserting instantly.
    fn wait_for<T>(mut check: impl FnMut() -> Option<T>) -> Option<T> {
        for _ in 0..200 {
            if let Some(value) = check() {
                return Some(value);
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        None
    }

    /* A person reads this page and closes the tab, so it says which of the four things happened —
       and it wears the DECLARED name, which is a data edit and never typed into shipping code
       (charter D41, spec 108). The tab's title is where a person sees it. */
    #[test]
    fn the_page_wears_the_declared_name_a_person_came_from() {
        let said = page("Signed in.");
        assert!(said.contains(&format!("<title>{}</title>", red_core::theme::PRODUCT_NAME)), "{said}");
        assert!(said.starts_with("<!doctype html>"), "{said}");
        assert!(said.contains("Signed in."), "and the thing that happened");
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
        "the session host does not say where its state lives, and no host process serves instance {instance}"
    ))
}

/// The state directory a host's command line names — `red_core`'s, which knows both spellings of a
/// session host. This module's own copy knew only `server/main.mjs`, so the day the host became a
/// binary it stopped finding any workspace at all.
fn host_arguments(command: &str) -> Option<String> {
    red_core::descriptor::host_arguments(command).map(|(_, directory)| directory)
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
