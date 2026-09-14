//! A dashboard capture: the one declared action that WRITES into the project (F156, spec 075/082).
//!
//! Everything else on the board is read, or handed to a terminal. This one runs the project's own
//! command, judges the bytes it produced, and lands a PNG and a manifest row inside the project —
//! so the order of its refusals is part of its contract. Nothing is written until the bytes have
//! been judged, and a refusal says so: "nothing was written" is a promise a person relies on when a
//! capture fails, and `orchestrator/tests/capture-corpus.json` records the directory afterwards for
//! exactly that reason.

use serde_json::{json, Value};

use crate::command;
use crate::dashboard::dashboard_actions;
use crate::devices::Context;
use crate::recordings::Fail;

/// This module refuses with a status, like the routes it answers; `refuse` is the local spelling.
fn refuse(message: impl Into<String>, status: u16) -> Fail {
    Fail::with_status(message, status)
}
use crate::rules::object;

/// The bounds a capture runs under. They are this route's, not the declaration's: a screenshot is
/// a person waiting, and an 8 MiB PNG is already larger than any pane will draw.
pub const CAPTURE_TIMEOUT_MS: u64 = 10_000;
pub const CAPTURE_MAX_BYTES: usize = 8 * 1024 * 1024;
const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// An error the filesystem raised, worded the way Node words one, because that is what a person
/// reads. A code Node has and this does not falls back to the operating system's own sentence.
fn fs_refusal(error: &std::io::Error, syscall: &str, path: &str) -> Fail {
    let code = match error.kind() {
        std::io::ErrorKind::AlreadyExists => "EEXIST: file already exists",
        std::io::ErrorKind::NotFound => "ENOENT: no such file or directory",
        std::io::ErrorKind::PermissionDenied => "EACCES: permission denied",
        std::io::ErrorKind::NotADirectory => "ENOTDIR: not a directory",
        _ => return Fail::raw(format!("{error}")),
    };
    Fail::raw(format!("{code}, {syscall} '{path}'"))
}

/// The action a capture is, or the reason a person cannot press it.
pub fn dashboard_action(context: &Context<'_>, declared: &Value, action_id: Option<&str>) -> Result<Value, Fail> {
    let board = dashboard_actions(context, declared);
    if board.get("declared").and_then(Value::as_bool) != Some(true) || board.get("error").is_some() {
        let said = board.get("error").and_then(Value::as_str).unwrap_or("This project does not declare a dashboard in .rengine/project.json.");
        return Err(refuse(said, 415));
    }
    let wanted = action_id.unwrap_or_default();
    let action = board
        .get("groups")
        .and_then(Value::as_array)
        .and_then(|groups| {
            groups
                .iter()
                .flat_map(|group| group.get("actions").and_then(Value::as_array).cloned().unwrap_or_default())
                .find(|action| text(action, "id") == wanted)
        })
        .ok_or_else(|| refuse("Unknown dashboard action.", 404))?;
    if action.get("available").and_then(Value::as_bool) != Some(true) {
        /* The same sentence the grey button carries, in the same order the board composed it. */
        let missing: Vec<String> = action
            .get("missing")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(|item| format!("{} {}", text(item, "type"), text(item, "name"))).collect())
            .unwrap_or_default();
        return Err(refuse(format!("Action {} is unavailable: {}.", text(&action, "id"), missing.join(", ")), 409));
    }
    Ok(action)
}

pub fn capture(context: &Context<'_>, declared: &Value, action_id: Option<&str>) -> Result<Value, Fail> {
    let action = dashboard_action(context, declared, action_id)?;
    let id = text(&action, "id").to_string();
    if text(&action, "kind") != "capture" {
        return Err(refuse(format!("Action {id} is not a capture action."), 400));
    }
    let into = text(&action, "into");
    /* Lexically first, before anything is created: `into` is a root-relative path in the schema, so
       this is the guard for a declaration that reached here without passing it. */
    let target = red_store::store::js_resolve(context.root_path, into);
    let relative = red_store::store::js_relative(context.root_path, &target);
    if relative.is_empty() || relative.starts_with("..") || relative.starts_with('/') {
        return Err(refuse("Capture directory is outside the selected project root.", 403));
    }
    std::fs::create_dir_all(&target).map_err(|error| fs_refusal(&error, "mkdir", &target))?;
    let (absolute, relative) = red_store::store::resolve_in_root(context.root_path, into, false).map_err(Fail::from_store)?;
    if !std::fs::metadata(&absolute).map(|info| info.is_dir()).unwrap_or(false) {
        return Err(refuse("Capture target is not a directory.", 415));
    }

    let argv: Vec<String> = action
        .get("command")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(|item| item.as_str().unwrap_or_default().to_string()).collect())
        .unwrap_or_default();
    let run = command::run(std::path::Path::new(context.root_path), &argv, context.environment, CAPTURE_TIMEOUT_MS, CAPTURE_MAX_BYTES)
        .map_err(|failed| refuse(failed.message, failed.status))?;
    /* Judged BEFORE anything is written. A viewer shown a file named `.png` renders whatever the
       bytes turn out to be, so the signature is the whole check and it happens here. */
    if !run.stdout.starts_with(&PNG_SIGNATURE) {
        return Err(refuse("Capture output is not a PNG (signature mismatch); nothing was written.", 502));
    }

    let time = red_core::time::iso((context.now)());
    let file = free_name(context.root_path, &relative, &time.replace(':', "-"));
    let entry = object(vec![
        ("file", json!(file)),
        ("time", json!(time)),
        ("size", json!(run.stdout.len())),
        ("sha256", json!(red_store::store::sha256_hex(&run.stdout))),
        ("action", json!(id)),
    ]);

    let manifest_path = format!("{absolute}/manifest.json");
    /* A manifest this workspace cannot read is REPLACED rather than fatal: the capture a person
       just took is not lost to a file something else wrote badly. */
    let mut manifest: Vec<Value> = match std::fs::read_to_string(&manifest_path) {
        Ok(text) => serde_json::from_str::<Value>(&text).ok().and_then(|parsed| parsed.as_array().cloned()).unwrap_or_default(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(fs_refusal(&error, "open", &manifest_path)),
    };
    manifest.push(entry.clone());
    let temporary = format!("{absolute}/.rengine-capture-{}", scratch_name());
    let landed = (|| -> std::io::Result<()> {
        write_then_rename(&temporary, &run.stdout, &format!("{absolute}/{file}"))?;
        /* `JSON.stringify(manifest, null, 2)`: two-space indent and no trailing newline, so the
           file a person opens is the file the JavaScript left. */
        write_then_rename(&temporary, serde_json::to_string_pretty(&manifest)?.as_bytes(), &manifest_path)
    })();
    let _ = std::fs::remove_file(&temporary);
    landed.map_err(|error| fs_refusal(&error, "open", &temporary))?;

    let mut answer = entry.as_object().cloned().unwrap_or_default();
    answer.insert("path".into(), json!(format!("{relative}/{file}")));
    answer.insert("manifest".into(), json!(format!("{relative}/manifest.json")));
    Ok(Value::Object(answer))
}

/// A capture is named for the MOMENT it was taken, and two taken in one millisecond would be one
/// name — so the second is `<stamp>-2.png`, the third `-3`, and so on. Nothing in a record of
/// answers can make two calls share a millisecond, which is why this is a function with a test
/// rather than a line inside the one that writes.
fn free_name(root_path: &str, relative: &str, stamp: &str) -> String {
    let mut file = format!("{stamp}.png");
    let mut next = 2;
    while crate::devices::present(root_path, &format!("{relative}/{file}")) {
        file = format!("{stamp}-{next}.png");
        next += 1;
    }
    file
}

/// A scratch name nothing keeps, unique enough that two captures into one directory never collide.
fn scratch_name() -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|since| since.as_nanos()).unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

/// Write beside the destination and rename onto it, so a reader never sees half a capture.
fn write_then_rename(temporary: &str, bytes: &[u8], destination: &str) -> std::io::Result<()> {
    std::fs::write(temporary, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(temporary, std::fs::Permissions::from_mode(0o644))?;
    }
    std::fs::rename(temporary, destination)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_second_capture_in_the_same_millisecond_gets_its_own_name() {
        let root = std::env::temp_dir().join(format!("red-project-capture-{}", crate::uuid_like()));
        let shots = root.join("shots");
        std::fs::create_dir_all(&shots).expect("a directory");
        let root_path = std::fs::canonicalize(&root).expect("a real path").to_string_lossy().to_string();
        let stamp = "2026-09-14T12-00-00.000Z";
        assert_eq!(super::free_name(&root_path, "shots", stamp), format!("{stamp}.png"));
        std::fs::write(shots.join(format!("{stamp}.png")), b"one").expect("the first");
        assert_eq!(super::free_name(&root_path, "shots", stamp), format!("{stamp}-2.png"));
        std::fs::write(shots.join(format!("{stamp}-2.png")), b"two").expect("the second");
        assert_eq!(super::free_name(&root_path, "shots", stamp), format!("{stamp}-3.png"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
