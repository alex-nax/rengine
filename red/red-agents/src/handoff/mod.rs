//! Reading a handoff manifest (F189; `agents/handoff.mjs`'s host half).
//!
//! It sits in `red-agents` rather than in a host because THREE callers want it and there must be
//! one answer: the session host launching a handoff pane, the workspace launcher's `--handoff`
//! (spec 145), and the recipes this reading already consults to learn what a CLI can be handed.
//!
//! A handoff says *resume this exact paused conversation, in this project, from this checkpoint*.
//! Every check here exists because the alternative is worse than refusing: a manifest that named
//! another project would move a person's session sideways, a checkpoint outside the project would
//! read a file the pane has no business reading, and a session id with no local conversation behind
//! it would quietly start a NEW conversation wearing the old one's name. The JS this replaces says
//! so in its own message — "No substitute session was launched" — and that is the promise kept.
//!
//! **This file knows no CLI by name** (F216, spec 141). The manifest is rEngine's format, and
//! judging it is this module's. Where the conversation actually LIVES is the CLI's own business:
//! its recipe declares `conversation.handoff.kind`, and the adapter for that kind answers whether
//! the conversation is really on this machine. A CLI whose kind rEngine has no reader for is
//! refused by that kind — never by its name.
//!
//! `waitForPresentation` and `resumeArgs` are deliberately not here: they run inside the pane, in
//! its own launcher, and belong to whatever starts that.

mod codex;

use std::path::Path;

use serde_json::{json, Value};

/// The declared kinds this crate can read a conversation store for, and who reads each. One arm per
/// adapter: adding a CLI whose store is a new shape is a new adapter and one line here.
fn confirm_conversation(kind: &str, session_id: &str, root: &Path, env: &Value) -> Result<(), String> {
    match kind {
        "rollout-jsonl" => codex::confirm(session_id, root, env),
        other => Err(format!("400|rEngine cannot read a {other} conversation store, so this handoff was not launched.")),
    }
}

/// Read and judge the manifest, answering the record a pane is launched with. `handoff` is what the
/// CLI's recipe declares it can be handed, and `ids` the shape that CLI's conversation ids take.
pub fn read_handoff(
    filename: &str,
    project: Option<&Path>,
    env: &Value,
    handoff: &Value,
    ids: Option<&str>,
) -> Result<Value, String> {
    let refuse = |message: &str| format!("400|{message}");
    let filename = std::fs::canonicalize(filename).map_err(|error| refuse(&error.to_string()))?;
    let source = std::fs::read_to_string(&filename).map_err(|error| refuse(&error.to_string()))?;
    if source.len() > 16384 {
        return Err(refuse("Handoff manifest is too large."));
    }
    let value: Value = serde_json::from_str(&source).map_err(|error| refuse(&error.to_string()))?;
    let session_id = value.get("sessionId").and_then(Value::as_str).unwrap_or_default().to_string();
    /* The id's shape is the CLI's own declaration, matched by the one matcher every other caller
       uses. A hand-rolled uuid test lived here and accepted a shape the recipe might not. */
    let shaped = ids.is_some_and(|pattern| crate::id_matches(pattern, &session_id));
    if value.get("version").and_then(Value::as_u64) != Some(1)
        || !shaped
        || !value.get("project").is_some_and(Value::is_string)
        || !value.get("checkpoint").is_some_and(Value::is_string)
    {
        return Err(refuse("Expected a version-1 handoff with project, sessionId UUID and checkpoint."));
    }
    let named = value.get("project").and_then(Value::as_str).unwrap_or_default();
    let root = std::fs::canonicalize(filename.parent().unwrap_or(Path::new("/")).join(named))
        .map_err(|error| refuse(&error.to_string()))?;
    /* A project is a CROSS-CHECK, not a requirement, and the JavaScript said so in one character:
       `if (project && ...)`. The launcher's `--project` is optional and the resume command has never
       passed one, so an unconditional comparison here canonicalizes an empty path and answers the
       whole command with `No such file or directory` — naming neither the flag nor the manifest. */
    if let Some(named) = project {
        let here = std::fs::canonicalize(named).map_err(|error| refuse(&error.to_string()))?;
        if here != root {
            return Err(refuse("Handoff belongs to a different project."));
        }
    }
    let checkpoint = std::fs::canonicalize(root.join(value.get("checkpoint").and_then(Value::as_str).unwrap_or_default()))
        .map_err(|error| refuse(&error.to_string()))?;
    if !checkpoint.starts_with(&root) {
        return Err(refuse("Checkpoint must be inside the project."));
    }
    if !checkpoint.is_file() {
        return Err(refuse("Checkpoint must be a file."));
    }
    /* The conversation has to exist ON THIS MACHINE, which only the CLI's own adapter can say. */
    let kind = handoff.get("kind").and_then(Value::as_str).unwrap_or_default();
    confirm_conversation(kind, &session_id, &root, env)?;
    Ok(json!({
        "filename": filename.to_string_lossy(),
        "project": root.to_string_lossy(),
        "checkpoint": checkpoint.to_string_lossy(),
        "sessionId": session_id,
    }))
}

/// The CLI's own prerequisites, asked the way the workspace asks them everywhere else: through
/// `agent.sh`, so a change to what "logged in" means is a change in one place. Which CLI is asked
/// is the caller's, from the pane being launched.
pub fn check_resume(bash: &str, cli: &str, project: &Path, env: &Value) -> Result<(), String> {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .map(|checkout| checkout.join("actions/pane/posix/agent.sh"))
        .unwrap_or_default();
    let mut command = std::process::Command::new(bash);
    command
        .arg(script)
        .args(["--project", &project.to_string_lossy(), "--agent", cli, "--action", "check-resume"])
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
            Err(format!("400|{cli} resume prerequisites failed: {}", if said.is_empty() { done.status.to_string() } else { said }))
        }
        Err(error) => Err(format!("400|{cli} resume prerequisites failed: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /* F216, spec 141: which CLI a handoff is for is a DECLARATION. `bridgecli` exists nowhere in
       this tree — it is a recipe, and its declared kind is the whole of what routes it to a reader.
       The manifest half never learns its name. */
    fn manifest(directory: &std::path::Path, session_id: &str) -> String {
        let file = directory.join("handoff.json");
        std::fs::write(directory.join("checkpoint.md"), "Paused goal checkpoint.").expect("checkpoint");
        std::fs::write(
            &file,
            serde_json::to_string(&json!({ "version": 1, "project": ".", "sessionId": session_id, "checkpoint": "checkpoint.md" })).expect("json"),
        )
        .expect("manifest");
        file.to_string_lossy().into_owned()
    }

    fn rollout(home: &std::path::Path, session_id: &str, cwd: &std::path::Path) {
        let sessions = home.join("sessions/2026/09/05");
        std::fs::create_dir_all(&sessions).expect("sessions");
        std::fs::write(
            sessions.join(format!("rollout-test-{session_id}.jsonl")),
            serde_json::to_string(&json!({ "type": "session_meta", "payload": { "id": session_id, "cwd": cwd } })).expect("json") + "\n",
        )
        .expect("rollout");
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!("rengine-handoff-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("scratch");
        std::fs::canonicalize(&directory).expect("canonical scratch")
    }

    const UUIDS: &str = r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$";

    #[test]
    fn a_cli_that_declares_the_kind_reaches_the_same_reader() {
        let directory = scratch("declared");
        let home = directory.join("store");
        let session_id = "00000000-0000-0000-0000-000000000058";
        let file = manifest(&directory, session_id);
        rollout(&home, session_id, &directory);
        let env = json!({ "CODEX_HOME": home.to_string_lossy() });
        let declared = json!({ "kind": "rollout-jsonl", "ready": ["resume --help"] });
        let read = read_handoff(&file, Some(&directory), &env, &declared, Some(UUIDS)).expect("a declared kind is read");
        assert_eq!(read.get("sessionId").and_then(Value::as_str), Some(session_id));
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn a_kind_rengine_cannot_read_is_refused_by_the_kind_not_by_a_name() {
        let directory = scratch("unknown-kind");
        let session_id = "00000000-0000-0000-0000-000000000058";
        let file = manifest(&directory, session_id);
        let env = json!({ "CODEX_HOME": directory.join("store").to_string_lossy() });
        let refusal = read_handoff(&file, Some(&directory), &env, &json!({ "kind": "carrier-pigeon" }), Some(UUIDS)).unwrap_err();
        assert!(refusal.contains("carrier-pigeon"), "the refusal names the kind: {refusal}");
        assert!(!refusal.contains("codex"), "and nothing about who declared it: {refusal}");
        let _ = std::fs::remove_dir_all(&directory);
    }

    /* The id's shape is the CLI's own declaration, not a uuid rule this crate keeps. */
    #[test]
    fn the_declared_id_shape_judges_the_manifest() {
        let directory = scratch("shape");
        let session_id = "00000000-0000-0000-0000-000000000058";
        let file = manifest(&directory, session_id);
        let env = json!({ "CODEX_HOME": directory.join("store").to_string_lossy() });
        let declared = json!({ "kind": "rollout-jsonl" });
        let refusal = read_handoff(&file, Some(&directory), &env, &declared, Some(r"^CONV-[0-9]{6}$")).unwrap_err();
        assert!(refusal.contains("version-1 handoff"), "a shape its recipe refuses is not a handoff: {refusal}");
        /* And a recipe that declares no shape vouches for nothing, rather than falling back to one. */
        assert!(read_handoff(&file, Some(&directory), &env, &declared, None).is_err());
        let _ = std::fs::remove_dir_all(&directory);
    }
}
