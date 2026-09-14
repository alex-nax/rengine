//! red-token: the project token ledger and its lifecycle feed (F157, spec 132; specs 095/101/103).
//!
//! The token is arbitration among cooperating agents, never an access boundary: every participant
//! already holds the workspace capability, so an identity on the wire is taken at its word. What
//! this crate owes its callers is that the arbitration is *exactly* what the JavaScript did — a
//! refusal whose wording changed, a cooldown charged to the wrong contest, a deadline that re-times
//! when a preference changes, or a holder that reads as gone because liveness followed the process
//! rather than the session are each a silent correctness bug in the one mechanism the workspace has
//! for keeping agents out of each other's way.
//!
//! So the port is judged against a transcript recorded from the JavaScript while it still existed
//! (`orchestrator/tests/token-transcript.json`): forty steps of one state machine, each step's
//! answer, the status it leaves and both files on disk at the end. `red-token-replay` is the judge.
//!
//! Key order is part of that record. Objects here are built in the order the JavaScript built them,
//! and `serde_json`'s `preserve_order` keeps it, because the transcript compares the bytes.

pub mod feed;
pub mod ledger;
pub mod tokens;

use std::sync::Arc;

use serde_json::{json, Value};

/// The clock, the mint, the liveness test and the window preference all arrive as data — the same
/// seam `agent_pane_composition` takes, and the reason two implementations of this state machine
/// can be compared at all.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type Mint = Arc<dyn Fn() -> String + Send + Sync>;
pub type Alive = Arc<dyn Fn(i64) -> bool + Send + Sync>;
pub type Window = Arc<dyn Fn() -> i64 + Send + Sync>;

pub const DEFAULT_WINDOW_MS: i64 = 60_000;
pub const MIN_WINDOW_MS: i64 = 250;
pub const MAX_WINDOW_MS: i64 = 60 * 60 * 1000;

/// A refusal a caller acts on: the message it shows a person, and the status its route answers.
#[derive(Debug, Clone)]
pub struct Refused {
    pub message: String,
    pub status: Option<u16>,
}

pub fn refuse(message: impl Into<String>, status: u16) -> Refused {
    Refused { message: message.into(), status: Some(status) }
}

/// Whatever the caller put on the wire, cut to printable ASCII and bounded. After the strip every
/// character is one UTF-16 unit, so the limit means the same thing on both sides.
pub fn printable(value: Option<&str>, limit: usize) -> String {
    value
        .unwrap_or_default()
        .chars()
        .filter(|character| (' '..='~').contains(character))
        .take(limit)
        .collect()
}

/// `/^[0-9a-f-]{36}$/` — the ledger's own test, which is looser than a UUID grammar on purpose:
/// it is the shape the JavaScript accepted and the shape a stored id has to keep passing.
pub fn uuid_shaped(value: &str) -> bool {
    value.chars().count() == 36 && value.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c) || c == '-')
}

pub fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the operating system answers randomness");
    bytes[6] = bytes[6] & 0x0f | 0x40;
    bytes[8] = bytes[8] & 0x3f | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

/// An identity as it arrives: the agent's session id, its label, and the process running it now.
#[derive(Debug, Clone, PartialEq)]
pub struct Identity {
    pub agent_id: String,
    pub label: String,
    pub pid: Option<i64>,
}

impl Identity {
    /// What `readIdentity` reads off the X-Rengine-Agent family. An id that is not the ledger's
    /// shape is no identity at all, which is what makes the desktop's header-less request the
    /// desktop's rather than a nameless agent's.
    pub fn from_headers(headers: &Value) -> Option<Identity> {
        let header = |name: &str| headers.get(name).and_then(Value::as_str);
        let agent_id = header("x-rengine-agent")?;
        if !uuid_shaped(agent_id) {
            return None;
        }
        let label = printable(header("x-rengine-agent-label"), 64);
        /* `Number(header)` then `Number.isSafeInteger(pid) && pid > 0`: a header that is not a whole
           positive number carries no process, and the holder is then never read as gone. */
        let pid = header("x-rengine-agent-pid")
            .and_then(|text| text.trim().parse::<f64>().ok())
            .filter(|value| value.fract() == 0.0 && *value > 0.0 && value.abs() <= 9_007_199_254_740_991.0)
            .map(|value| value as i64);
        Some(Identity { agent_id: agent_id.to_string(), label: if label.is_empty() { "agent".into() } else { label }, pid })
    }

    pub fn from_value(value: &Value) -> Option<Identity> {
        let agent_id = value.get("agentId").and_then(Value::as_str)?;
        Some(Identity {
            agent_id: agent_id.to_string(),
            label: value.get("label").and_then(Value::as_str).unwrap_or_default().to_string(),
            pid: value.get("pid").and_then(Value::as_i64),
        })
    }
}

/// The desktop a retired workspace worker acts for, from X-Rengine-Desktop. Same domain as the
/// agent header and the same disclaimer: loopback arbitration, never an access boundary.
pub fn read_desktop(headers: &Value) -> Option<String> {
    let named = printable(headers.get("x-rengine-desktop").and_then(Value::as_str), 64);
    if named.is_empty() {
        None
    } else {
        Some(named)
    }
}

/// Who holds the token, as the ledger stores it.
#[derive(Debug, Clone, PartialEq)]
pub struct Holder {
    pub agent_id: String,
    pub label: String,
    pub pid: Option<i64>,
    pub since: String,
}

impl Holder {
    pub fn to_json(&self) -> Value {
        let mut out = serde_json::Map::new();
        out.insert("agentId".into(), json!(self.agent_id));
        out.insert("label".into(), json!(self.label));
        /* `{ ...contester, since }`: the pid, when there is one, sits where the contester put it —
           before the stamp the spread appended. */
        if let Some(pid) = self.pid {
            out.insert("pid".into(), json!(pid));
        }
        out.insert("since".into(), json!(self.since));
        Value::Object(out)
    }

    pub fn from_json(value: &Value) -> Option<Holder> {
        let object = value.as_object()?;
        Some(Holder {
            agent_id: object.get("agentId").and_then(Value::as_str).unwrap_or_default().to_string(),
            label: object.get("label").and_then(Value::as_str).unwrap_or_default().to_string(),
            pid: object.get("pid").and_then(Value::as_i64),
            since: object.get("since").and_then(Value::as_str).unwrap_or_default().to_string(),
        })
    }
}

/// The agent that opened a contest, carried on the contest and used to build the holder it becomes.
#[derive(Debug, Clone, PartialEq)]
pub struct Contester {
    pub agent_id: String,
    pub label: String,
    pub pid: Option<i64>,
}

impl Contester {
    pub fn to_json(&self) -> Value {
        let mut out = serde_json::Map::new();
        out.insert("agentId".into(), json!(self.agent_id));
        out.insert("label".into(), json!(self.label));
        if let Some(pid) = self.pid {
            out.insert("pid".into(), json!(pid));
        }
        Value::Object(out)
    }

    pub fn from_json(value: &Value) -> Option<Contester> {
        let object = value.as_object()?;
        Some(Contester {
            agent_id: object.get("agentId").and_then(Value::as_str).unwrap_or_default().to_string(),
            label: object.get("label").and_then(Value::as_str).unwrap_or_default().to_string(),
            pid: object.get("pid").and_then(Value::as_i64),
        })
    }

    /// The holder this contester becomes at `at`.
    pub fn holding(&self, at: &str) -> Holder {
        Holder { agent_id: self.agent_id.clone(), label: self.label.clone(), pid: self.pid, since: at.to_string() }
    }
}

impl From<&Identity> for Contester {
    fn from(identity: &Identity) -> Contester {
        Contester { agent_id: identity.agent_id.clone(), label: identity.label.clone(), pid: identity.pid }
    }
}

/// One open contest. The window it was opened under travels with it, so changing the preference
/// re-times nothing and a rejection costs the window the contest actually ran on.
#[derive(Debug, Clone, PartialEq)]
pub struct Contest {
    pub id: String,
    pub contester: Contester,
    pub opened_at: String,
    pub window_ms: Option<i64>,
    pub deadline: String,
    pub reason: String,
}

impl Contest {
    pub fn to_json(&self) -> Value {
        let mut out = serde_json::Map::new();
        out.insert("id".into(), json!(self.id));
        out.insert("contester".into(), self.contester.to_json());
        out.insert("openedAt".into(), json!(self.opened_at));
        /* Always present on a contest this code opened; absent on one restored from a ledger
           written before the window travelled with the contest, and absent is what that file said. */
        if let Some(window_ms) = self.window_ms {
            out.insert("windowMs".into(), json!(window_ms));
        }
        out.insert("deadline".into(), json!(self.deadline));
        out.insert("reason".into(), json!(self.reason));
        Value::Object(out)
    }

    pub fn from_json(value: &Value) -> Option<Contest> {
        let object = value.as_object()?;
        Some(Contest {
            id: object.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
            contester: object.get("contester").and_then(Contester::from_json)?,
            opened_at: object.get("openedAt").and_then(Value::as_str).unwrap_or_default().to_string(),
            window_ms: object.get("windowMs").and_then(Value::as_i64),
            deadline: object.get("deadline").and_then(Value::as_str).unwrap_or_default().to_string(),
            reason: object.get("reason").and_then(Value::as_str).unwrap_or_default().to_string(),
        })
    }
}

/// An agent the ledger has met, and when.
#[derive(Debug, Clone, PartialEq)]
pub struct Known {
    pub agent_id: String,
    pub label: String,
    pub pid: Option<i64>,
    pub first_seen_at: String,
    pub last_seen_at: String,
}

impl Known {
    pub fn to_json(&self) -> Value {
        let mut out = serde_json::Map::new();
        out.insert("agentId".into(), json!(self.agent_id));
        out.insert("label".into(), json!(self.label));
        if let Some(pid) = self.pid {
            out.insert("pid".into(), json!(pid));
        }
        out.insert("firstSeenAt".into(), json!(self.first_seen_at));
        out.insert("lastSeenAt".into(), json!(self.last_seen_at));
        Value::Object(out)
    }

    pub fn from_json(value: &Value) -> Option<Known> {
        let object = value.as_object()?;
        Some(Known {
            agent_id: object.get("agentId").and_then(Value::as_str).unwrap_or_default().to_string(),
            label: object.get("label").and_then(Value::as_str).unwrap_or_default().to_string(),
            pid: object.get("pid").and_then(Value::as_i64),
            first_seen_at: object.get("firstSeenAt").and_then(Value::as_str).unwrap_or_default().to_string(),
            last_seen_at: object.get("lastSeenAt").and_then(Value::as_str).unwrap_or_default().to_string(),
        })
    }
}

/// The frame the native status-bar segment reads, pinned flat rather than as the agent-facing
/// status object, so the worker that owns the ledger and a retired worker relaying it put the same
/// bytes on the desktop's socket.
pub fn segment_frame(status: &Value) -> Value {
    let contest = status.get("contest").filter(|value| !value.is_null());
    let field = |name: &str| contest.and_then(|value| value.get(name)).cloned().unwrap_or(Value::Null);
    json!({
        "type": "token",
        "rootId": status.get("rootId").cloned().unwrap_or(Value::Null),
        "holder": status.get("holder").cloned().unwrap_or(Value::Null),
        "contest": match contest {
            Some(_) => json!({
                "id": field("id"),
                "contester": field("contester"),
                "openedAt": field("openedAt"),
                "deadline": field("deadline"),
                "reason": match field("reason") { Value::Null => json!(""), other => other },
            }),
            None => Value::Null,
        },
        "windowMs": status.get("window").cloned().unwrap_or(Value::Null),
        "sequence": status.get("tokenSequence").cloned().unwrap_or(Value::Null),
    })
}

/// `${Math.max(0, Math.round(ms / 1000))}s`.
pub fn seconds(millis: i64) -> String {
    format!("{}s", red_core::time::seconds_from(millis))
}

/// How long ago a stamp was, in the words a refusal uses.
pub fn elapsed(since: &str, now: i64) -> String {
    let Some(parsed) = red_core::time::parse(since) else { return "an unknown time".into() };
    let millis = now - parsed;
    if millis < 0 {
        return "an unknown time".into();
    }
    let total = red_core::time::js_round(millis as f64 / 1000.0) as i64;
    if total < 60 {
        format!("{total}s")
    } else {
        format!("{}m {}s", total / 60, total % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_identity_is_the_shape_the_ledger_accepts() {
        let headers = json!({ "x-rengine-agent": "11111111-1111-4111-8111-111111111111", "x-rengine-agent-label": "claude aaaa", "x-rengine-agent-pid": "4001" });
        let identity = Identity::from_headers(&headers).expect("an identity");
        assert_eq!(identity.pid, Some(4001));
        assert_eq!(identity.label, "claude aaaa");
        assert!(Identity::from_headers(&json!({ "x-rengine-agent": "nope" })).is_none());
        /* No label is "agent", not the empty string: the refusal prints it. */
        assert_eq!(Identity::from_headers(&json!({ "x-rengine-agent": "11111111-1111-4111-8111-111111111111" })).unwrap().label, "agent");
    }

    #[test]
    fn a_label_is_printable_ascii_and_bounded() {
        assert_eq!(printable(Some("claude\u{7} aaaa"), 64), "claude aaaa");
        assert_eq!(printable(Some(&"x".repeat(80)), 64).len(), 64);
        assert_eq!(printable(Some("héllo"), 64), "hllo");
    }

    /// The elapsed wording a refusal carries, minute by minute.
    #[test]
    fn elapsed_reads_the_way_the_refusal_prints_it() {
        let since = "2026-09-14T12:00:00.000Z";
        let base = red_core::time::parse(since).unwrap();
        assert_eq!(elapsed(since, base), "0s");
        assert_eq!(elapsed(since, base + 59_000), "59s");
        assert_eq!(elapsed(since, base + 61_000), "1m 1s");
        assert_eq!(elapsed(since, base - 1), "an unknown time");
        assert_eq!(elapsed("nonsense", base), "an unknown time");
    }
}
