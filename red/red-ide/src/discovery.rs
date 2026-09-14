//! Which published editors a pane's directory is inside, and whether its CLI is told to connect
//! (F103, spec 102, spec 133).
//!
//! The CLI's discovery code contains two filters — `workspaceFolders` against the working directory,
//! and a check that the lock's pid is one of the CLI's first ten ancestors — and only the first was
//! observed to fire (docs/evidence/editor-as-claude-ide-2026-09-07.md). This counts the way the CLI
//! was measured to count, and then names this workspace's own editor by port, because on a machine
//! where two workspaces bind one folder "exactly one" is never true.

use std::path::Path;

use serde_json::{json, Map, Value};

use crate::lock::{posix_resolve, signal_zero};

/// `process.kill(pid, 0)` as ide-connect.mjs read it: a process one cannot signal exists, so
/// `EPERM` is alive. The sweep's `lock::alive` reads the same call the other way (spec 133, D5).
pub fn living(pid: i64) -> bool {
    match signal_zero(pid) {
        Ok(()) => true,
        #[cfg(unix)]
        Err(errno) => errno == libc::EPERM,
        #[cfg(not(unix))]
        Err(_) => false,
    }
}

/// NFC, because a macOS path can arrive decomposed and `/work/café` must equal itself.
pub fn nfc(text: &str) -> String {
    icu_normalizer::ComposingNormalizerBorrowed::new_nfc().normalize(text).into_owned()
}

/// A path-boundary test, not a prefix test: `/work/rengine-old` is not inside `/work/rengine`.
pub fn covers(folder: &str, directory: &str, cwd: &str) -> bool {
    let a = nfc(&posix_resolve(folder, cwd));
    let b = nfc(&posix_resolve(directory, cwd));
    a == b || b.starts_with(&if a.ends_with('/') { a.clone() } else { format!("{a}/") })
}

/// `Number.isInteger(value)`: a JSON number with no fractional part, and nothing else.
pub fn as_integer(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(integer) = value.as_i64() {
        return Some(integer);
    }
    let float = value.as_f64()?;
    (float.is_finite() && float.fract() == 0.0).then_some(float as i64)
}

/// `Number(text)` for the port read off a filename. Hexadecimal, binary and octal prefixes are
/// JavaScript's; Rust's own `inf`/`nan` spellings are not.
pub fn js_number(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    let (sign, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    if digits == "Infinity" {
        return sign * f64::INFINITY;
    }
    let radix = match digits.get(..2) {
        Some("0x" | "0X") if sign > 0.0 => Some(16),
        Some("0b" | "0B") if sign > 0.0 => Some(2),
        Some("0o" | "0O") if sign > 0.0 => Some(8),
        _ => None,
    };
    if let Some(radix) = radix {
        return i64::from_str_radix(&digits[2..], radix).map(|n| n as f64).unwrap_or(f64::NAN);
    }
    if digits.chars().any(|c| c.is_ascii_alphabetic() && !matches!(c, 'e' | 'E')) {
        return f64::NAN;
    }
    sign * digits.parse::<f64>().unwrap_or(f64::NAN)
}

/// A number as JSON writes it: an integer where JavaScript would print one, `null` for NaN.
pub fn number_value(number: f64) -> Value {
    if !number.is_finite() {
        Value::Null
    } else if number.fract() == 0.0 && number.abs() < 9.007_199_254_740_992e15 {
        json!(number as i64)
    } else {
        json!(number)
    }
}

/// `String(number)`, for the port an environment variable carries.
pub fn number_text(number: f64) -> String {
    if number.is_nan() {
        "NaN".to_string()
    } else if number.is_infinite() {
        if number > 0.0 { "Infinity" } else { "-Infinity" }.to_string()
    } else if number.fract() == 0.0 && number.abs() < 1e21 {
        format!("{}", number as i64)
    } else {
        format!("{number}")
    }
}

/// One editor a lock offers for a directory, as `offeredEditors` answered it.
#[derive(Debug, Clone)]
pub struct Editor {
    pub port: f64,
    /// Absent when the lock names none: the JavaScript answered `undefined`, which JSON drops.
    pub ide_name: Option<Value>,
    pub pid: i64,
    pub ours: bool,
}

impl Editor {
    pub fn to_value(&self) -> Value {
        let mut entry = Map::new();
        entry.insert("port".into(), number_value(self.port));
        if let Some(name) = &self.ide_name {
            entry.insert("ideName".into(), name.clone());
        }
        entry.insert("pid".into(), json!(self.pid));
        entry.insert("ours".into(), json!(self.ours));
        Value::Object(entry)
    }
}

/// Every lock in `locks` whose folders cover `directory` and whose process is alive, in the order
/// `fs.readdir` lists them — sorted by name, which is libuv's doing and not the filesystem's. A
/// lock that is not JSON, names no integer pid, or declares its folders as anything but an array
/// with a covering string in it is not an editor.
pub fn offered_editors(directory: &str, locks: &Path, cwd: &str, living: &dyn Fn(i64) -> bool) -> Vec<Editor> {
    let mut found = Vec::new();
    for name in crate::lock::listing(locks) {
        let Some(stem) = name.strip_suffix(".lock") else { continue };
        let Ok(text) = std::fs::read_to_string(locks.join(&name)) else { continue };
        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
        let Some(pid) = as_integer(value.get("pid")) else { continue };
        if !living(pid) {
            continue;
        }
        let Some(folders) = value.get("workspaceFolders").and_then(Value::as_array) else { continue };
        if !folders.iter().any(|folder| folder.as_str().is_some_and(|folder| covers(folder, directory, cwd))) {
            continue;
        }
        let ide_name = value.get("ideName").cloned();
        let ours = ide_name.as_ref().and_then(Value::as_str) == Some(red_core::PRODUCT_NAME);
        found.push(Editor { port: js_number(stem), ide_name, pid, ours });
    }
    found
}

/// A CLI's auto-connect option, from its recipe's `ide` block (F113): the flags, and the variable
/// that names a port. A recipe without one gets `None`, and its command line nothing.
#[derive(Debug, Clone)]
pub struct IdeOption {
    pub flags: Vec<String>,
    pub env_var: String,
}

/// The decision, its environment, and the sentence explaining it — a pane that silently does not
/// connect is a support question, so the reason is always there even when the answer is "no".
pub fn auto_connect(
    option: Option<&IdeOption>,
    agent: &str,
    directory: &str,
    locks: &Path,
    cwd: &str,
    our_pids: &[Value],
    living: &dyn Fn(i64) -> bool,
) -> Value {
    let our_pids: Vec<i64> = our_pids.iter().filter_map(|pid| as_integer(Some(pid))).collect();
    let Some(option) = option else {
        return json!({ "flags": [], "env": {}, "reason": format!("{agent} has no auto-connect option; nothing was added to its command line.") });
    };
    let offered = offered_editors(directory, locks, cwd, living);
    if offered.is_empty() {
        return json!({ "flags": [], "env": {}, "reason": "No editor is published for this directory, so auto-connect would fail at startup." });
    }
    let name = red_core::PRODUCT_NAME;
    /* This workspace's own editor is the one whose lock names this pane's session host. Naming its
       port makes the CLI select it outright, which is the difference between connecting to the
       right editor and declining because a machine-mate's workspace also binds this folder. */
    let ours = if our_pids.is_empty() { None } else { offered.iter().find(|editor| our_pids.contains(&editor.pid) && editor.ours) };
    if let Some(ours) = ours {
        let port = number_text(ours.port);
        let reason = if offered.len() > 1 {
            format!("{} editors are published for this directory; connecting to this workspace's own on port {port}.", offered.len())
        } else {
            format!("This workspace's {name} is published for this directory; connecting on startup.")
        };
        return json!({ "flags": option.flags, "env": { &option.env_var: port }, "offered": offered.len(), "reason": reason });
    }
    if offered.len() > 1 {
        let why = if our_pids.is_empty() { "this workspace could not be identified among them" } else { "none of them is this workspace's" };
        return json!({ "flags": [], "env": {}, "offered": offered.len(),
            "reason": format!("{} editors are published for this directory and {why}, so there is nothing to choose; run /ide.", offered.len()) });
    }
    if !offered[0].ours {
        /* `${offered[0].ideName}`: a name that is not a string is printed as JavaScript prints it,
           `undefined` included. */
        let shown = match &offered[0].ide_name {
            None => "undefined".to_string(),
            Some(Value::String(text)) => text.clone(),
            Some(Value::Null) => "null".to_string(),
            Some(other) => other.to_string(),
        };
        return json!({ "flags": [], "env": {}, "reason": format!("The one editor published here is {shown}, not {name}; it is not ours to connect to.") });
    }
    json!({ "flags": option.flags, "env": {}, "offered": 1, "reason": format!("One {name} is published for this directory; connecting on startup.") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn containment_is_a_path_boundary_in_both_directions() {
        assert!(covers("/work/rengine", "/work/rengine/orchestrator", "/"));
        assert!(covers("/work/rengine", "/work/rengine", "/"));
        assert!(covers("/work/rengine/", "/work/rengine/x", "/"));
        assert!(!covers("/work/rengine", "/work/rengine-old", "/"), "a sibling whose name starts the same is not inside");
        assert!(!covers("/work/rengine-old", "/work/rengine/x", "/"));
        assert!(!covers("/work/rengine", "/work", "/"), "the parent is not inside");
        assert!(covers("/work/rengine", "/work/./rengine/../rengine/x", "/"));
        assert!(covers("rengine", "/cwd/rengine/x", "/cwd"), "a relative folder is resolved against the working directory");
    }

    #[test]
    fn paths_are_compared_in_nfc() {
        let composed = "/work/caf\u{e9}";
        let decomposed = "/work/cafe\u{301}";
        assert!(covers(composed, &format!("{decomposed}/src"), "/"));
        assert!(covers(decomposed, &format!("{composed}/src"), "/"));
    }

    #[test]
    fn a_pid_one_cannot_signal_is_alive_to_discovery() {
        assert!(living(std::process::id() as i64));
        assert!(!living(2_147_483_647));
        assert!(living(1), "EPERM means it exists");
        assert!(living(0), "this process's own group exists");
    }

    #[test]
    fn number_is_javascripts_number() {
        assert_eq!(js_number("100"), 100.0);
        assert_eq!(js_number("007"), 7.0);
        assert_eq!(js_number("1e2"), 100.0);
        assert_eq!(js_number("12.5"), 12.5);
        assert_eq!(js_number("-3"), -3.0);
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number(" 8 "), 8.0);
        assert_eq!(js_number("0x10"), 16.0);
        assert!(js_number("abc").is_nan());
        assert!(js_number("inf").is_nan(), "Rust's spelling is not JavaScript's");
        assert!(js_number("nan").is_nan());
        assert_eq!(js_number("Infinity"), f64::INFINITY);
        assert_eq!(number_value(100.0), json!(100));
        assert_eq!(number_value(12.5), json!(12.5));
        assert_eq!(number_value(f64::NAN), Value::Null);
        assert_eq!(number_text(200.0), "200");
        assert_eq!(number_text(12.5), "12.5");
        assert_eq!(number_text(f64::NAN), "NaN");
    }

    #[test]
    fn is_integer_is_number_is_integer() {
        assert_eq!(as_integer(Some(&json!(5))), Some(5));
        assert_eq!(as_integer(Some(&json!(5.0))), Some(5));
        assert_eq!(as_integer(Some(&json!(5.5))), None);
        assert_eq!(as_integer(Some(&json!("5"))), None);
        assert_eq!(as_integer(Some(&json!(true))), None);
        assert_eq!(as_integer(Some(&Value::Null)), None);
        assert_eq!(as_integer(None), None);
    }

    fn fixture(locks: &[(&str, Value)]) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!("red-ide-discovery-{}-{}", std::process::id(), locks.len()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        for (name, value) in locks {
            std::fs::write(directory.join(format!("{name}.lock")), value.to_string()).unwrap();
        }
        directory
    }

    #[test]
    fn our_editor_is_named_by_port_so_a_machine_mates_does_not_block_it() {
        let me = std::process::id() as i64;
        let name = red_core::PRODUCT_NAME;
        let locks = fixture(&[
            ("100", json!({ "pid": me, "ideName": name, "workspaceFolders": ["/work"] })),
            ("200", json!({ "pid": 1, "ideName": name, "workspaceFolders": ["/work"] })),
        ]);
        let option = IdeOption { flags: vec!["--ide".into()], env_var: "CLAUDE_CODE_SSE_PORT".into() };
        let decision = auto_connect(Some(&option), "claude", "/work", &locks, "/", &[json!(me)], &living);
        assert_eq!(decision["env"]["CLAUDE_CODE_SSE_PORT"], "100");
        assert_eq!(decision["flags"], json!(["--ide"]));
        let blind = auto_connect(Some(&option), "claude", "/work", &locks, "/", &[], &living);
        assert_eq!(blind["flags"], json!([]));
        assert!(blind["reason"].as_str().unwrap().contains("could not be identified"));
        let theirs = auto_connect(Some(&option), "claude", "/work", &locks, "/", &[json!(999)], &living);
        assert!(theirs["reason"].as_str().unwrap().contains("none of them is this workspace's"));
        let none = auto_connect(None, "codex", "/work", &locks, "/", &[], &living);
        assert_eq!(none["reason"], "codex has no auto-connect option; nothing was added to its command line.");
        let _ = std::fs::remove_dir_all(&locks);
    }

    #[test]
    fn the_lock_shape_decides_what_is_an_editor() {
        let me = std::process::id() as i64;
        let name = red_core::PRODUCT_NAME;
        let locks = fixture(&[
            ("100", json!({ "pid": me, "ideName": name })),
            ("200", json!({ "pid": me, "ideName": name, "workspaceFolders": "/work" })),
            ("300", json!({ "pid": me, "ideName": name, "workspaceFolders": [5, null, "/work"] })),
            ("400", json!({ "pid": 2_147_483_647, "ideName": name, "workspaceFolders": ["/work"] })),
            ("500", json!({ "pid": me, "workspaceFolders": ["/work"] })),
        ]);
        let mut offered = offered_editors("/work/x", &locks, "/", &living);
        offered.sort_by(|a, b| a.port.partial_cmp(&b.port).unwrap());
        assert_eq!(offered.iter().map(|e| e.port as i64).collect::<Vec<_>>(), [300, 500]);
        assert_eq!(offered[1].to_value(), json!({ "port": 500, "pid": me, "ours": false }), "no name is no key");
        let _ = std::fs::remove_dir_all(&locks);
    }
}
