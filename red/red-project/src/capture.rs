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
use crate::dashboard::dashboard_action;
use crate::devices::Context;
use crate::recordings::Fail;
use crate::rules::object;

/// This module refuses with a status, like the routes it answers; `refuse` is the local spelling.
fn refuse(message: impl Into<String>, status: u16) -> Fail {
    Fail::with_status(message, status)
}

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
    let mut manifest = existing_manifest(&manifest_path).map_err(|error| fs_refusal(&error, "open", &manifest_path))?;
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

/// The rows a manifest already holds, or none.
///
/// LOSSY, because `readFile(…, 'utf8')` was: a manifest holding a byte that is not UTF-8 was decoded
/// with replacement characters and then parsed, and whether that parse succeeded or threw, the
/// capture landed either way. Refusing here would lose a capture a person just took to a file
/// something else wrote badly — the opposite of what this promises.
fn existing_manifest(path: &str) -> std::io::Result<Vec<Value>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)).ok().and_then(|parsed| parsed.as_array().cloned()).unwrap_or_default()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

/// A scratch name nothing keeps, unique enough that two captures into one directory never collide.
fn scratch_name() -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|since| since.as_nanos()).unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

/// Write beside the destination and rename onto it, so a reader never sees half a capture.
fn write_then_rename(temporary: &str, bytes: &[u8], destination: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    /* The mode goes to the OPEN, not to a `set_permissions` after it: `writeFile(…, {mode: 0o644})`
       passed it to `open`, so the person's umask applied and a private workspace kept private
       captures. Setting it afterwards makes every capture world-readable whatever they chose. */
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o644);
    }
    options.open(temporary)?.write_all(bytes)?;
    std::fs::rename(temporary, destination)
}

#[cfg(test)]
mod tests {
    /* Three rules with no corpus case, each found after the JavaScript that answered them was
       deleted, so the record they belong in can no longer be taken. */

    #[test]
    fn a_manifest_that_is_not_utf8_is_replaced_rather_than_fatal() {
        let root = std::env::temp_dir().join(format!("red-project-manifest-{}", crate::uuid_like()));
        std::fs::create_dir_all(&root).expect("a directory");
        let manifest = root.join("manifest.json");
        /* Valid JSON with one byte that is not UTF-8 inside a string: `readFile(…, 'utf8')` decoded
           it with a replacement character and parsed it, and the capture landed. */
        let mut bytes = br#"[{"file":"old.png","note":""#.to_vec();
        bytes.extend_from_slice(&[0xff, 0xfe]);
        bytes.extend_from_slice(br#""}]"#);
        std::fs::write(&manifest, &bytes).expect("a manifest");
        let held = super::existing_manifest(&manifest.to_string_lossy()).expect("read, not refused");
        assert_eq!(held.len(), 1, "the row it already held survives, replacement character and all");
        assert_eq!(super::existing_manifest(&root.join("absent.json").to_string_lossy()).expect("absent is empty").len(), 0);
        std::fs::write(&manifest, b"not json at all").expect("a manifest");
        assert_eq!(super::existing_manifest(&manifest.to_string_lossy()).expect("unreadable is empty").len(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_landed_capture_honours_the_umask() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("red-project-umask-{}", crate::uuid_like()));
        std::fs::create_dir_all(&root).expect("a directory");
        let previous = unsafe { libc::umask(0o077) };
        let landed = root.join("shot.png");
        super::write_then_rename(&root.join("scratch").to_string_lossy(), b"bytes", &landed.to_string_lossy()).expect("landed");
        let mode = std::fs::metadata(&landed).expect("stat").permissions().mode() & 0o777;
        unsafe { libc::umask(previous) };
        /* `writeFile(…, {mode: 0o644})` passed the mode to `open`, so a person working under a
           private umask kept private captures. Setting the mode afterwards overrides their choice. */
        assert_eq!(mode, 0o600, "the umask applied to the create");
        let _ = std::fs::remove_dir_all(&root);
    }

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
