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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
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

/// A pipe being read into `sink`, and whether it has passed the ceiling its caller set.
struct Pipe {
    sink: Arc<Mutex<Vec<u8>>>,
    over: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
}

impl Pipe {
    fn new() -> Pipe {
        Pipe { sink: Arc::new(Mutex::new(Vec::new())), over: Arc::new(AtomicBool::new(false)), done: Arc::new(AtomicBool::new(false)) }
    }
    fn taken(&self) -> Vec<u8> {
        self.sink.lock().expect("pipe buffer").clone()
    }
}

/// Read a pipe into its sink until it ends, the caller stops, or it passes `limit`.
///
/// The ceiling is enforced HERE rather than on the collected buffer, which is what makes it a bound
/// on memory: `runCommand` failed on the first chunk past the limit and killed the child, so a
/// producer printing without end cost a refusal in milliseconds and not a gigabyte.
/// `limit` is `None` for stderr, which keeps only its tail and never fails a run.
fn pump(mut source: impl Read, pipe: &Pipe, stop: &AtomicBool, limit: Option<usize>) {
    let mut chunk = [0u8; 8192];
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        match source.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                let mut held = pipe.sink.lock().expect("pipe buffer");
                held.extend_from_slice(&chunk[..read]);
                match limit {
                    Some(limit) if held.len() > limit => {
                        pipe.over.store(true, Ordering::Relaxed);
                        break;
                    }
                    None => {
                        let extra = held.len().saturating_sub(MAX_STDERR);
                        held.drain(..extra);
                    }
                    _ => {}
                }
            }
            /* Non-blocking on unix, so a reader can notice `stop` instead of waiting out a pipe
               something else is holding open. */
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(2)),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    pipe.done.store(true, Ordering::Relaxed);
}

/// Let a reader notice it has been stopped rather than block in `read` forever.
#[cfg(unix)]
fn unblock(source: &impl std::os::unix::io::AsRawFd) {
    unsafe {
        let fd = source.as_raw_fd();
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags != -1 {
            libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
    }
}

#[cfg(not(unix))]
fn unblock<T>(_source: &T) {}

/// Run `argv` in `root`, with `env`, bounded by `timeout_ms` and `max_bytes`.
///
/// The bound is on the CALL. `runCommand` answered on Node's `close`, which needs the exit AND the
/// stdio streams ended, and its timer refused at `timeoutMs` whether or not either had happened —
/// so a producer that exits 0 leaving a background child holding stdout was a 504, never a wait for
/// an end-of-file that is not coming. See sidecar: execution-boundary.
pub fn run(root: &Path, argv: &[String], env: &[(String, String)], timeout_ms: u64, max_bytes: usize) -> Result<Run, Failed> {
    let Some((program, rest)) = argv.split_first() else {
        return Err(Failed { message: "Cannot start : no command".into(), status: 500 });
    };
    let program = resolve_executable(root, program);
    let started = Instant::now();
    let mut command = Command::new(&program);
    command.args(rest).current_dir(root).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    command.env_clear();
    /* `shellEnvironment()`, composed HERE because this is the one path by which anything in this
       workspace executes something a project chose, and the JavaScript composed it at exactly this
       point. Composing it in a caller instead made the two halves of an availability check disagree:
       a tool only in `~/.cargo/bin` is not on `process.env.PATH`, so the board drew a grey button
       while the route that ran the action found it and ran. The caller passes its OWN environment —
       what a `tools` check reads — and this adds what a shell adds. */
    for (key, value) in red_agents::spawn::shell_environment(
        &serde_json::Map::new(),
        &env.iter().map(|(key, value)| (key.clone(), serde_json::json!(value))).collect(),
        std::env::consts::OS,
        &env.iter().find(|(key, _)| key == "HOME").map(|(_, value)| value.clone()).unwrap_or_default(),
    ) {
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
    let out = child.stdout.take().expect("piped stdout");
    let err = child.stderr.take().expect("piped stderr");
    unblock(&out);
    unblock(&err);
    let stop = Arc::new(AtomicBool::new(false));
    let (output, errors) = (Pipe::new(), Pipe::new());
    for (source, pipe, limit) in [(Source::Out(out), &output, Some(max_bytes)), (Source::Err(err), &errors, None)] {
        let (sink, over, done) = (pipe.sink.clone(), pipe.over.clone(), pipe.done.clone());
        let stop = stop.clone();
        std::thread::spawn(move || {
            let pipe = Pipe { sink, over, done };
            match source {
                Source::Out(source) => pump(source, &pipe, &stop, limit),
                Source::Err(source) => pump(source, &pipe, &stop, limit),
            }
        });
    }
    std::thread::spawn(move || {
        let _ = sender.send(child.wait());
    });

    /* Node's `close`: the process has exited AND both streams have ended. Either half missing at
       the deadline is a timeout, which is what the JavaScript's timer said. */
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let ended = |pipe: &Pipe| pipe.done.load(Ordering::Relaxed);
    let mut status = None;
    let mut overflowed = false;
    loop {
        if output.over.load(Ordering::Relaxed) {
            overflowed = true;
            break;
        }
        if status.is_none() {
            match receiver.recv_timeout(Duration::from_millis(5)) {
                Ok(exit) => status = Some(exit),
                Err(mpsc::RecvTimeoutError::Disconnected) => status = Some(Err(std::io::Error::other("the command's exit was never reported"))),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        } else if ended(&output) && ended(&errors) {
            break;
        } else {
            std::thread::sleep(Duration::from_millis(2));
        }
        if Instant::now() >= deadline {
            break;
        }
    }
    let settled = status.is_some() && ended(&output) && ended(&errors) && !overflowed;
    if !settled {
        /* The group goes first, then the readers are told to stop: the JavaScript killed the tree
           and DESTROYED both streams, and a reader still parked on a pipe a grandchild holds open
           is the one thing that could keep this call from ending. */
        terminate(pid);
        stop.store(true, Ordering::Relaxed);
    }
    let stderr = String::from_utf8_lossy(&errors.taken()).into_owned();
    if overflowed {
        return Err(Failed { message: format!("Command output exceeded {max_bytes} bytes."), status: 413 });
    }
    let Some(status) = status.filter(|_| settled) else {
        let said = first_line(&stderr);
        return Err(Failed {
            message: format!("Command timed out after {timeout_ms} ms{}", if said.is_empty() { String::new() } else { format!(": {said}") }),
            status: 504,
        });
    };
    let stdout = output.taken();
    match status {
        Ok(status) if status.success() => {
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

/// The two pipes have different types and one loop reads both.
enum Source {
    Out(std::process::ChildStdout),
    Err(std::process::ChildStderr),
}

#[cfg(unix)]
fn signal_name(status: &std::process::ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt;
    /* Node reports the SIGNAL NAME where there is no exit code, and the message is compared. */
    let named = [
        (libc::SIGHUP, "SIGHUP"), (libc::SIGINT, "SIGINT"), (libc::SIGQUIT, "SIGQUIT"), (libc::SIGILL, "SIGILL"),
        (libc::SIGTRAP, "SIGTRAP"), (libc::SIGABRT, "SIGABRT"), (libc::SIGBUS, "SIGBUS"), (libc::SIGFPE, "SIGFPE"),
        (libc::SIGKILL, "SIGKILL"), (libc::SIGUSR1, "SIGUSR1"), (libc::SIGSEGV, "SIGSEGV"), (libc::SIGUSR2, "SIGUSR2"),
        (libc::SIGPIPE, "SIGPIPE"), (libc::SIGALRM, "SIGALRM"), (libc::SIGTERM, "SIGTERM"), (libc::SIGCHLD, "SIGCHLD"),
        (libc::SIGCONT, "SIGCONT"), (libc::SIGSTOP, "SIGSTOP"), (libc::SIGTSTP, "SIGTSTP"), (libc::SIGTTIN, "SIGTTIN"),
        (libc::SIGTTOU, "SIGTTOU"), (libc::SIGURG, "SIGURG"), (libc::SIGXCPU, "SIGXCPU"), (libc::SIGXFSZ, "SIGXFSZ"),
        (libc::SIGVTALRM, "SIGVTALRM"), (libc::SIGPROF, "SIGPROF"), (libc::SIGWINCH, "SIGWINCH"), (libc::SIGSYS, "SIGSYS"),
    ];
    match status.signal() {
        /* A producer that CRASHES dies of SIGSEGV, SIGABRT or SIGBUS, and those were the three the
           first four spellings left out — the message a person reads said `SIG11`. */
        Some(signal) => named.iter().find(|(number, _)| *number == signal).map(|(_, name)| (*name).to_string()).unwrap_or_else(|| format!("SIG{signal}")),
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
    /* `path.resolve`, which NORMALISES: `./tools/run.sh` resolves to `<root>/tools/run.sh`, and the
       resolved path is what the answer's `command` carries for a person to read. */
    red_store::store::js_resolve(&root.to_string_lossy(), argv0)
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

    /// What a caller passes in production: this process's own environment, which is what the shell
    /// composition at the spawn extends. An EMPTY one is not a lighter version of it — it is a run
    /// with no PATH, where a script cannot find `sleep`.
    fn environment() -> Vec<(String, String)> {
        std::env::vars().collect()
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

    /// A crashing producer is reported by the signal's NAME, which is what Node's `close` gave.
    #[cfg(unix)]
    #[test]
    fn a_crash_is_named_rather_than_numbered() {
        let root = scratch("crash");
        let argv0 = script(&root, "crash.sh", "#!/bin/bash\nkill -SEGV $$\n");
        let failed = super::run(&root, &[argv0], &environment(), 5000, 65536).expect_err("a refusal");
        assert_eq!(failed.message, "Command failed (SIGSEGV) with no diagnostic.");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `path.resolve` normalises, and the resolved path is what the answer carries.
    #[test]
    fn a_dot_slash_argv0_is_resolved_the_way_path_resolve_resolves_it() {
        let root = scratch("dotted");
        script(&root, "say.sh", "#!/bin/bash\necho said\n");
        let run = super::run(&root, &["./tools/say.sh".to_string()], &environment(), 5000, 65536).expect("it ran");
        /* LEXICAL, like `path.resolve`: the dot segment goes and nothing else does — a symlinked
           temporary directory is still spelled the way the caller spelled its root. */
        assert_eq!(run.argv[0], root.join("tools/say.sh").to_string_lossy(), "no `/./` in the command a person reads");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_failure_carries_the_first_line_the_command_said() {
        let root = scratch("fail");
        let argv0 = script(&root, "fail.sh", "#!/bin/bash\necho \"the box is not answering\" >&2\necho \"a second line nobody should see\" >&2\nexit 7\n");
        let failed = super::run(&root, &[argv0], &environment(), 5000, 65536).expect_err("a refusal");
        assert_eq!(failed.message, "Command failed (exit 7): the box is not answering");
        assert_eq!(failed.status, 502);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The bound is the contract, and the group is what the bound applies to.
    /// The bound is on the CALL, not on the child's exit.
    ///
    /// A producer that leaves a background child holding stdout and exits 0 never reaches EOF, and
    /// Node's `close` — which is what the JavaScript answered on — never fired either: its timer
    /// refused at `timeoutMs` regardless. A port that waits for EOF after the exit answers minutes
    /// late, or never, with a route's thread parked on it.
    #[test]
    fn the_timeout_bounds_the_call_and_not_just_the_exit() {
        let root = scratch("holder");
        let argv0 = script(&root, "holder.sh", "#!/bin/bash\n( sleep 20 ) &\necho hi\nexit 0\n");
        let started = std::time::Instant::now();
        let failed = super::run(&root, &[argv0], &environment(), 400, 65536).expect_err("a refusal");
        assert_eq!(failed.message, "Command timed out after 400 ms");
        assert_eq!(failed.status, 504);
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "and it refused at the bound, not at EOF: {:?}", started.elapsed());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The byte ceiling is enforced while READING, which is what makes it a bound on memory rather
    /// than a verdict on a buffer that has already been collected.
    #[test]
    fn output_past_the_ceiling_is_refused_while_it_is_still_arriving() {
        let root = scratch("flood");
        /* Prints far past the ceiling and then exits NON-ZERO: a check that runs only on the
           success arm answers 502 about the exit code and never mentions the size. */
        let argv0 = script(&root, "flood.sh", "#!/bin/bash\nfor i in $(seq 1 200); do printf '%01000d' 0; done\nexit 3\n");
        let failed = super::run(&root, &[argv0], &environment(), 10000, 1000).expect_err("a refusal");
        assert_eq!(failed.message, "Command output exceeded 1000 bytes.");
        assert_eq!(failed.status, 413);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_timeout_takes_the_process_group_with_it() {
        let root = scratch("hang");
        let survivor = root.join("survivor.txt");
        let _ = std::fs::remove_file(&survivor);
        let argv0 = script(&root, "hang.sh", "#!/bin/bash\n( sleep 1; echo alive > survivor.txt ) &\nsleep 30\n");
        let failed = super::run(&root, &[argv0], &environment(), 300, 65536).expect_err("a refusal");
        assert_eq!(failed.message, "Command timed out after 300 ms");
        std::thread::sleep(std::time::Duration::from_millis(1600));
        assert!(!survivor.exists(), "the backgrounded writer went with its group");
        let _ = std::fs::remove_dir_all(&root);
    }
}
