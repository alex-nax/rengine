//! claude's conversation store (F210, spec 140).
//!
//! One directory per project, named from the checkout path with every separator turned into a dash;
//! one file per conversation, named by the id `--resume` takes — which is the same id rEngine mints,
//! so this adapter and spec 096's records speak about the same thing.

use std::fs;
use std::path::Path;

use serde_json::Value;

use super::{answer, detailed, head_text, modified_ms, one_line, tail_text, EXCERPT_CHARS, TAIL_SCAN_BYTES, TITLE_SCAN_BYTES};

/// `/Users/alex/rengine` becomes `-Users-alex-rengine`.
fn claude_slug(root_path: &str) -> String {
    root_path.chars().map(|c| if c == '/' || c == '\\' { '-' } else { c }).collect()
}

/// Title, first message and last message in one pass, so a listing reads each transcript once
/// rather than three times. The excerpts are what a person expands a row to see: enough to
/// recognise the conversation without opening it.
fn claude_read(path: &Path) -> (Option<String>, Option<String>, Option<String>) {
    let Some(head) = head_text(path, TITLE_SCAN_BYTES) else { return (None, None, None) };
    /* The tail first for the title, the head for the fallback: the newest `ai-title` is at the back
       and the person's opening message is at the front, so neither window alone answers both. */
    let tail = tail_text(path, TAIL_SCAN_BYTES).unwrap_or_default();
    let text = format!("{head}\n{tail}");
    let mut titled: Option<String> = None;
    let mut spoken: Option<String> = None;
    let mut latest: Option<String> = None;
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
                        spoken = one_line(said, EXCERPT_CHARS);
                    }
                }
            }
            _ => {}
        }
        /* The LAST thing said, wherever it falls: the loop keeps overwriting, so what survives is
           the most recent turn in the window — which is the half of the pair that tells a person
           where a conversation got to. */
        if entry.get("type").and_then(Value::as_str) == Some("user") {
            let content = entry.get("message").and_then(|m| m.get("content"));
            let said = match content {
                Some(Value::String(text)) => Some(text.as_str()),
                Some(Value::Array(parts)) => parts.iter().find_map(|part| part.get("text").and_then(Value::as_str)),
                _ => None,
            };
            if let Some(said) = said {
                if !said.starts_with('<') {
                    latest = one_line(said, EXCERPT_CHARS).or(latest);
                }
            }
        }
    }
    (titled.clone().or_else(|| spoken.clone()), spoken, latest)
}
/// named by its id — which is the SAME id `--resume` takes and the same one rEngine mints.
pub fn list(home: &Path, root_path: &str) -> Value {
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
        let (title, first, last) = claude_read(&path);
        rows.push(detailed(id, title, first, last, modified_ms(&path), "claude"));
    }
    answer("claude", &store, true, Some(rows), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    #[test]
    fn lists_by_slug_and_titles_from_the_transcript() {
        let home = super::super::tests::temp("claude");
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

        let answer = list(&home, "/tmp/demo");
        assert_eq!(answer["present"], json!(true));
        let rows = answer["conversations"].as_array().expect("rows");
        assert_eq!(rows.len(), 2);
        let titled = rows.iter().find(|r| r["id"] == json!("11111111-1111-1111-1111-111111111111")).expect("the titled one");
        assert_eq!(titled["title"], json!("Renaming the renderer"), "claude's own title wins");
        let untitled = rows.iter().find(|r| r["id"] == json!("22222222-2222-2222-2222-222222222222")).expect("the untitled one");
        assert_eq!(untitled["title"], json!("only what the person typed"), "the first message is the fallback");
        let _ = fs::remove_dir_all(&home);
    }

    /* The excerpts an expanded row shows: the opening turn and the most recent one. */
    #[test]
    fn carries_the_first_and_last_thing_said() {
        let home = super::super::tests::temp("claude-excerpts");
        let store = home.join(".claude/projects/-tmp-demo");
        fs::create_dir_all(&store).expect("the store");
        fs::write(
            store.join("44444444-4444-4444-4444-444444444444.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"the opening ask\"}}\n\
             {\"type\":\"assistant\",\"message\":{\"content\":\"working\"}}\n\
             {\"type\":\"user\",\"message\":{\"content\":\"the most recent turn\"}}\n",
        )
        .expect("a transcript with two turns");
        let rows = list(&home, "/tmp/demo")["conversations"].as_array().cloned().expect("rows");
        assert_eq!(rows[0]["first"], json!("the opening ask"));
        assert_eq!(rows[0]["last"], json!("the most recent turn"), "the last turn, not the first again");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_root_with_no_store_is_absent_rather_than_empty() {
        let home = super::super::tests::temp("absent");
        let answer = list(&home, "/tmp/never-opened");
        assert_eq!(answer["present"], json!(false), "no store is not an empty store");
        assert_eq!(answer["conversations"], json!([]));
        let _ = fs::remove_dir_all(&home);
    }
}
