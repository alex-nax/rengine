//! The owner's grant to relay a message into one pane (F222, spec 148).
//!
//! A grant is deliberately NOT in the token ledger. The ledger's whole semantics is transfer —
//! contest, reject, release, and take on silence (spec 095 decision 2) — and a grant that lived
//! beside it would inherit them, which is the one thing it must not do: an agent can acquire the
//! token without the owner ever acting, and that is exactly why the token alone cannot arm a relay.
//! So this is a file in the workspace state directory, written only by the command the owner's
//! confirmed dashboard action runs, and spent by the worker.
//!
//! It is not authentication and does not pretend to be. Anything running as this user can reach the
//! session host's own input route directly. What this is: scope, a bound, an audit point and a
//! revoke — the difference between a sanctioned path and a visible violation.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};

/// The largest grant that can be written at once, so a slip of the keyboard cannot arm a pane for
/// a week. Both bounds are required; neither has a default.
pub const MAX_MESSAGES: i64 = 50;
pub const MAX_MINUTES: i64 = 720;

/// One pane's grant, as it is on disk and as a refusal reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct Grant {
    pub session_id: String,
    pub remaining: i64,
    pub expires_ms: i64,
    pub granted_ms: i64,
}

impl Grant {
    pub fn as_json(&self) -> Value {
        json!({
            "sessionId": self.session_id,
            "remaining": self.remaining,
            "expires": crate::time::iso(self.expires_ms),
            "granted": crate::time::iso(self.granted_ms),
        })
    }
}

/// Why a relay may not go ahead. Each names which of the three it is, because "no grant", "spent"
/// and "expired" call for different gestures from the person reading the refusal.
#[derive(Clone, Debug, PartialEq)]
pub enum Refusal {
    None,
    Spent(i64),
    Expired(i64),
    Unreadable(String),
}

impl Refusal {
    pub fn message(&self) -> String {
        match self {
            Refusal::None => "No owner grant covers this pane. The project token is not enough on its own — it transfers to a contester on silence — so a relay is armed separately, by the person at the desktop, for one named pane. Ask them to run the workspace's grant action. Nothing was typed.".to_string(),
            Refusal::Spent(of) => format!(
                "The owner grant for this pane is spent: all {of} message(s) of it have been used. A new grant is the person at the desktop's to give. Nothing was typed."
            ),
            Refusal::Expired(at) => format!(
                "The owner grant for this pane expired at {}. A new grant is the person at the desktop's to give. Nothing was typed.",
                crate::time::iso(*at)
            ),
            Refusal::Unreadable(why) => format!("The workspace's message grants cannot be read: {why}. Nothing was typed."),
        }
    }
}

/// One writer at a time inside this process. The state directory has one worker and one launcher
/// run, so this covers the realistic contention; it is a serialiser, not a lock over the file, and
/// saying so is cheaper than implying a guarantee that is not there.
static WRITING: Mutex<()> = Mutex::new(());

pub fn path(state: &Path) -> PathBuf {
    state.join("message-grants.json")
}

fn read(state: &Path) -> Result<Vec<Grant>, String> {
    let file = path(state);
    let text = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let document: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let rows = document.get("grants").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(rows.iter().filter_map(of_json).collect())
}

fn of_json(value: &Value) -> Option<Grant> {
    let session_id = value.get("sessionId").and_then(Value::as_str)?.to_string();
    let expires_ms = value.get("expires").and_then(Value::as_str).and_then(crate::time::parse)?;
    let granted_ms = value.get("granted").and_then(Value::as_str).and_then(crate::time::parse).unwrap_or(0);
    let remaining = value.get("remaining").and_then(Value::as_i64)?;
    Some(Grant { session_id, remaining, expires_ms, granted_ms })
}

fn publish(state: &Path, grants: &[Grant]) -> Result<(), String> {
    let document = json!({ "version": 1, "grants": grants.iter().map(Grant::as_json).collect::<Vec<Value>>() });
    let file = path(state);
    let temporary = file.with_extension(format!("json.{}.tmp", std::process::id()));
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(&temporary, document.to_string()).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&temporary, &file).map_err(|error| error.to_string())
}

/// Every grant still worth showing: expired ones are dropped from the answer and from the file, so
/// a listing is what is armed right now rather than a history.
pub fn list(state: &Path, now: i64) -> Result<Vec<Grant>, String> {
    let _held = WRITING.lock().expect("grant lock");
    let all = read(state)?;
    let live: Vec<Grant> = all.iter().filter(|grant| grant.expires_ms > now && grant.remaining > 0).cloned().collect();
    if live.len() != all.len() {
        publish(state, &live)?;
    }
    Ok(live)
}

/// Arm one pane. A second grant for the same pane REPLACES the first rather than adding to it: the
/// owner's last word is the grant, and two overlapping counts for one pane would be a bound nobody
/// could read off the file.
pub fn grant(state: &Path, session_id: &str, messages: i64, minutes: i64, now: i64) -> Result<Grant, String> {
    if session_id.is_empty() {
        return Err("A grant names one pane.".to_string());
    }
    if !(1..=MAX_MESSAGES).contains(&messages) {
        return Err(format!("A grant is between 1 and {MAX_MESSAGES} messages."));
    }
    if !(1..=MAX_MINUTES).contains(&minutes) {
        return Err(format!("A grant lasts between 1 and {MAX_MINUTES} minutes."));
    }
    let _held = WRITING.lock().expect("grant lock");
    let mut grants: Vec<Grant> = read(state)?
        .into_iter()
        .filter(|grant| grant.session_id != session_id && grant.expires_ms > now && grant.remaining > 0)
        .collect();
    let written = Grant { session_id: session_id.to_string(), remaining: messages, expires_ms: now + minutes * 60_000, granted_ms: now };
    grants.push(written.clone());
    publish(state, &grants)?;
    Ok(written)
}

/// Take it back. `true` when one was there to take.
pub fn revoke(state: &Path, session_id: &str) -> Result<bool, String> {
    let _held = WRITING.lock().expect("grant lock");
    let all = read(state)?;
    let kept: Vec<Grant> = all.iter().filter(|grant| grant.session_id != session_id).cloned().collect();
    let removed = kept.len() != all.len();
    if removed {
        publish(state, &kept)?;
    }
    Ok(removed)
}

/// Is this pane armed right now? Everything [`spend`] refuses, without taking anything.
///
/// Separate from spending because the order matters: a caller checks BEFORE it types and spends
/// AFTER, so a refusal that never typed anything never costs the owner one of their messages.
pub fn check(state: &Path, session_id: &str, now: i64) -> Result<Grant, Refusal> {
    let all = read(state).map_err(Refusal::Unreadable)?;
    let Some(found) = all.into_iter().find(|grant| grant.session_id == session_id) else {
        return Err(Refusal::None);
    };
    if found.expires_ms <= now {
        return Err(Refusal::Expired(found.expires_ms));
    }
    if found.remaining <= 0 {
        return Err(Refusal::Spent(0));
    }
    Ok(found)
}

/// Spend one message of this pane's grant, and answer what is left.
///
/// Spent for the ATTEMPT, not for the outcome: a paste nothing echoed still typed into somebody's
/// pane, and a bound that only counted successes would let an unbounded number of those through.
pub fn spend(state: &Path, session_id: &str, now: i64) -> Result<Grant, Refusal> {
    let _held = WRITING.lock().expect("grant lock");
    let all = read(state).map_err(Refusal::Unreadable)?;
    let found = check(state, session_id, now)?;
    let left = Grant { remaining: found.remaining - 1, ..found };
    let kept: Vec<Grant> = all
        .iter()
        .filter(|grant| grant.session_id != session_id)
        .cloned()
        .chain(std::iter::once(left.clone()))
        .collect();
    publish(state, &kept).map_err(Refusal::Unreadable)?;
    Ok(left)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("rengine-grants-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("a scratch directory");
        directory
    }

    #[test]
    fn a_pane_with_no_grant_is_refused_by_that_name() {
        let state = scratch("none");
        assert_eq!(spend(&state, "pane", 1_000), Err(Refusal::None));
        assert!(Refusal::None.message().contains("transfers to a contester on silence"));
        let _ = std::fs::remove_dir_all(&state);
    }

    /// The bound is a bound: the count runs out and the pane goes back to being unarmed.
    #[test]
    fn a_grant_is_spent_down_and_then_refused() {
        let state = scratch("spend");
        grant(&state, "pane", 2, 10, 1_000).expect("granted");
        assert_eq!(spend(&state, "pane", 1_100).expect("first").remaining, 1);
        assert_eq!(spend(&state, "pane", 1_200).expect("second").remaining, 0);
        assert_eq!(spend(&state, "pane", 1_300), Err(Refusal::Spent(0)));
        let _ = std::fs::remove_dir_all(&state);
    }

    #[test]
    fn a_grant_expires_on_its_own_clock_and_names_when() {
        let state = scratch("expiry");
        let written = grant(&state, "pane", 5, 1, 1_000).expect("granted");
        assert_eq!(written.expires_ms, 61_000);
        assert_eq!(spend(&state, "pane", 61_000), Err(Refusal::Expired(61_000)));
        assert!(Refusal::Expired(61_000).message().contains("1970-01-01T00:01:01.000Z"));
        let _ = std::fs::remove_dir_all(&state);
    }

    /// The scope: a grant names ONE pane and does nothing for any other.
    /* The order the route relies on: a check that refuses costs nothing, so every refusal that
       typed nothing leaves the owner's count where it was. */
    #[test]
    fn checking_refuses_everything_spending_does_and_takes_nothing() {
        let state = scratch("check");
        assert_eq!(check(&state, "pane", 1_000), Err(Refusal::None));
        grant(&state, "pane", 1, 10, 1_000).expect("granted");
        assert_eq!(check(&state, "pane", 1_100).expect("armed").remaining, 1);
        assert_eq!(check(&state, "pane", 1_100).expect("still armed").remaining, 1, "checking twice costs nothing");
        assert_eq!(check(&state, "pane", 700_000), Err(Refusal::Expired(601_000)));
        let _ = std::fs::remove_dir_all(&state);
    }

    #[test]
    fn a_grant_for_one_pane_does_not_serve_another() {
        let state = scratch("scope");
        grant(&state, "pane-a", 5, 10, 1_000).expect("granted");
        assert!(spend(&state, "pane-b", 1_100).is_err());
        assert!(spend(&state, "pane-a", 1_100).is_ok());
        let _ = std::fs::remove_dir_all(&state);
    }

    #[test]
    fn a_revoke_leaves_nothing_behind_and_a_second_grant_replaces_rather_than_adds() {
        let state = scratch("revoke");
        grant(&state, "pane", 5, 10, 1_000).expect("granted");
        grant(&state, "pane", 2, 10, 1_000).expect("regranted");
        assert_eq!(list(&state, 1_100).expect("listed").len(), 1, "one pane, one grant");
        assert_eq!(list(&state, 1_100).expect("listed")[0].remaining, 2, "the owner's last word is the grant");
        assert!(revoke(&state, "pane").expect("revoked"));
        assert_eq!(spend(&state, "pane", 1_100), Err(Refusal::None));
        assert!(!revoke(&state, "pane").expect("nothing to revoke"));
        let _ = std::fs::remove_dir_all(&state);
    }

    #[test]
    fn the_bounds_are_both_required_and_both_capped() {
        let state = scratch("bounds");
        assert!(grant(&state, "pane", 0, 10, 0).is_err());
        assert!(grant(&state, "pane", MAX_MESSAGES + 1, 10, 0).is_err());
        assert!(grant(&state, "pane", 1, 0, 0).is_err());
        assert!(grant(&state, "pane", 1, MAX_MINUTES + 1, 0).is_err());
        assert!(grant(&state, "", 1, 10, 0).is_err());
        assert!(!path(&state).exists(), "a refused grant writes nothing");
        let _ = std::fs::remove_dir_all(&state);
    }
}
