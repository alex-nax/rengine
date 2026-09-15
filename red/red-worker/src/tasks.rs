//! What a task write and a spawn decide before anything happens (F158, spec 129; spec 103).
//!
//! Both routes are the same shape: the token gate, then one write at a time per project, then the
//! project's own command, then a feed frame. What is decided HERE is the part that is neither the
//! gate's nor `red_project`'s — which row a caller named, what the gate is asked about, what the
//! feed is told, and the ordering that keeps two holders from interleaving.
//!
//! **The serialisation is behind the gate, not instead of it.** A caller that does not hold the
//! token is refused before it reaches the queue, so a refusal never waits behind somebody else's
//! write; two holders in sequence queue rather than interleave. A write that fails still releases
//! the queue, so one project's failure never wedges the next call.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct Refused {
    pub message: String,
    pub status: u16,
}

/// The tracker row a caller named, out of the tracker's own list.
///
/// A key or an id, because the two tracker providers disagree about which one a person quotes. The
/// refusal names what to do next rather than only what went wrong: a caller here is usually an
/// agent, and "list_tasks names the keys it has" is the difference between it recovering and it
/// guessing again.
pub fn row_of(listed: &Value, key: Option<&Value>) -> Result<Value, Refused> {
    let refusal = || Refused {
        message: format!(
            "No task {} is in this project's tracker; list_tasks names the keys it has. Nothing was started.",
            match key {
                Some(value) => value.to_string(),
                None => "undefined".to_string(),
            }
        ),
        status: 404,
    };
    /* A caller that named nothing matched a row with no id in the JavaScript, because `String(a) ===
       String(b)` is true when both are undefined. That is not reproduced: a row matched by two
       absent values is not the row anybody meant, and this one reaches a process launch. */
    let Some(key) = key.filter(|value| !value.is_null()) else { return Err(refusal()) };
    let text = |value: &Value| value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string());
    let wanted = text(key);
    listed
        .get("rows")
        .and_then(Value::as_array)
        .and_then(|rows| {
            rows.iter().find(|row| {
                row.get("key") == Some(key) || row.get("id").is_some_and(|id| text(id) == wanted)
            })
        })
        .cloned()
        .ok_or_else(refusal)
}

/// What the gate is asked about, which is what a refusal names back to the caller.
pub fn tool_of(action: Option<&str>) -> String {
    format!("task_{}", action.filter(|name| !name.is_empty()).unwrap_or("write"))
}

/// What the feed is told a write did. Anything that is not an update added something, which is the
/// JavaScript's reading and the safe one: a frame that claimed an update where a row appeared would
/// have a reader looking for a change that is not there.
pub fn frame_of(action: Option<&str>) -> &'static str {
    if action == Some("update") {
        "task.updated"
    } else {
        "task.added"
    }
}

/// One write at a time per project.
///
/// Per ROOT rather than per worker: two projects in one workspace have nothing to serialise against
/// each other, and a workspace where a slow write in one blocked the other would be a workspace
/// that got slower as it got more useful.
#[derive(Default)]
pub struct Writes {
    per_root: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Writes {
    pub fn new() -> Writes {
        Writes::default()
    }

    /// The lock for one project, taken for as long as the guard lives. A caller that panics with it
    /// held poisons it, and the next caller takes it anyway — a queue that stayed shut after one
    /// failure would wedge the project rather than fail the call.
    pub fn of(&self, root_id: &str) -> Arc<Mutex<()>> {
        let mut held = self.per_root.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        held.entry(root_id.to_string()).or_default().clone()
    }

    pub fn taken(lock: &Arc<Mutex<()>>) -> MutexGuard<'_, ()> {
        lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tracker() -> Value {
        json!({ "rows": [
            { "key": "F158", "id": 412, "title": "red-worker" },
            { "key": "KI-119", "id": "KI-119", "title": "the token contest flake" },
            { "id": 77, "title": "a row its provider gives no key" },
        ] })
    }

    #[test]
    fn a_row_is_found_by_the_key_or_the_id_a_person_quotes() {
        assert_eq!(row_of(&tracker(), Some(&json!("F158"))).expect("a row")["title"], json!("red-worker"));
        /* An id as the number it is, and as the text a person typed: the two providers disagree
           about which one a caller quotes, and both reach here. */
        assert_eq!(row_of(&tracker(), Some(&json!(412))).expect("a row")["key"], json!("F158"));
        assert_eq!(row_of(&tracker(), Some(&json!("412"))).expect("a row")["key"], json!("F158"));
        assert_eq!(row_of(&tracker(), Some(&json!(77))).expect("a row")["title"], json!("a row its provider gives no key"));
        assert_eq!(row_of(&tracker(), Some(&json!("KI-119"))).expect("a row")["id"], json!("KI-119"));
    }

    /* The refusal names what to do next rather than only what went wrong: the caller is usually an
       agent, and this is the difference between it recovering and it guessing again. */
    #[test]
    fn a_task_nobody_has_is_refused_by_name_with_nothing_started() {
        let refused = row_of(&tracker(), Some(&json!("F999"))).expect_err("refused");
        assert_eq!(refused.status, 404);
        assert!(refused.message.contains("\"F999\""), "{}", refused.message);
        assert!(refused.message.contains("list_tasks names the keys it has"), "it says how to recover");
        assert!(refused.message.ends_with("Nothing was started."), "and that there is nothing to undo");

        /* An empty tracker, and one that answered without rows at all. */
        assert!(row_of(&json!({ "rows": [] }), Some(&json!("F158"))).is_err());
        assert!(row_of(&json!({}), Some(&json!("F158"))).is_err());
    }

    /* A caller that named nothing matched a row with no id in the JavaScript, because `String(a) ===
       String(b)` is true when both are undefined. This route reaches a process launch, so a row
       matched by two absent values is refused instead. */
    #[test]
    fn naming_no_task_never_matches_a_row_that_names_none_either() {
        for (nothing, named) in [(None, "undefined"), (Some(&Value::Null), "null")] {
            let refused = row_of(&tracker(), nothing).expect_err("refused");
            assert_eq!(refused.status, 404);
            /* Quoted back as the caller sent it, which is how it learns the field never arrived:
               `JSON.stringify(undefined)` is undefined and `JSON.stringify(null)` is "null", and
               a person reading the two can tell an absent field from an explicit nothing. */
            assert!(refused.message.starts_with(&format!("No task {named} is")), "{}", refused.message);
        }
    }

    #[test]
    fn the_gate_is_asked_about_the_action_and_the_feed_is_told_what_happened() {
        assert_eq!(tool_of(Some("update")), "task_update");
        assert_eq!(tool_of(Some("add")), "task_add");
        assert_eq!(tool_of(None), "task_write", "a write nobody named is still a write");
        assert_eq!(tool_of(Some("")), "task_write");
        assert_eq!(frame_of(Some("update")), "task.updated");
        assert_eq!(frame_of(Some("add")), "task.added");
        assert_eq!(frame_of(None), "task.added");
    }

    /* Per ROOT: two projects in one workspace have nothing to serialise against each other. */
    #[test]
    fn one_write_at_a_time_per_project_and_never_across_them() {
        let writes = Writes::new();
        let one = writes.of("root-1");
        let held = Writes::taken(&one);
        /* The same project's lock is the same lock, and is held. */
        assert!(writes.of("root-1").try_lock().is_err(), "a second write on this project waits");
        /* Another project's is its own, and is free. */
        assert!(writes.of("root-2").try_lock().is_ok(), "and never waits on the first");
        drop(held);
        assert!(writes.of("root-1").try_lock().is_ok(), "released when the write finishes");
    }

    /* A write that fails still releases the queue: one project's failure never wedges the next
       call, which is what the JavaScript's `.then(run, run)` bought. */
    #[test]
    fn a_write_that_panics_does_not_wedge_the_project() {
        let writes = Arc::new(Writes::new());
        let lock = writes.of("root-1");
        let elsewhere = {
            let lock = lock.clone();
            std::thread::spawn(move || {
                let _held = Writes::taken(&lock);
                panic!("a write that failed");
            })
        };
        assert!(elsewhere.join().is_err(), "it did fail");
        let _next = Writes::taken(&lock);
    }
}
