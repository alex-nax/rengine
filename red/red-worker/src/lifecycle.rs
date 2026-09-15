//! What a worker says about itself and about the workspace it fronts (F158, spec 129; spec 095).
//!
//! Two things, and both are about a caller being able to NAME what it is looking at.
//!
//! **The generation**, announced once per worker process on the first request that is not a health
//! or state probe. A candidate the supervisor prepares and then discards only ever answers those
//! two, so a worker that never served anybody never claims a generation — and the layered update
//! above reads the feed for exactly this frame to know a new worker took over.
//!
//! **The conversations**, folded into the token's identity list. The ledger learns an agentId only
//! from a header on the wire, so a lane that has not called anything yet is invisible to
//! `token_status` and un-nameable. The conversations this project remembers (spec 097) are
//! identities this root already has: never minted, never overriding one the ledger has actually
//! seen, and marked so a reader can tell the two apart.

use serde_json::{json, Value};

/// Is this request one a worker should announce itself on?
///
/// `/health` and `/api/state` are what a supervisor probes a candidate with before it decides
/// whether to keep it. Announcing on either would have every discarded candidate claim a
/// generation, and the layer above would see a workspace that had been replaced several times over
/// by workers that never served a single caller.
pub fn announces(method: &str, path: &str) -> bool {
    !matches!((method, path), (_, "/health") | ("GET", "/api/state"))
}

/// `String(value ?? 'agent')` with the unprintable removed and bounded: a label reaches a terminal
/// that draws it and a feed frame that is stored.
fn printable(value: Option<&str>) -> String {
    let kept: String = value.unwrap_or("agent").chars().filter(|c| (' '..='~').contains(c)).take(32).collect();
    if kept.is_empty() {
        "agent".to_string()
    } else {
        kept
    }
}

/// The ledger's status with this project's remembered conversations folded in.
///
/// An id the ledger has already seen is never overridden — what the ledger saw on the wire is the
/// better record — and one that comes from a conversation is marked, so a reader can tell an agent
/// that has actually called something from one that merely exists.
pub fn with_conversations(status: &Value, conversations: &Value, uuid_shaped: impl Fn(&str) -> bool) -> Value {
    let empty = Vec::new();
    let listed = conversations.as_array().unwrap_or(&empty);
    if listed.is_empty() {
        return status.clone();
    }
    let known: Vec<String> = status
        .get("identities")
        .and_then(Value::as_array)
        .map(|items| {
            items.iter().filter_map(|item| item.get("agentId").and_then(Value::as_str).map(str::to_string)).collect()
        })
        .unwrap_or_default();
    let mut seen = known.clone();
    let mut extra = Vec::new();
    for entry in listed {
        let Some(id) = entry.get("id").and_then(Value::as_str) else { continue };
        if !uuid_shaped(id) || seen.iter().any(|held| held == id) {
            continue;
        }
        seen.push(id.to_string());
        extra.push(json!({
            "agentId": id,
            "label": format!("{} {}", printable(entry.get("agent").and_then(Value::as_str)), &id[..id.len().min(8)]),
            "firstSeenAt": iso(entry.get("startedAt")),
            "lastSeenAt": iso(entry.get("lastSeenAt")),
            "conversation": true,
        }));
    }
    if extra.is_empty() {
        return status.clone();
    }
    let mut out = status.as_object().cloned().unwrap_or_default();
    let mut identities = status.get("identities").and_then(Value::as_array).cloned().unwrap_or_default();
    identities.extend(extra);
    out.insert("identities".to_string(), Value::Array(identities));
    Value::Object(out)
}

/// `new Date(value).toISOString()`, and `new Date()` for anything that is not a finite number —
/// which is the JavaScript's own fallback and means "we do not know, so: now".
fn iso(value: Option<&Value>) -> Value {
    let millis = value.and_then(Value::as_i64).unwrap_or_else(now_ms);
    json!(red_core::time::iso(millis))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uuid(value: &str) -> bool {
        value.len() == 36 && value.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    }

    /* A candidate the supervisor prepares and then discards only ever answers these two. A worker
       that claimed a generation on either would have the layer above watching a workspace get
       replaced over and over by workers that never served a single caller. */
    #[test]
    fn a_worker_nobody_used_never_claims_a_generation() {
        assert!(!announces("GET", "/health"));
        assert!(!announces("POST", "/health"));
        assert!(!announces("GET", "/api/state"));
        /* Everything a person or an agent actually asks for. */
        assert!(announces("GET", "/api/feed"));
        assert!(announces("GET", "/api/token"));
        assert!(announces("POST", "/api/task"));
        assert!(announces("POST", "/api/state"), "a write is not a probe");
    }

    const SEEN: &str = "11111111-1111-1111-1111-111111111111";
    const ONLY_REMEMBERED: &str = "22222222-2222-2222-2222-222222222222";

    /* The ledger learns an agentId only from a header on the wire, so a lane that has not called
       anything yet is invisible to token_status and un-nameable. */
    #[test]
    fn a_conversation_this_project_remembers_is_an_identity_it_can_name() {
        let status = serde_json::json!({ "identities": [{ "agentId": SEEN, "label": "on the wire" }] });
        let conversations = serde_json::json!([
            { "id": SEEN, "agent": "one-the-ledger-met", "startedAt": 1_700_000_000_000i64 },
            { "id": ONLY_REMEMBERED, "agent": "afresh", "startedAt": 1_700_000_000_000i64, "lastSeenAt": 1_700_000_060_000i64 },
        ]);
        let folded = with_conversations(&status, &conversations, uuid);
        let identities = folded["identities"].as_array().expect("identities");
        assert_eq!(identities.len(), 2, "one added, and the one already known not doubled");
        /* What the ledger SAW is the better record and is never overridden by what is remembered. */
        assert_eq!(identities[0]["label"], serde_json::json!("on the wire"));
        assert_eq!(identities[0].get("conversation"), None);
        assert_eq!(identities[1]["agentId"], serde_json::json!(ONLY_REMEMBERED));
        assert_eq!(identities[1]["label"], serde_json::json!("afresh 22222222"));
        assert_eq!(identities[1]["conversation"], serde_json::json!(true),
                   "marked, so a reader can tell one that has called something from one that merely exists");
        assert_eq!(identities[1]["firstSeenAt"], serde_json::json!("2023-11-14T22:13:20.000Z"));
        assert_eq!(identities[1]["lastSeenAt"], serde_json::json!("2023-11-14T22:14:20.000Z"));
    }

    #[test]
    fn a_conversation_that_is_not_an_identity_is_not_folded_in() {
        let status = serde_json::json!({ "identities": [] });
        let conversations = serde_json::json!([{ "id": "not-a-uuid", "agent": "x" }, { "agent": "no id at all" }]);
        assert_eq!(with_conversations(&status, &conversations, uuid), status, "nothing was invented");
        /* And a project that remembers none is answered unchanged, object for object. */
        assert_eq!(with_conversations(&status, &serde_json::json!([]), uuid), status);
        assert_eq!(with_conversations(&status, &serde_json::Value::Null, uuid), status);
    }

    /* A label reaches a terminal that draws it and a feed frame that is stored. */
    #[test]
    fn a_remembered_name_is_bounded_and_printable_like_every_other() {
        let status = serde_json::json!({ "identities": [] });
        let noisy = serde_json::json!([{ "id": ONLY_REMEMBERED, "agent": "a\u{7}b\u{1b}[31m" }]);
        let folded = with_conversations(&status, &noisy, uuid);
        assert_eq!(folded["identities"][0]["label"], serde_json::json!("ab[31m 22222222"));
        let long = serde_json::json!([{ "id": ONLY_REMEMBERED, "agent": "x".repeat(200) }]);
        let folded = with_conversations(&status, &long, uuid);
        let label = folded["identities"][0]["label"].as_str().expect("a label");
        assert_eq!(label.len(), 32 + 1 + 8);
        /* A conversation with no agent recorded is still nameable, rather than named nothing. */
        let anonymous = serde_json::json!([{ "id": ONLY_REMEMBERED }]);
        let folded = with_conversations(&status, &anonymous, uuid);
        assert_eq!(folded["identities"][0]["label"], serde_json::json!("agent 22222222"));
    }
}
