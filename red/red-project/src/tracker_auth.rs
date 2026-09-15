//! Browser sign-in for a tracker provider (F154, spec 083).
//!
//! The desktop is a **public client**: it cannot keep a secret, so this is the authorization code
//! flow with PKCE. Linear's own parameter table lists `client_secret` as optional once
//! `code_verifier` is present, on the exchange and on every refresh of a grant created this way, so
//! no secret is shipped or stored.
//!
//! The redirect port is **fixed** rather than ephemeral, which is the one place this departs from
//! the usual native-app shape: Linear matches redirect URIs exactly and implements no port wildcard,
//! so a callback on an OS-assigned port would never be accepted. The listener is opened only for the
//! duration of a sign-in and bound to the loopback interface.
//!
//! What is in THIS module is everything that touches no network — the client id a person registers,
//! the setup instructions they read, the PKCE challenge, the authorize URL, and the grant on disk.
//! The exchange and the revoke are the network half and take a caller's own client, so the flow can
//! be driven end to end without one.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::recordings::Fail;

/// Registered as redirect URIs once, when the application is created. Several, so a busy port does
/// not end the attempt; the setup message lists every one so they can be pasted together.
pub const CALLBACK_PORTS: [u16; 5] = [47821, 47822, 47823, 47824, 47825];
pub const CALLBACK_PATH: &str = "/tracker/callback";

pub const AUTHORIZE: &str = "https://linear.app/oauth/authorize";
pub const TOKEN: &str = "https://api.linear.app/oauth/token";
pub const REVOKE: &str = "https://api.linear.app/oauth/revoke";
/// Comma separated, which is Linear's own departure from the usual space separation.
const SCOPES: &str = "read";
/// Refresh before the hour is out rather than on expiry, so an in-flight read never races it.
const REFRESH_MARGIN_MS: i64 = 60 * 60 * 1000;

pub fn callback_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}{CALLBACK_PATH}")
}

fn refuse(message: impl Into<String>, status: u16) -> Fail {
    Fail { message: message.into(), status: Some(status) }
}

/// base64url with no padding, which is what both the challenge and the state are.
pub fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let held = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let packed = ((held[0] as u32) << 16) | ((held[1] as u32) << 8) | held[2] as u32;
        for (at, shift) in [(0usize, 18), (1, 12), (2, 6), (3, 0)] {
            if at <= chunk.len() {
                out.push(ALPHABET[((packed >> shift) & 0x3f) as usize] as char);
            }
        }
    }
    out
}

/// `S256`: the base64url of the SHA-256 of the verifier. The provider recomputes this from the
/// verifier the exchange sends, so a single wrong character is a sign-in that fails at the very end.
pub fn challenge_for(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

fn trackers(state_directory: &str) -> PathBuf {
    Path::new(state_directory).join("trackers")
}

/// Where a person puts the client id after registering the application once. It is not a secret, but
/// it is per-workspace, so it lives beside the workspace state rather than in the source.
pub fn client(state_directory: &str) -> Option<String> {
    let text = std::fs::read_to_string(trackers(state_directory).join("oauth.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let id = value.get("linear")?.get("clientId")?;
    match id {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// What to do when no application is registered yet. A person reads these four lines and acts on
/// them, so they are a contract: step 2 lists every callback URI because they are pasted together,
/// and the note exists because the obvious thing to do with a client secret is store it.
pub fn setup_instructions(state_directory: &str) -> Value {
    let uris: Vec<String> = CALLBACK_PORTS.iter().map(|port| callback_uri(*port)).collect();
    json!({
        "step1": "Create an application at https://linear.app/settings/api/applications/new",
        "step2": format!("Register these redirect URIs on it: {}", uris.join(" ")),
        "step3": format!(
            "Write its client id to {} as {{\"linear\":{{\"clientId\":\"...\"}}}}",
            trackers(state_directory).join("oauth.json").display()
        ),
        "note": "The client secret is not needed and should not be stored: this is a public client using PKCE.",
    })
}

/// The URL a sign-in opens, and the one-time secrets it is bound to.
pub struct Started {
    pub url: String,
    pub redirect: String,
    /// Never leaves this process: the provider is sent only the challenge, and the verifier goes on
    /// the exchange to prove the same process is completing the sign-in it began.
    pub verifier: String,
    /// The callback carries no workspace credential, so this is what authorises it.
    pub state: String,
}

/// Compose a sign-in. No network: what comes back is a URL for a browser.
pub fn authorize(client_id: &str, redirect: &str, verifier: &str, state: &str) -> Started {
    let query = [
        ("client_id", client_id),
        ("redirect_uri", redirect),
        ("response_type", "code"),
        ("scope", SCOPES),
        ("state", state),
        ("code_challenge", &challenge_for(verifier)),
        ("code_challenge_method", "S256"),
    ]
    .iter()
    .map(|(name, value)| format!("{name}={}", encode(value)))
    .collect::<Vec<_>>()
    .join("&");
    Started {
        url: format!("{AUTHORIZE}?{query}"),
        redirect: redirect.to_string(),
        verifier: verifier.to_string(),
        state: state.to_string(),
    }
}

/// `encodeURIComponent`, which is what `URLSearchParams` writes.
pub fn encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(byte) {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The grant, as the provider's answer becomes it.
///
/// `expires_in` is seconds; storing the MOMENT rather than the span means a restart does not lose
/// it — a span measured from a process that is gone is a span from nothing.
pub fn grant_from(body: &Value, now_ms: i64) -> Value {
    let expires = body.get("expires_in").and_then(Value::as_i64);
    json!({
        "kind": "oauth",
        "accessToken": body.get("access_token").cloned().unwrap_or(Value::Null),
        "refreshToken": body.get("refresh_token").cloned().unwrap_or(Value::Null),
        "expiresAt": match expires {
            Some(seconds) => json!(red_core::time::iso(now_ms + seconds * 1000)),
            None => Value::Null,
        },
    })
}

/// A stored grant is JSON; a pasted personal key is a bare line. Both are valid and the difference
/// is only that one expires, so the reader accepts either rather than forcing a migration.
pub fn parse_credential(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.starts_with('{') {
        return Some(json!({ "kind": "key", "accessToken": trimmed, "refreshToken": Value::Null, "expiresAt": Value::Null }));
    }
    let value: Value = serde_json::from_str(trimmed).ok()?;
    let token = value.get("accessToken").filter(|token| !token.is_null())?;
    Some(json!({
        "kind": "oauth",
        "accessToken": token.clone(),
        "refreshToken": value.get("refreshToken").cloned().unwrap_or(Value::Null),
        "expiresAt": value.get("expiresAt").cloned().unwrap_or(Value::Null),
    }))
}

/// Is this grant close enough to expiry to refresh? An hour out, not at expiry, so an in-flight read
/// never races it.
pub fn expiring(grant: &Value, now_ms: i64) -> bool {
    if grant.get("kind").and_then(Value::as_str) != Some("oauth") {
        return false;
    }
    let Some(at) = grant.get("expiresAt").and_then(Value::as_str) else { return false };
    red_core::time::parse(at).is_some_and(|expires| expires - now_ms < REFRESH_MARGIN_MS)
}

/// Read the grant this project holds, if it holds one.
pub fn stored(state_directory: &str, project: &str) -> Option<Value> {
    let text = std::fs::read_to_string(trackers(state_directory).join(format!("{project}.token"))).ok()?;
    parse_credential(&text)
}

/// Write one. 0600, because it is a credential, and beside the workspace state because it belongs to
/// the workspace rather than to the project's checkout.
pub fn store(state_directory: &str, project: &str, grant: &Value) -> Result<(), Fail> {
    let directory = trackers(state_directory);
    std::fs::create_dir_all(&directory).map_err(|error| refuse(format!("cannot create {}: {error}", directory.display()), 500))?;
    let path = directory.join(format!("{project}.token"));
    let text = serde_json::to_string_pretty(grant).unwrap_or_default();
    write_private(&path, &text)
}

/// Drop the local grant. A token the provider still holds is revocable there, so the file is emptied
/// whether or not the revoke reached anybody.
pub fn forget(state_directory: &str, project: &str) -> Result<(), Fail> {
    let directory = trackers(state_directory);
    std::fs::create_dir_all(&directory).map_err(|error| refuse(format!("cannot create {}: {error}", directory.display()), 500))?;
    write_private(&directory.join(format!("{project}.token")), "")
}

fn write_private(path: &Path, text: &str) -> Result<(), Fail> {
    std::fs::write(path, text).map_err(|error| refuse(format!("cannot write {}: {error}", path.display()), 500))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// The form body an exchange or a refresh sends. `URLSearchParams#toString`, which is
/// `application/x-www-form-urlencoded` with `+` for a space — and there are no spaces in any of
/// these, so percent-encoding each value is the same string.
pub fn form(pairs: &[(&str, &str)]) -> String {
    pairs.iter().map(|(name, value)| format!("{name}={}", encode(value))).collect::<Vec<_>>().join("&")
}

/* --- the network half ------------------------------------------------------------------------ */

/// Exchange the code the browser came back with for a grant.
///
/// The verifier goes with it, which is what proves the same process is completing the sign-in it
/// began — the provider recomputes the challenge it was given at the start and compares.
pub fn exchange(client_id: &str, code: &str, redirect: &str, verifier: &str, now_ms: i64) -> Result<Value, Fail> {
    if code.is_empty() {
        return Err(refuse("the provider returned no code", 502));
    }
    let body = form(&[
        ("code", code),
        ("redirect_uri", redirect),
        ("client_id", client_id),
        ("code_verifier", verifier),
        ("grant_type", "authorization_code"),
    ]);
    let answer = red_core::tls::post_form(TOKEN, &body).map_err(|error| refuse(error, 502))?;
    if !answer.ok() {
        return Err(refuse(format!("the provider answered {}", answer.status), 502));
    }
    let said = answer.json().ok_or_else(|| refuse("the provider answered with no grant", 502))?;
    Ok(grant_from(&said, now_ms))
}

/// Rotate a grant before it expires.
///
/// **A failed refresh keeps the stored token rather than clearing it.** Linear consumes the old
/// refresh token and allows the original request to be replayed for thirty minutes, so a dropped
/// response must not strand a grant that is still good.
pub fn refresh(state_directory: &str, project: &str, grant: &Value, now_ms: i64) -> Value {
    let Some(client_id) = client(state_directory) else { return grant.clone() };
    let Some(token) = grant.get("refreshToken").and_then(Value::as_str).filter(|token| !token.is_empty()) else {
        return grant.clone();
    };
    let body = form(&[("refresh_token", token), ("grant_type", "refresh_token"), ("client_id", &client_id)]);
    let Ok(answer) = red_core::tls::post_form(TOKEN, &body) else { return grant.clone() };
    if !answer.ok() {
        return grant.clone();
    }
    let Some(said) = answer.json() else { return grant.clone() };
    let next = grant_from(&said, now_ms);
    if next.get("accessToken").is_none_or(Value::is_null) {
        return grant.clone();
    }
    /* The rotation brings a new refresh token; a provider that sent none leaves the old one usable. */
    let mut merged = next.as_object().cloned().unwrap_or_default();
    if merged.get("refreshToken").is_none_or(Value::is_null) {
        merged.insert("refreshToken".to_string(), grant.get("refreshToken").cloned().unwrap_or(Value::Null));
    }
    let merged = Value::Object(merged);
    let _ = store(state_directory, project, &merged);
    merged
}

/// Drop this project's grant, telling the provider if it can be reached.
///
/// The local grant goes either way: a token the provider still holds is revocable there, and a
/// sign-out that failed because a laptop was offline would be a sign-out that did not happen.
pub fn revoke(state_directory: &str, project: &str) -> Result<Value, Fail> {
    let held = stored(state_directory, project);
    if let Some(grant) = &held {
        if grant.get("kind").and_then(Value::as_str) == Some("oauth") {
            if let Some(token) = grant.get("accessToken").and_then(Value::as_str).filter(|token| !token.is_empty()) {
                let _ = red_core::tls::post_form(REVOKE, &form(&[("token", token), ("token_type_hint", "access_token")]));
            }
        }
    }
    forget(state_directory, project)?;
    Ok(json!({ "revoked": held.is_some() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> String {
        let at = std::env::temp_dir().join(format!("red-tracker-auth-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&at);
        std::fs::create_dir_all(&at).expect("a directory");
        at.to_string_lossy().to_string()
    }

    /* The challenge is recomputed by the provider from the verifier the exchange sends, so a single
       wrong character is a sign-in that fails at the very end, after the person has already agreed
       to it in a browser. The vector is RFC 7636's own. */
    #[test]
    fn the_pkce_challenge_is_the_one_the_provider_will_recompute() {
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        /* base64url, which is base64 with two characters swapped and no padding. A `+` or a `/` in a
           query string is a different value by the time it arrives. */
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(b"foob"), "Zm9vYg");
        assert_eq!(base64url(&[0xfb, 0xff, 0xbe]), "-_--", "the two characters base64url swaps");
    }

    /* The instructions a person reads and acts on. Step 2 lists every callback URI because they are
       pasted together, and step 3 names the exact file — this is the whole of the setup, and a
       person who cannot find the file has nowhere else to look. */
    #[test]
    fn the_setup_says_where_to_put_the_client_id_and_which_uris_to_register() {
        let at = scratch("setup");
        let said = setup_instructions(&at);
        assert!(said["step3"].as_str().expect("step3").contains(&format!("{at}/trackers/oauth.json")), "{}", said["step3"]);
        let step2 = said["step2"].as_str().expect("step2");
        for port in CALLBACK_PORTS {
            assert!(step2.contains(&callback_uri(port)), "{port} is missing from {step2}");
        }
        assert!(said["note"].as_str().expect("note").contains("should not be stored"),
                "a client secret is the obvious thing to store and the wrong one");
        let _ = std::fs::remove_dir_all(&at);
    }

    #[test]
    fn a_client_id_is_read_from_the_file_a_person_writes_it_to() {
        let at = scratch("client");
        assert_eq!(client(&at), None, "nothing registered yet");
        std::fs::create_dir_all(Path::new(&at).join("trackers")).expect("a directory");
        std::fs::write(Path::new(&at).join("trackers/oauth.json"), r#"{"linear":{"clientId":"client-123"}}"#).expect("written");
        assert_eq!(client(&at), Some("client-123".to_string()));
        /* Anything that is not a client id is not one: a half-written file is no application. */
        for bad in [r#"{"linear":{}}"#, r#"{"linear":{"clientId":""}}"#, "{}", "not json"] {
            std::fs::write(Path::new(&at).join("trackers/oauth.json"), bad).expect("written");
            assert_eq!(client(&at), None, "{bad}");
        }
        let _ = std::fs::remove_dir_all(&at);
    }

    /* Every parameter the provider checks, spelled the way it checks them. `scope` is comma
       separated, which is Linear's own departure, and the method is the literal `S256`. */
    #[test]
    fn the_authorize_url_carries_what_the_provider_will_check() {
        let started = authorize("client-123", &callback_uri(47821), "a-verifier", "a-state");
        assert!(started.url.starts_with(&format!("{AUTHORIZE}?")), "{}", started.url);
        for expected in [
            "client_id=client-123",
            "redirect_uri=http%3A%2F%2F127.0.0.1%3A47821%2Ftracker%2Fcallback",
            "response_type=code",
            "scope=read",
            "state=a-state",
            "code_challenge_method=S256",
            &format!("code_challenge={}", challenge_for("a-verifier")),
        ] {
            assert!(started.url.contains(expected), "{expected} missing from {}", started.url);
        }
        /* The verifier is NOT in it: the provider gets the challenge, and the verifier proves on the
           exchange that the same process is finishing the sign-in it began. */
        assert!(!started.url.contains("a-verifier"), "{}", started.url);
    }

    /* A grant stores the MOMENT it expires, not the span: a span measured from a process that is
       gone is a span from nothing. */
    #[test]
    fn a_grant_remembers_when_it_expires_rather_than_for_how_long() {
        let answered = json!({ "access_token": "at", "refresh_token": "rt", "expires_in": 3600 });
        let grant = grant_from(&answered, 1_700_000_000_000);
        assert_eq!(grant["kind"], json!("oauth"));
        assert_eq!(grant["accessToken"], json!("at"));
        assert_eq!(grant["refreshToken"], json!("rt"));
        assert_eq!(grant["expiresAt"], json!("2023-11-14T23:13:20.000Z"));
        /* A provider that named no expiry gets none invented for it. */
        let forever = grant_from(&json!({ "access_token": "at" }), 1_700_000_000_000);
        assert_eq!(forever["expiresAt"], Value::Null);
        assert_eq!(forever["refreshToken"], Value::Null);
    }

    /* Both shapes are valid and the difference is only that one expires, so the reader accepts
       either rather than forcing a person to migrate a key they pasted. */
    #[test]
    fn a_pasted_key_and_a_stored_grant_are_both_credentials() {
        let key = parse_credential("lin_api_abc123\n").expect("a key");
        assert_eq!(key["kind"], json!("key"));
        assert_eq!(key["accessToken"], json!("lin_api_abc123"));
        assert_eq!(key["expiresAt"], Value::Null, "a key does not expire");

        let grant = parse_credential(r#"{"kind":"oauth","accessToken":"at","refreshToken":"rt","expiresAt":"2030-01-01T00:00:00.000Z"}"#).expect("a grant");
        assert_eq!(grant["kind"], json!("oauth"));
        assert_eq!(grant["refreshToken"], json!("rt"));

        /* Nothing, and a document that is JSON but carries no token, are both no credential —
           distinct from a key, which is why the `{` is what decides. */
        assert_eq!(parse_credential(""), None);
        assert_eq!(parse_credential("   \n"), None);
        assert_eq!(parse_credential("{}"), None);
        assert_eq!(parse_credential("{not json"), None);
    }

    /* An hour out, not at expiry: a read already in flight must not race the refresh. */
    #[test]
    fn a_grant_is_refreshed_before_it_expires_rather_than_after() {
        let now = 1_700_000_000_000i64;
        let in_two_hours = json!({ "kind": "oauth", "expiresAt": red_core::time::iso(now + 2 * 3_600_000) });
        assert!(!expiring(&in_two_hours, now));
        let in_ten_minutes = json!({ "kind": "oauth", "expiresAt": red_core::time::iso(now + 600_000) });
        assert!(expiring(&in_ten_minutes, now));
        let gone = json!({ "kind": "oauth", "expiresAt": red_core::time::iso(now - 1) });
        assert!(expiring(&gone, now), "one that has already expired is certainly due");
        /* A pasted key never expires and is never refreshed — there is nothing to refresh it with. */
        assert!(!expiring(&json!({ "kind": "key", "expiresAt": Value::Null }), now));
        assert!(!expiring(&json!({ "kind": "oauth", "expiresAt": Value::Null }), now));
    }

    /* A credential is 0600 and lives beside the workspace state: it belongs to the workspace rather
       than to the project's checkout, which is shared and often committed. */
    #[test]
    fn a_grant_is_written_where_a_credential_belongs_and_read_back() {
        let at = scratch("store");
        let grant = json!({ "kind": "oauth", "accessToken": "at", "refreshToken": "rt", "expiresAt": Value::Null });
        store(&at, "kohai", &grant).expect("stored");
        assert_eq!(stored(&at, "kohai").expect("a grant")["accessToken"], json!("at"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(Path::new(&at).join("trackers/kohai.token")).expect("a file").permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "a credential is nobody else's to read");
        }
        /* Forgetting empties it rather than removing it: the file is where a person pasted a key,
           and a path that stops existing is a path they have to be told about again. */
        forget(&at, "kohai").expect("forgotten");
        assert_eq!(stored(&at, "kohai"), None);
        assert!(Path::new(&at).join("trackers/kohai.token").exists());
        let _ = std::fs::remove_dir_all(&at);
    }

    #[test]
    fn a_form_body_is_what_url_search_params_would_have_written() {
        assert_eq!(form(&[("grant_type", "authorization_code"), ("code", "a/b+c")]),
                   "grant_type=authorization_code&code=a%2Fb%2Bc");
    }
}
