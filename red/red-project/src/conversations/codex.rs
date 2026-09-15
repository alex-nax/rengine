//! codex's conversation store (F210, spec 140).
//!
//! The expensive adapter, and the reason the whole listing is on demand: the tree is partitioned by
//! DATE rather than by project, so "which of these belong to this root" cannot be answered without
//! opening the head of every candidate.

use std::fs;
use std::path::Path;

use serde_json::Value;

use super::{answer, detailed, head_text, modified_ms, one_line, EXCERPT_CHARS};

/// How far into a rollout the `cwd` search reads. It is written in the opening records.
const CWD_SCAN_BYTES: u64 = 32 * 1024;
/// How far in the TITLE search reads. Far more than the cwd needs: the opening `world_state` record
/// alone ran to 19 KB in this repository and the first `user_message` sat at byte 110,591, so a
/// window sized for the cwd finds no title at all.
const CODEX_TITLE_BYTES: u64 = 256 * 1024;

/// without limit and a person resuming work is not reaching for last quarter.
pub fn list(home: &Path, root_path: &str, since_days: u64) -> Value {
    let store = home.join(".codex/sessions");
    if !store.is_dir() {
        return answer("codex", &store, false, None, None);
    }
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(since_days * 86_400))
        .and_then(|when| when.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|gap| gap.as_millis() as f64)
        .unwrap_or(0.0);
    let mut rows = Vec::new();
    let mut stack = vec![store.clone()];
    while let Some(directory) = stack.pop() {
        let Ok(listing) = fs::read_dir(&directory) else { continue };
        for item in listing.flatten() {
            let path = item.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let modified = modified_ms(&path);
            if modified < cutoff {
                continue;
            }
            if !codex_is_root(&path, root_path) {
                continue;
            }
            /* `rollout-<timestamp>-<uuid>`: the id is the last five dash-separated groups. */
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
            let id = codex_id(stem).unwrap_or_else(|| stem.to_string());
            let (first, last) = codex_read(&path);
            rows.push(detailed(&id, first.clone(), first, last, modified, "codex"));
        }
    }
    answer("codex", &store, true, Some(rows), None)
}

/// codex writes the person's turn as an `event_msg` whose payload is a `user_message`. The first
/// one is the nearest thing it has to a title; it carries no title of its own.
fn codex_read(path: &Path) -> (Option<String>, Option<String>) {
    let Some(text) = head_text(path, CODEX_TITLE_BYTES) else { return (None, None) };
    let mut first: Option<String> = None;
    let mut last: Option<String> = None;
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        let Some(payload) = entry.get("payload") else { continue };
        if payload.get("type").and_then(Value::as_str) != Some("user_message") {
            continue;
        }
        if let Some(message) = payload.get("message").and_then(Value::as_str) {
            let said = one_line(message, EXCERPT_CHARS);
            if first.is_none() {
                first = said.clone();
            }
            last = said.or(last);
        }
    }
    (first, last)
}

fn codex_id(stem: &str) -> Option<String> {
    let parts: Vec<&str> = stem.split('-').collect();
    if parts.len() < 5 {
        return None;
    }
    Some(parts[parts.len() - 5..].join("-"))
}

fn codex_is_root(path: &Path, root_path: &str) -> bool {
    let Some(text) = head_text(path, CWD_SCAN_BYTES) else { return false };
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        for key in ["cwd", "workdir"] {
            if let Some(found) = entry.get(key).and_then(Value::as_str) {
                return found == root_path;
            }
            if let Some(found) = entry.get("payload").and_then(|p| p.get(key)).and_then(Value::as_str) {
                return found == root_path;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    #[test]
    fn matches_on_the_cwd_inside_the_rollout() {
        let home = super::super::tests::temp("codex");
        let day = home.join(".codex/sessions/2026/09/15");
        fs::create_dir_all(&day).expect("the day directory");
        fs::write(
            day.join("rollout-2026-09-15T10-00-00-01a0a058-fdbb-7091-b50f-c63501e3d3c8.jsonl"),
            "{\"cwd\":\"/tmp/demo\"}\n{\"payload\":{\"type\":\"user_message\",\"message\":\"port the thing\"}}\n",
        )
        .expect("a rollout for this root");
        fs::write(
            day.join("rollout-2026-09-15T11-00-00-01a0a058-fdbb-7091-b50f-000000000000.jsonl"),
            "{\"cwd\":\"/tmp/elsewhere\"}\n",
        )
        .expect("a rollout for another root");

        let answer = list(&home, "/tmp/demo", 3650);
        let rows = answer["conversations"].as_array().expect("rows");
        assert_eq!(rows.len(), 1, "the date tree is filtered by the cwd inside each file");
        assert_eq!(rows[0]["id"], json!("01a0a058-fdbb-7091-b50f-c63501e3d3c8"), "the id is the uuid, not the timestamp");
        assert_eq!(rows[0]["first"], json!("port the thing"), "the first user_message is the excerpt");
        let _ = fs::remove_dir_all(&home);
    }
}
