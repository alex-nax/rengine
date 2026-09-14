//! Running a command a project declared, under the bounds the declaration gave it (F155, spec 129).
//!
//! This is `formats.mjs`'s `runCommand`, which is the one path by which anything in this workspace
//! executes something a project chose: a format preview, a device probe, a dashboard capture. The
//! bounds are the contract — a timeout, a byte ceiling, and the project root as the working
//! directory — and so is the WORDING of each refusal, because a device that will not answer is
//! reported to a person in these sentences and nowhere else.
//!
//! The timeout kills a process GROUP on unix. A probe script that backgrounds a writer and sleeps
//! would otherwise outlive its own timeout and go on touching the project after the caller was told
//! it had stopped; `device-fixtures.mjs`'s `probe-hang.sh` is that case, and it is a test rather
//! than a comment because the difference is invisible in the exit status.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// What a run produced, or the sentence a caller shows for why it did not.
#[derive(Debug)]
pub struct Run {
    pub argv: Vec<String>,
    pub stdout: Vec<u8>,
    pub duration_ms: u128,
}

#[derive(Debug, Clone)]
pub struct Failed {
    pub message: String,
    pub status: u16,
}

const MAX_STDERR: usize = 16 * 1024;

/// The first non-blank line of what the command said about itself, trimmed.
fn first_line(stderr: &str) -> String {
    stderr.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or_default().to_string()
}

/// Run `argv` in `root`, with `env`, bounded by `timeout_ms` and `max_bytes`.
pub fn run(root: &Path, argv: &[String], env: &[(String, String)], timeout_ms: u64, max_bytes: usize) -> Result<Run, Failed> {
    let Some((program, rest)) = argv.split_first() else {
        return Err(Failed { message: "Cannot start : no command".into(), status: 500 });
    };
    let program = resolve_executable(root, program);
    let started = Instant::now();
    let mut command = Command::new(&program);
    command.args(rest).current_dir(root).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    command.env_clear();
    for (key, value) in env {
        command.env(key, value);
    }
    #[cfg(unix)]
    {
        /* Its own process group, so the timeout below can take the whole tree rather than the one
           child — `detached: true` on the JavaScript side, for the same reason. */
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return Err(Failed { message: format!("Cannot start {program}: {error}"), status: 500 }),
    };
    let pid = child.id();
    let (sender, receiver) = mpsc::channel();
    let mut out = child.stdout.take().expect("piped stdout");
    let mut err = child.stderr.take().expect("piped stderr");
    let reading = std::thread::spawn(move || {
        let mut stdout = Vec::new();
        let _ = out.read_to_end(&mut stdout);
        stdout
    });
    let erring = std::thread::spawn(move || {
        let mut stderr = Vec::new();
        let _ = err.read_to_end(&mut stderr);
        stderr
    });
    std::thread::spawn(move || {
        let _ = sender.send(child.wait());
    });
    let finished = receiver.recv_timeout(Duration::from_millis(timeout_ms));
    let stderr_text = |erring: std::thread::JoinHandle<Vec<u8>>| {
        let bytes = erring.join().unwrap_or_default();
        let tail = bytes.split_at(bytes.len().saturating_sub(MAX_STDERR)).1.to_vec();
        String::from_utf8_lossy(&tail).into_owned()
    };
    let Ok(status) = finished else {
        terminate(pid);
        let said = first_line(&stderr_text(erring));
        let _ = reading.join();
        return Err(Failed {
            message: format!("Command timed out after {timeout_ms} ms{}", if said.is_empty() { String::new() } else { format!(": {said}") }),
            status: 504,
        });
    };
    let stdout = reading.join().unwrap_or_default();
    let stderr = stderr_text(erring);
    match status {
        Ok(status) if status.success() => {
            if stdout.len() > max_bytes {
                return Err(Failed { message: format!("Command output exceeded {max_bytes} bytes."), status: 413 });
            }
            Ok(Run { argv: std::iter::once(program).chain(rest.iter().cloned()).collect(), stdout, duration_ms: started.elapsed().as_millis() })
        }
        Ok(status) => {
            let said = first_line(&stderr);
            let how = match status.code() {
                Some(code) => format!("exit {code}"),
                None => signal_name(&status),
            };
            Err(Failed {
                message: format!("Command failed ({how}){}", if said.is_empty() { " with no diagnostic.".to_string() } else { format!(": {said}") }),
                status: 502,
            })
        }
        Err(error) => Err(Failed { message: format!("Cannot start {}: {error}", argv[0]), status: 500 }),
    }
}

#[cfg(unix)]
fn signal_name(status: &std::process::ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt;
    /* Node reports the SIGNAL NAME where there is no exit code, and the message is compared. */
    match status.signal() {
        Some(libc::SIGKILL) => "SIGKILL".into(),
        Some(libc::SIGTERM) => "SIGTERM".into(),
        Some(libc::SIGINT) => "SIGINT".into(),
        Some(libc::SIGHUP) => "SIGHUP".into(),
        Some(other) => format!("SIG{other}"),
        None => "unknown".into(),
    }
}

#[cfg(not(unix))]
fn signal_name(_status: &std::process::ExitStatus) -> String {
    "unknown".into()
}

/// The whole group on unix, so nothing the command started outlives the bound it was given.
fn terminate(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
        libc::kill(pid as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
    }
}

/// A relative argv0 is the project's own file; a bare name is left for the OS to find on PATH.
fn resolve_executable(root: &Path, argv0: &str) -> String {
    if Path::new(argv0).is_absolute() || !argv0.contains('/') && !argv0.contains('\\') {
        return argv0.to_string();
    }
    root.join(argv0).to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    /* A project-relative argv0, which is what a declaration writes (`tools/probe-ok.sh`): a BARE
       name is left for the OS to find on PATH, exactly as the JavaScript left it, so a script in
       the root is not silently preferred over a program of the same name. */
    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("red-project-command-{}-{name}", std::process::id()));
        std::fs::create_dir_all(directory.join("tools")).expect("a directory");
        directory
    }

    fn script(root: &std::path::Path, name: &str, body: &str) -> String {
        let file = root.join("tools").join(name);
        std::fs::write(&file, body).expect("a script");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).expect("executable");
        }
        format!("tools/{name}")
    }

    #[test]
    fn a_failure_carries_the_first_line_the_command_said() {
        let root = scratch("fail");
        let argv0 = script(&root, "fail.sh", "#!/bin/bash\necho \"the box is not answering\" >&2\necho \"a second line nobody should see\" >&2\nexit 7\n");
        let failed = super::run(&root, &[argv0], &[], 5000, 65536).expect_err("a refusal");
        assert_eq!(failed.message, "Command failed (exit 7): the box is not answering");
        assert_eq!(failed.status, 502);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The bound is the contract, and the group is what the bound applies to.
    #[test]
    fn a_timeout_takes_the_process_group_with_it() {
        let root = scratch("hang");
        let survivor = root.join("survivor.txt");
        let _ = std::fs::remove_file(&survivor);
        let argv0 = script(&root, "hang.sh", "#!/bin/bash\n( sleep 1; echo alive > survivor.txt ) &\nsleep 30\n");
        let failed = super::run(&root, &[argv0], &[], 300, 65536).expect_err("a refusal");
        assert_eq!(failed.message, "Command timed out after 300 ms");
        std::thread::sleep(std::time::Duration::from_millis(1600));
        assert!(!survivor.exists(), "the backgrounded writer went with its group");
        let _ = std::fs::remove_dir_all(&root);
    }
}
