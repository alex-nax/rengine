//! codex's half of a handoff: where it keeps a conversation, and how to tell that one is really
//! there (F189, F216; spec 141's one-adapter-per-agent rule).
//!
//! This file is codex's, so it may name codex — that is what an adapter is for. The `rollout-jsonl`
//! kind its recipe declares is what `mod.rs` dispatches on; nothing shared knows this file exists
//! except through that kind.
//!
//! The question it answers is narrow and the reason is in `mod.rs`: a handoff whose conversation is
//! not on this machine would quietly start a NEW one wearing the paused one's name.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// Where this CLI keeps its conversations, for the environment a launch will actually run in.
fn home(env: &Value) -> PathBuf {
    env.get("CODEX_HOME")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".codex"))
}

/// Is this conversation on this machine, and is it this project's? `Ok(())` only when both hold.
pub(super) fn confirm(session_id: &str, root: &Path, env: &Value) -> Result<(), String> {
    let refuse = |message: &str| format!("400|{message}");
    let home = home(env);
    let rollout = find_rollout(&home.join("sessions"), session_id, 0)
        .or_else(|| find_rollout(&home.join("archived_sessions"), session_id, 0));
    let Some(rollout) = rollout else {
        return Err(refuse(&format!(
            "Cannot find local Codex conversation {session_id}. No substitute session was launched."
        )));
    };
    let meta = first_line(&rollout).ok_or_else(|| refuse("Codex session metadata is missing or too large."))?;
    let meta: Value = serde_json::from_str(&meta).map_err(|_| refuse("Codex session metadata is missing or too large."))?;
    if meta.get("type").and_then(Value::as_str) != Some("session_meta")
        || meta.get("payload").and_then(|payload| payload.get("id")).and_then(Value::as_str) != Some(session_id)
    {
        return Err(refuse("Codex conversation metadata does not match the handoff."));
    }
    let recorded = meta.get("payload").and_then(|payload| payload.get("cwd")).and_then(Value::as_str).unwrap_or_default();
    if std::fs::canonicalize(recorded).map_err(|error| refuse(&error.to_string()))? != root {
        return Err(refuse("Codex conversation belongs to a different project."));
    }
    Ok(())
}

/// Codex names a rollout `<something>-<sessionId>.jsonl`, three directories deep at most.
fn find_rollout(directory: &Path, session_id: &str, depth: usize) -> Option<PathBuf> {
    let entries = std::fs::read_dir(directory).ok()?;
    let mut directories = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_file() {
            if entry.file_name().to_string_lossy().ends_with(&format!("-{session_id}.jsonl")) {
                return Some(path);
            }
        } else if kind.is_dir() && depth < 3 {
            directories.push(path);
        }
    }
    directories.into_iter().find_map(|path| find_rollout(&path, session_id, depth + 1))
}

/// The first line of the rollout, within the same 64 KiB the JS reads: the metadata is the first
/// record or the file is not one.
fn first_line(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buffer = vec![0u8; 65536];
    let read = file.read(&mut buffer).ok()?;
    let end = buffer[..read].iter().position(|byte| *byte == b'\n')?;
    Some(String::from_utf8_lossy(&buffer[..end]).to_string())
}
