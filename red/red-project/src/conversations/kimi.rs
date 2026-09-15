//! kimi's conversation store (F210, spec 140).
//!
//! The only one of the three with a real index: `session_index.jsonl` carries
//! `{sessionId, sessionDir, workDir}`, so filtering to a project reads one file and opens no
//! transcript. It keeps no title and no message text, which is recorded rather than invented — a
//! row from here carries its id and its age and says so when expanded.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{answer, entry, modified_ms};

/// than offered.
pub fn list(home: &Path, root_path: &str) -> Value {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    #[test]
    fn filters_by_working_directory_without_opening_a_transcript() {
        let home = super::super::tests::temp("kimi");
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

        let answer = list(&home, "/tmp/demo");
        let rows = answer["conversations"].as_array().expect("rows");
        assert_eq!(rows.len(), 1, "another project's row and a vanished directory are both dropped");
        assert_eq!(rows[0]["id"], json!("session_keep"));
        /* No title and no excerpts, because the store keeps none. Said rather than invented. */
        assert_eq!(rows[0]["title"], json!(""));
        assert_eq!(rows[0]["first"], json!(""));
        let _ = fs::remove_dir_all(&home);
    }
}
