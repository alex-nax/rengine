//! The lock Claude Code reads, and the rules about it (spec 102 decisions 2, 3 and 7; spec 133).
//!
//! `<directory>/<port>.lock`: the port is the FILENAME and nothing inside the file names it. The
//! CLI's parser reads six keys and ignores the rest, so `rengineWorker` rides along as the mark that
//! says a lock is ours — which is what keeps the sweep from touching VS Code's locks, which look
//! equally stale to us and are none of our business.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// How often a successor tries the port its predecessor still holds, and for how long by default.
pub const RETAKE_INTERVAL_MS: u64 = 250;
pub const RETAKE_TIMEOUT_MS: u64 = 20_000;

/// `path.join` on posix: segments joined, `.` and `..` resolved, slashes collapsed, no trailing
/// slash — and `path.join('', 'ide')` is the relative `ide`, which the JavaScript answered when
/// `CLAUDE_CONFIG_DIR` was set to nothing.
pub fn posix_join(base: &str, leaf: &str) -> String {
    let joined = if base.is_empty() { leaf.to_string() } else if leaf.is_empty() { base.to_string() } else { format!("{base}/{leaf}") };
    posix_normalize(&joined)
}

/// `path.normalize` on posix.
pub fn posix_normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let body = parts.join("/");
    if absolute {
        format!("/{body}")
    } else if body.is_empty() {
        ".".to_string()
    } else {
        body
    }
}

/// `path.resolve(p)`: absolute against `cwd`, normalised.
pub fn posix_resolve(path: &str, cwd: &str) -> String {
    if path.starts_with('/') {
        posix_normalize(path)
    } else {
        posix_join(cwd, path)
    }
}

/// The lock directory: rEngine's own override first, then the CLI's, moved by `CLAUDE_CONFIG_DIR`
/// as Anthropic documents (KI-071, F113). `env` is passed in rather than read here, because the
/// one-shot answers about an environment a caller composes.
pub fn directory(env: &dyn Fn(&str) -> Option<String>) -> String {
    if let Some(explicit) = env("RENGINE_IDE_DIRECTORY").filter(|value| !value.is_empty()) {
        return explicit;
    }
    let config = match env("CLAUDE_CONFIG_DIR") {
        Some(moved) => moved,
        None => posix_join(&env("HOME").unwrap_or_default(), ".claude"),
    };
    posix_join(&config, "ide")
}

/// `process.kill(pid, 0)` as the sweep's default read it: alive means the signal was permitted,
/// and a process one cannot signal counts as gone. `discovery::living` reads the same call the
/// other way; both are the JavaScript's, and both are kept (spec 133, D5).
pub fn alive(pid: i64) -> bool {
    signal_zero(pid).is_ok()
}

/// `kill(pid, 0)`: `Ok` when the process exists and may be signalled, otherwise the errno.
#[cfg(unix)]
pub fn signal_zero(pid: i64) -> Result<(), i32> {
    let Ok(pid) = i32::try_from(pid) else { return Err(libc::ESRCH) };
    if unsafe { libc::kill(pid, 0) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(libc::ESRCH))
    }
}

#[cfg(not(unix))]
pub fn signal_zero(_pid: i64) -> Result<(), i32> {
    Err(3)
}

/// Node's own sentence for a failed syscall: `EEXIST: file already exists, mkdir '<path>'`. The
/// JavaScript re-threw these, so a route answered the OS's words rather than this side's.
pub fn node_error(error: &std::io::Error, syscall: &str, path: &str) -> String {
    let (code, description) = match error.raw_os_error() {
        Some(errno) => errno_words(errno),
        None => ("EIO", "i/o error"),
    };
    format!("{code}: {description}, {syscall} '{path}'")
}

/// libuv's wording for the errnos a lock directory or a listener can meet.
pub fn errno_words(errno: i32) -> (&'static str, &'static str) {
    #[cfg(unix)]
    {
        match errno {
            libc::EEXIST => ("EEXIST", "file already exists"),
            libc::ENOTDIR => ("ENOTDIR", "not a directory"),
            libc::ENOENT => ("ENOENT", "no such file or directory"),
            libc::EACCES => ("EACCES", "permission denied"),
            libc::EPERM => ("EPERM", "operation not permitted"),
            libc::EROFS => ("EROFS", "read-only file system"),
            libc::EADDRINUSE => ("EADDRINUSE", "address already in use"),
            libc::EADDRNOTAVAIL => ("EADDRNOTAVAIL", "address not available"),
            libc::EISDIR => ("EISDIR", "illegal operation on a directory"),
            libc::ENOSPC => ("ENOSPC", "no space left on device"),
            libc::EMFILE => ("EMFILE", "too many open files"),
            _ => ("EIO", "i/o error"),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = errno;
        ("EIO", "i/o error")
    }
}

/// `mkdir(directory, { recursive: true, mode: 0o700 })`, with Node's sentence on failure.
pub fn create_directory(directory: &Path) -> Result<(), String> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(directory).map_err(|error| node_error(&error, "mkdir", &directory.to_string_lossy()))
}

/// The lock's text, key for key and byte for byte what `JSON.stringify(lock, null, 2)` wrote.
pub fn lock_text(host_pid: &Value, roots: &Value, auth_token: &str, worker_pid: &Value) -> String {
    let document = json!({
        "pid": host_pid,
        "workspaceFolders": roots,
        "ideName": red_core::PRODUCT_NAME,
        "transport": "ws",
        "useWebSocket": true,
        "runningInWindows": false,
        "authToken": auth_token,
        "rengineWorker": worker_pid,
    });
    serde_json::to_string_pretty(&document).expect("a lock document serialises")
}

/// Written at 0600, because it carries the token.
pub fn write_lock(path: &Path, text: &str) -> Result<(), String> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| node_error(&error, "open", &path.to_string_lossy()))?;
    file.write_all(text.as_bytes()).map_err(|error| node_error(&error, "write", &path.to_string_lossy()))
}

/// `fs.readdir`'s order, which is libuv's scandir: sorted by name, whatever the filesystem says.
/// A missing or unreadable directory lists nothing.
pub fn listing(directory: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(directory) else { return Vec::new() };
    let mut names: Vec<String> = entries.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
    names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    names
}

/// The startup sweep (spec 102 decision 3): a lock marked `rengineWorker` whose worker is gone is
/// ours to delete, because the CLI's own collection — a lock whose `pid` is dead — never fires for
/// a lock naming the long-lived session host. Anything else in the directory is left exactly as
/// it is: another IDE's lock, a file that is not JSON, a mark that is not a number.
pub fn sweep(directory: &Path, alive: &dyn Fn(i64) -> bool) -> Vec<PathBuf> {
    let mut removed = Vec::new();
    for name in listing(directory) {
        if !name.ends_with(".lock") {
            continue;
        }
        let file = directory.join(&name);
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
        /* `typeof value?.rengineWorker !== 'number'`: an integer or a float, and nothing else. */
        let Some(worker) = value.get("rengineWorker").and_then(Value::as_f64) else { continue };
        if alive(worker as i64) {
            continue;
        }
        if std::fs::remove_file(&file).is_ok() {
            removed.push(file);
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_is_nodes_join() {
        assert_eq!(posix_join("", "ide"), "ide");
        assert_eq!(posix_join("/cfg/", "ide"), "/cfg/ide");
        assert_eq!(posix_join("/cfg/../x/./y//", "ide"), "/x/y/ide");
        assert_eq!(posix_join("//cfg", "ide"), "/cfg/ide");
        assert_eq!(posix_join("relative/cfg", "ide"), "relative/cfg/ide");
        assert_eq!(posix_join("/", "ide"), "/ide");
        assert_eq!(posix_normalize("/.."), "/");
        assert_eq!(posix_normalize("../a"), "../a");
        assert_eq!(posix_normalize("a/.."), ".");
        assert_eq!(posix_resolve("/work/rengine/", "/cwd"), "/work/rengine");
        assert_eq!(posix_resolve("x", "/cwd"), "/cwd/x");
    }

    #[test]
    fn the_directory_follows_the_cli_unless_rengine_says_otherwise() {
        let env = |pairs: &'static [(&'static str, &'static str)]| move |name: &str| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| value.to_string());
        assert_eq!(directory(&env(&[("HOME", "/home/x")])), "/home/x/.claude/ide");
        assert_eq!(directory(&env(&[("HOME", "/home/x"), ("CLAUDE_CONFIG_DIR", "/cfg")])), "/cfg/ide");
        assert_eq!(directory(&env(&[("CLAUDE_CONFIG_DIR", "/cfg"), ("RENGINE_IDE_DIRECTORY", "/explicit")])), "/explicit");
        assert_eq!(directory(&env(&[("CLAUDE_CONFIG_DIR", "")])), "ide", "set to nothing is not unset");
        assert_eq!(directory(&env(&[("RENGINE_IDE_DIRECTORY", ""), ("CLAUDE_CONFIG_DIR", "/cfg/")])), "/cfg/ide", "an empty override is no override");
    }

    #[test]
    fn a_pid_one_cannot_signal_is_gone_to_the_sweep() {
        assert!(alive(std::process::id() as i64));
        assert!(!alive(2_147_483_647));
        #[cfg(unix)]
        if unsafe { libc::geteuid() } != 0 {
            assert!(!alive(1), "EPERM is not alive here, and is alive to discovery::living");
        }
    }

    #[test]
    fn the_lock_is_what_json_stringify_wrote() {
        let text = lock_text(&json!(4242), &json!(["/work/one", "/work/two"]), "T", &json!(99));
        let expected = format!(
            "{{\n  \"pid\": 4242,\n  \"workspaceFolders\": [\n    \"/work/one\",\n    \"/work/two\"\n  ],\n  \"ideName\": \"{}\",\n  \"transport\": \"ws\",\n  \"useWebSocket\": true,\n  \"runningInWindows\": false,\n  \"authToken\": \"T\",\n  \"rengineWorker\": 99\n}}",
            red_core::PRODUCT_NAME
        );
        assert_eq!(text, expected);
        assert!(lock_text(&json!(1), &json!([]), "T", &json!(1)).contains("\"workspaceFolders\": [],"), "an empty list stays on its line");
    }

    #[test]
    fn the_sweep_takes_only_ours_and_only_the_dead() {
        let directory = std::env::temp_dir().join(format!("red-ide-sweep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let write = |name: &str, text: &str| std::fs::write(directory.join(name), text).unwrap();
        write("111.lock", "{\"rengineWorker\": 2147483647}");
        write("222.lock", &format!("{{\"rengineWorker\": {}}}", std::process::id()));
        write("333.lock", "{\"pid\": 1, \"ideName\": \"VS Code\"}");
        write("444.lock", "{\"rengineWorker\": \"2147483647\"}");
        write("555.lock", "not json");
        write("666.txt", "{\"rengineWorker\": 2147483647}");
        write("777.lock", "[]");
        write("888.lock", "null");
        let removed = sweep(&directory, &alive);
        assert_eq!(removed, vec![directory.join("111.lock")]);
        let mut left: Vec<String> = std::fs::read_dir(&directory).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, ["222.lock", "333.lock", "444.lock", "555.lock", "666.txt", "777.lock", "888.lock"]);
        assert!(sweep(&directory.join("missing"), &alive).is_empty());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn a_directory_that_cannot_be_created_is_nodes_sentence() {
        let directory = std::env::temp_dir().join(format!("red-ide-mkdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("afile"), "x").unwrap();
        let file = directory.join("afile");
        assert_eq!(create_directory(&file).unwrap_err(), format!("EEXIST: file already exists, mkdir '{}'", file.display()));
        let under = file.join("ide");
        assert_eq!(create_directory(&under).unwrap_err(), format!("ENOTDIR: not a directory, mkdir '{}'", under.display()));
        assert!(create_directory(&directory.join("fresh/deeper")).is_ok());
        let _ = std::fs::remove_dir_all(&directory);
    }
}
