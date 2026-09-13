//! Reading a Codex handoff manifest (F189; `agents/handoff.mjs`'s host half).
//!
//! A handoff says *resume this exact paused conversation, in this project, from this checkpoint*.
//! Every check here exists because the alternative is worse than refusing: a manifest that names
//! another project would move a person's session sideways, a checkpoint outside the project would
//! read a file the pane has no business reading, and a session id with no local rollout would
//! quietly start a NEW conversation wearing the old one's name. The JS this replaces says so in its
//! own message — "No substitute session was launched" — and that is the promise being kept.
//!
//! `waitForPresentation` and `resumeArgs` are deliberately not here: they run inside the pane, in
//! its own launcher, and belong to whatever starts that.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// Read and judge the manifest, answering the record a pane is launched with.
pub(crate) fn read_handoff(filename: &str, project: &Path, env: &Value) -> Result<Value, String> {
    let refuse = |message: &str| format!("400|{message}");
    let filename = std::fs::canonicalize(filename).map_err(|error| refuse(&error.to_string()))?;
    let source = std::fs::read_to_string(&filename).map_err(|error| refuse(&error.to_string()))?;
    if source.len() > 16384 {
        return Err(refuse("Handoff manifest is too large."));
    }
    let value: Value = serde_json::from_str(&source).map_err(|error| refuse(&error.to_string()))?;
    let session_id = value.get("sessionId").and_then(Value::as_str).unwrap_or_default().to_string();
    if value.get("version").and_then(Value::as_u64) != Some(1)
        || !is_uuid(&session_id)
        || !value.get("project").is_some_and(Value::is_string)
        || !value.get("checkpoint").is_some_and(Value::is_string)
    {
        return Err(refuse("Expected a version-1 handoff with project, sessionId UUID and checkpoint."));
    }
    let named = value.get("project").and_then(Value::as_str).unwrap_or_default();
    let root = std::fs::canonicalize(filename.parent().unwrap_or(Path::new("/")).join(named))
        .map_err(|error| refuse(&error.to_string()))?;
    let here = std::fs::canonicalize(project).map_err(|error| refuse(&error.to_string()))?;
    if here != root {
        return Err(refuse("Handoff belongs to a different project."));
    }
    let checkpoint = std::fs::canonicalize(root.join(value.get("checkpoint").and_then(Value::as_str).unwrap_or_default()))
        .map_err(|error| refuse(&error.to_string()))?;
    if !checkpoint.starts_with(&root) {
        return Err(refuse("Checkpoint must be inside the project."));
    }
    if !checkpoint.is_file() {
        return Err(refuse("Checkpoint must be a file."));
    }
    /* The conversation has to exist ON THIS MACHINE. Codex keeps its rollouts under CODEX_HOME, and
       a handoff whose rollout is missing is a handoff that would have started a fresh session with
       the paused one's name on it. */
    let home = env
        .get("CODEX_HOME")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".codex"));
    let rollout = find_rollout(&home.join("sessions"), &session_id, 0)
        .or_else(|| find_rollout(&home.join("archived_sessions"), &session_id, 0));
    let Some(rollout) = rollout else {
        return Err(refuse(&format!(
            "Cannot find local Codex conversation {session_id}. No substitute session was launched."
        )));
    };
    let meta = first_line(&rollout).ok_or_else(|| refuse("Codex session metadata is missing or too large."))?;
    let meta: Value = serde_json::from_str(&meta).map_err(|_| refuse("Codex session metadata is missing or too large."))?;
    if meta.get("type").and_then(Value::as_str) != Some("session_meta")
        || meta.get("payload").and_then(|payload| payload.get("id")).and_then(Value::as_str) != Some(session_id.as_str())
    {
        return Err(refuse("Codex conversation metadata does not match the handoff."));
    }
    let recorded = meta.get("payload").and_then(|payload| payload.get("cwd")).and_then(Value::as_str).unwrap_or_default();
    if std::fs::canonicalize(recorded).map_err(|error| refuse(&error.to_string()))? != root {
        return Err(refuse("Codex conversation belongs to a different project."));
    }
    Ok(json!({
        "filename": filename.to_string_lossy(),
        "project": root.to_string_lossy(),
        "checkpoint": checkpoint.to_string_lossy(),
        "sessionId": session_id,
    }))
}

/// The CLI's own prerequisites, asked the way the workspace asks them everywhere else: through
/// `agent.sh`, so a change to what "logged in" means is a change in one place.
pub(crate) fn check_resume(bash: &str, project: &Path, env: &Value) -> Result<(), String> {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .map(|checkout| checkout.join("scripts/agent.sh"))
        .unwrap_or_default();
    let mut command = std::process::Command::new(bash);
    command
        .arg(script)
        .args(["--project", &project.to_string_lossy(), "--agent", "codex", "--action", "check-resume"])
        .stdin(std::process::Stdio::null());
    command.env_clear();
    if let Some(values) = env.as_object() {
        for (name, value) in values {
            if let Some(text) = value.as_str() {
                command.env(name, text);
            }
        }
    }
    match command.output() {
        Ok(done) if done.status.success() => Ok(()),
        Ok(done) => {
            let said = String::from_utf8_lossy(&done.stderr).trim().to_string();
            Err(format!("400|Codex resume prerequisites failed: {}", if said.is_empty() { done.status.to_string() } else { said }))
        }
        Err(error) => Err(format!("400|Codex resume prerequisites failed: {error}")),
    }
}

fn is_uuid(value: &str) -> bool {
    let shape = [8, 4, 4, 4, 12];
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == shape.len()
        && parts.iter().zip(shape).all(|(part, length)| {
            part.len() == length && part.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
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
