//! The conversations an agent CLI already holds for a project (F210, spec 140).
//!
//! rEngine records the conversations it MINTS (spec 096). A CLI's own store holds more: every
//! conversation there is, including ones begun outside the editor — a terminal, a checkout at a
//! different path, a session that predates this workspace. The owner asked for the list `/resume`
//! shows, and that list lives here rather than in rEngine's records.
//!
//! **This module only reads.** The transcripts are each CLI's own format and each CLI's to change;
//! a store that cannot be parsed is reported unreadable, never repaired. Nothing under
//! `~/.claude`, `~/.codex` or `~/.kimi-code` is written by anything in this file.
//!
//! The three stores are shaped differently and the differences decide the work:
//!
//! | CLI | layout | grouped by | cost to filter by project |
//! |---|---|---|---|
//! | claude | `projects/<slug>/<uuid>.jsonl` | project, by a PATH-derived slug | a directory listing |
//! | codex | `sessions/YYYY/MM/DD/rollout-*.jsonl` | **date, not project** | open every candidate |
//! | kimi | `sessions/wd_<name>_<hash>/`, plus an index | working directory, via a real index | one file |
//!
//! codex is why listing is on demand and never on a timer: its tree cannot answer "which of these
//! belong to this project" without reading each file's head.
//!
//! The path-derived keys claude and kimi use are an implementation detail of those CLIs, MAPPED
//! here and never adopted: a second machine with the same project at a different path produces a
//! different key, which is the same trap spec 137 met for memories.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::recordings::Fail;

/// The most transcripts one agent reports for one root. A bound, not a budget: a person choosing a
/// conversation to resume is not scrolling past a hundred, and codex's tree is walked per request.
const MAX_PER_AGENT: usize = 64;
/// How far into a transcript the title search reads. Claude writes `ai-title` repeatedly as the
/// conversation is renamed, so the LAST one in this window wins; the first user message is the
/// fallback and appears near the top. Reading whole files would make listing O(transcript).
const TITLE_SCAN_BYTES: u64 = 256 * 1024;
/// How far into a codex rollout the `cwd` search reads. It is written in the opening records.
const CWD_SCAN_BYTES: u64 = 32 * 1024;
/// How far into a codex rollout the title search reads. Far more than the cwd needs: its opening
/// `world_state` record alone ran to 19 KB in this repository and the first `user_message` sat at
/// byte 110,591, so a window sized for the cwd finds no title at all.
const CODEX_TITLE_BYTES: u64 = 256 * 1024;
/// How much of a claude transcript's END is searched for a title. `ai-title` is rewritten as the
/// conversation is renamed, so the most recent one is at the back; and a transcript whose head is
/// all harness envelopes (`<command-name>`, caveats) has its first real message further in than a
/// head-only scan reaches.
const TAIL_SCAN_BYTES: u64 = 192 * 1024;

fn refuse(message: &str, status: u16) -> Fail {
    Fail::with_status(message, status)
}

/// Claude derives its per-project directory from the checkout path: every separator becomes `-`.
/// `/Users/alex/rengine` becomes `-Users-alex-rengine`.
fn claude_slug(root_path: &str) -> String {
    root_path.chars().map(|c| if c == '/' || c == '\\' { '-' } else { c }).collect()
}

/// The first `limit` bytes of a file as text, lossily. Transcripts are JSONL written by other
/// programs; a partial final line is expected when the file is being appended to right now, and a
/// byte that is not UTF-8 is not a reason to report the store unreadable.
fn head_text(path: &Path, limit: u64) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let end = (limit as usize).min(bytes.len());
    Some(String::from_utf8_lossy(&bytes[..end]).into_owned())
}

/// The last `limit` bytes of a file as text, lossily, starting at the first newline inside the
/// window so a partial line is never parsed as a whole one.
fn tail_text(path: &Path, limit: u64) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let start = bytes.len().saturating_sub(limit as usize);
    let slice = &bytes[start..];
    let from = if start == 0 { 0 } else { slice.iter().position(|b| *b == b'\n').map(|i| i + 1).unwrap_or(0) };
    Some(String::from_utf8_lossy(&slice[from..]).into_owned())
}

fn modified_ms(path: &Path) -> f64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|gap| gap.as_millis() as f64)
        .unwrap_or(0.0)
}

/// One line of prose from a transcript, trimmed to something a row can draw. Newlines become
/// spaces because a title is one line; a message that is only whitespace is no title at all.
fn one_line(text: &str, limit: usize) -> Option<String> {
    let flat: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let trimmed = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(limit).collect())
}

/// Claude's own title for a conversation, or the first thing the person said.
///
/// Of four transcripts in this repository when this was written, ONE carried an `ai-title` and
/// three did not — so the fallback is not a nicety. A row that shows a bare id names nothing, which
/// is the defect this whole feature exists to fix.
fn claude_title(path: &Path) -> Option<String> {
    let head = head_text(path, TITLE_SCAN_BYTES)?;
    /* The tail first for the title, the head for the fallback: the newest `ai-title` is at the back
       and the person's opening message is at the front, so neither window alone answers both. */
    let tail = tail_text(path, TAIL_SCAN_BYTES).unwrap_or_default();
    let text = format!("{head}\n{tail}");
    let mut titled: Option<String> = None;
    let mut spoken: Option<String> = None;
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        match entry.get("type").and_then(Value::as_str) {
            Some("ai-title") => {
                if let Some(title) = entry.get("aiTitle").and_then(Value::as_str) {
                    titled = one_line(title, 80).or(titled);
                }
            }
            Some("user") if spoken.is_none() => {
                /* Only a plain string: a user entry whose content is an array is a tool result or
                   an attachment, and the first of those is not what the person typed. */
                let content = entry.get("message").and_then(|m| m.get("content"));
                /* A string is what the person typed. An ARRAY is the newer shape, whose first
                   text part is the same thing; its other parts are tool results and attachments,
                   which are not a title. A string opening with '<' is a harness envelope. */
                let said = match content {
                    Some(Value::String(text)) => Some(text.as_str()),
                    Some(Value::Array(parts)) => parts
                        .iter()
                        .find_map(|part| part.get("text").and_then(Value::as_str)),
                    _ => None,
                };
                if let Some(said) = said {
                    if !said.starts_with('<') {
                        spoken = one_line(said, 80);
                    }
                }
            }
            _ => {}
        }
    }
    titled.or(spoken)
}

fn entry(id: &str, title: Option<String>, modified: f64, agent: &str) -> Value {
    json!({
        "id": id,
        "agent": agent,
        "title": title.unwrap_or_default(),
        "modifiedAt": modified,
    })
}

fn sort_and_cap(mut rows: Vec<Value>) -> Vec<Value> {
    rows.sort_by(|a, b| {
        let left = b.get("modifiedAt").and_then(Value::as_f64).unwrap_or(0.0);
        let right = a.get("modifiedAt").and_then(Value::as_f64).unwrap_or(0.0);
        left.partial_cmp(&right).unwrap_or(std::cmp::Ordering::Equal)
    });
    rows.truncate(MAX_PER_AGENT);
    rows
}

/// `{ store: "...", conversations: [...] }`, or `{ store, error }` when the directory is there and
/// unreadable. An agent with NO store at all reports `present: false` — which is a different
/// answer from an empty list, and a person reading the view is entitled to know which.
fn answer(agent: &str, store: &Path, present: bool, rows: Option<Vec<Value>>, error: Option<String>) -> Value {
    let mut map = Map::new();
    map.insert("agent".to_string(), json!(agent));
    map.insert("store".to_string(), json!(store.to_string_lossy()));
    map.insert("present".to_string(), json!(present));
    match (rows, error) {
        (_, Some(message)) => {
            map.insert("error".to_string(), json!(message));
            map.insert("conversations".to_string(), json!([]));
        }
        (Some(rows), None) => {
            map.insert("conversations".to_string(), json!(sort_and_cap(rows)));
        }
        (None, None) => {
            map.insert("conversations".to_string(), json!([]));
        }
    }
    Value::Object(map)
}

/// claude: one directory per project, named from the checkout path; one file per conversation,
/// named by its id — which is the SAME id `--resume` takes and the same one rEngine mints.
pub fn claude(home: &Path, root_path: &str) -> Value {
    let store = home.join(".claude/projects").join(claude_slug(root_path));
    if !store.is_dir() {
        return answer("claude", &store, false, None, None);
    }
    let listing = match fs::read_dir(&store) {
        Ok(listing) => listing,
        Err(error) => return answer("claude", &store, true, None, Some(error.to_string())),
    };
    let mut rows = Vec::new();
    for item in listing.flatten() {
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        rows.push(entry(id, claude_title(&path), modified_ms(&path), "claude"));
    }
    answer("claude", &store, true, Some(rows), None)
}

/// kimi: an index keyed by working directory, so this opens one file and no transcript. The index
/// is JSONL of `{sessionId, sessionDir, workDir}`; a row whose directory is gone is dropped rather
/// than offered.
pub fn kimi(home: &Path, root_path: &str) -> Value {
    let store = home.join(".kimi-code/session_index.jsonl");
    if !store.is_file() {
        return answer("kimi", &store, false, None, None);
    }
    let text = match fs::read_to_string(&store) {
        Ok(text) => text,
        Err(error) => return answer("kimi", &store, true, None, Some(error.to_string())),
    };
    let mut rows = Vec::new();
    for line in text.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else { continue };
        if row.get("workDir").and_then(Value::as_str) != Some(root_path) {
            continue;
        }
        let Some(id) = row.get("sessionId").and_then(Value::as_str) else { continue };
        let directory = row.get("sessionDir").and_then(Value::as_str).unwrap_or_default();
        let expanded = expand_home(home, directory);
        if !expanded.exists() {
            continue;
        }
        rows.push(entry(id, None, modified_ms(&expanded), "kimi"));
    }
    answer("kimi", &store, true, Some(rows), None)
}

fn expand_home(home: &Path, path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(path),
    }
}

/// codex: partitioned by DATE, so the project a rollout belongs to is only knowable from inside it.
/// This is the expensive adapter and the reason the whole listing is on demand: it opens the head
/// of every candidate. `since_days` bounds how far back the walk goes, because the tree grows
/// without limit and a person resuming work is not reaching for last quarter.
pub fn codex(home: &Path, root_path: &str, since_days: u64) -> Value {
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
            rows.push(entry(&id, codex_title(&path), modified, "codex"));
        }
    }
    answer("codex", &store, true, Some(rows), None)
}

/// codex writes the person's turn as an `event_msg` whose payload is a `user_message`. The first
/// one is the nearest thing it has to a title; it carries no title of its own.
fn codex_title(path: &Path) -> Option<String> {
    let text = head_text(path, CODEX_TITLE_BYTES)?;
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        let Some(payload) = entry.get("payload") else { continue };
        if payload.get("type").and_then(Value::as_str) != Some("user_message") {
            continue;
        }
        if let Some(message) = payload.get("message").and_then(Value::as_str) {
            return one_line(message, 80);
        }
    }
    None
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

/// Every agent's store for one root, as the view draws it. Agents with no store are present in the
/// answer saying so, because a row that is absent and a row that says "no conversation store" are
/// different facts and only one of them is actionable.
pub fn stores(home: &Path, root_path: &str, since_days: u64) -> Result<Value, Fail> {
    if root_path.is_empty() {
        return Err(refuse("A project root is required to list its conversations.", 400));
    }
    Ok(json!({
        "root": root_path,
        "agents": [
            claude(home, root_path),
            codex(home, root_path, since_days),
            kimi(home, root_path),
            /* Declared and empty on purpose: these CLIs have no per-project conversation store, and
               saying so is the answer. An agent missing from the list would read as an oversight. */
            json!({ "agent": "gemini", "store": "", "present": false, "conversations": [] }),
            json!({ "agent": "opencode", "store": "", "present": false, "conversations": [] }),
        ],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("red-conversations-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("a temp directory");
        directory
    }

    #[test]
    fn claude_lists_by_slug_and_titles_from_the_transcript() {
        let home = temp("claude");
        let store = home.join(".claude/projects/-tmp-demo");
        fs::create_dir_all(&store).expect("the store");
        /* One transcript with claude's own title, one with none — which is the real distribution:
           three of four in this repository had no ai-title when this was written. */
        fs::write(
            store.join("11111111-1111-1111-1111-111111111111.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"first thing said\"}}\n\
             {\"type\":\"ai-title\",\"aiTitle\":\"Renaming the renderer\"}\n",
        )
        .expect("a titled transcript");
        fs::write(
            store.join("22222222-2222-2222-2222-222222222222.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"  only what the person typed  \"}}\n",
        )
        .expect("an untitled transcript");

        let answer = claude(&home, "/tmp/demo");
        assert_eq!(answer["present"], json!(true));
        let rows = answer["conversations"].as_array().expect("rows");
        assert_eq!(rows.len(), 2);
        let titled = rows.iter().find(|r| r["id"] == json!("11111111-1111-1111-1111-111111111111")).expect("the titled one");
        assert_eq!(titled["title"], json!("Renaming the renderer"), "claude's own title wins");
        let untitled = rows.iter().find(|r| r["id"] == json!("22222222-2222-2222-2222-222222222222")).expect("the untitled one");
        assert_eq!(untitled["title"], json!("only what the person typed"), "the first message is the fallback");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_root_with_no_store_is_absent_rather_than_empty() {
        let home = temp("absent");
        let answer = claude(&home, "/tmp/never-opened");
        assert_eq!(answer["present"], json!(false), "no store is not an empty store");
        assert_eq!(answer["conversations"], json!([]));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn kimi_filters_by_working_directory_without_opening_a_transcript() {
        let home = temp("kimi");
        fs::create_dir_all(home.join(".kimi-code")).expect("the store");
        let mine = home.join(".kimi-code/sessions/wd_demo_abc");
        fs::create_dir_all(&mine).expect("a session directory");
        fs::write(
            home.join(".kimi-code/session_index.jsonl"),
            format!(
                "{{\"sessionId\":\"session_keep\",\"sessionDir\":\"{}\",\"workDir\":\"/tmp/demo\"}}\n\
                 {{\"sessionId\":\"session_other\",\"sessionDir\":\"{}\",\"workDir\":\"/tmp/elsewhere\"}}\n\
                 {{\"sessionId\":\"session_gone\",\"sessionDir\":\"/tmp/not-there\",\"workDir\":\"/tmp/demo\"}}\n",
                mine.to_string_lossy(),
                mine.to_string_lossy()
            ),
        )
        .expect("the index");

        let answer = kimi(&home, "/tmp/demo");
        let rows = answer["conversations"].as_array().expect("rows");
        assert_eq!(rows.len(), 1, "another project's row and a vanished directory are both dropped");
        assert_eq!(rows[0]["id"], json!("session_keep"));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn codex_matches_on_the_cwd_inside_the_rollout() {
        let home = temp("codex");
        let day = home.join(".codex/sessions/2026/09/15");
        fs::create_dir_all(&day).expect("the day directory");
        fs::write(
            day.join("rollout-2026-09-15T10-00-00-01a0a058-fdbb-7091-b50f-c63501e3d3c8.jsonl"),
            "{\"cwd\":\"/tmp/demo\"}\n",
        )
        .expect("a rollout for this root");
        fs::write(
            day.join("rollout-2026-09-15T11-00-00-01a0a058-fdbb-7091-b50f-000000000000.jsonl"),
            "{\"cwd\":\"/tmp/elsewhere\"}\n",
        )
        .expect("a rollout for another root");

        let answer = codex(&home, "/tmp/demo", 3650);
        let rows = answer["conversations"].as_array().expect("rows");
        assert_eq!(rows.len(), 1, "the date tree is filtered by the cwd inside each file");
        assert_eq!(rows[0]["id"], json!("01a0a058-fdbb-7091-b50f-c63501e3d3c8"), "the id is the uuid, not the timestamp");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn listing_writes_nothing_under_the_stores() {
        let home = temp("readonly");
        let store = home.join(".claude/projects/-tmp-demo");
        fs::create_dir_all(&store).expect("the store");
        fs::write(store.join("33333333-3333-3333-3333-333333333333.jsonl"), "{\"type\":\"user\",\"message\":{\"content\":\"hi\"}}\n")
            .expect("a transcript");

        fn fingerprint(directory: &Path) -> Vec<(String, u64, u64)> {
            let mut out = Vec::new();
            let mut stack = vec![directory.to_path_buf()];
            while let Some(next) = stack.pop() {
                let Ok(listing) = fs::read_dir(&next) else { continue };
                for item in listing.flatten() {
                    let path = item.path();
                    if path.is_dir() {
                        stack.push(path);
                        continue;
                    }
                    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    /* Milliseconds as an integer so the fingerprint sorts; a read must not move mtime. */
                    out.push((path.to_string_lossy().into_owned(), size, modified_ms(&path) as u64));
                }
            }
            out.sort();
            out
        }

        let before = fingerprint(&home);
        let _ = stores(&home, "/tmp/demo", 3650).expect("a listing");
        let after = fingerprint(&home);
        assert_eq!(before, after, "listing a store never writes to it");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn every_agent_is_named_even_with_no_store() {
        let home = temp("named");
        let answer = stores(&home, "/tmp/demo", 3650).expect("a listing");
        let agents: Vec<&str> = answer["agents"]
            .as_array()
            .expect("agents")
            .iter()
            .map(|a| a.get("agent").and_then(Value::as_str).unwrap_or("claude"))
            .collect();
        assert_eq!(agents.len(), 5, "an agent missing from the list would read as an oversight");
        let _ = fs::remove_dir_all(&home);
    }
}
