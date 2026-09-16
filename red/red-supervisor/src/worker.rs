//! The workspace worker as a child process (F159, spec 144; spec 065).
//!
//! A supervisor's whole reason to exist is that this can be REPLACED while the session host beneath
//! keeps every PTY. So the interesting part is not starting one — it is refusing to adopt one.
//!
//! A candidate has to do three things before anything is switched to it: **start**, **say where it
//! is**, and **be the worker this supervisor asked for**. The third is the one that matters. A
//! binary from another checkout, or one pointed at a different session host, will start happily and
//! answer happily; adopting it would route this workspace's panes into somebody else's sessions. So
//! the candidate is asked for its state and the answer is checked against the host this supervisor
//! belongs to, plus the capability that says it is a worker at all.
//!
//! When a candidate fails any of the three, it is killed and the supervisor keeps serving from the
//! worker it has. That is the difference between a failed update and a broken workspace.

use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use red_core::descriptor::Connection;
use serde_json::{json, Value};

/// How long a worker gets to announce itself. Thirty seconds, which is the JavaScript's and is
/// generous on purpose: a cold binary on a loaded machine is slower than anyone expects.
pub const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

pub const TIMED_OUT: &str = "Workspace worker startup timed out.";
pub const FAILED_CHECKS: &str = "Candidate workspace failed identity/capability checks.";

/// One workspace worker: where it is, what it answers to, and what is still using it.
pub struct Child {
    pub connection: Connection,
    pub pid: u32,
    /// A fresh id per worker, so a client can tell "the worker was replaced" from "the worker
    /// restarted and happens to have the same pid".
    pub generation: String,
    process: Mutex<std::process::Child>,
    control: Mutex<Option<std::process::ChildStdin>>,
    /// Requests and sockets still on this worker. A replaced worker is not closed while either is
    /// above zero: the stream is somebody's pane.
    pub requests: AtomicUsize,
    pub streams: AtomicUsize,
    /// What it last said when it could not be reached, so `update_status` can show it.
    pub error: Mutex<Option<String>>,
}

impl Child {
    /// Start a worker for this host and keep it only if it is the one we asked for.
    pub fn start(host: &Connection, binary: &std::path::Path, state: &str, ide_port: u16) -> Result<Arc<Self>, String> {
        let mut process = std::process::Command::new(binary)
            .args([
                "--state",
                state,
                "--host",
                &host.url,
                "--host-token",
                &host.token,
                "--ide-port",
                &ide_port.to_string(),
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|error| format!("Workspace worker would not start: {error}"))?;

        /* Its diagnostics are collected for as long as it lives, because the sentence a person
           needs when a candidate will not start is whatever the candidate printed. */
        let said = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = process.stderr.take() {
            let kept = said.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let mut held = kept.lock().expect("diagnostics");
                    held.push_str(&line);
                    held.push('\n');
                    /* The last eight kilobytes, as the JavaScript kept: a worker in a crash loop
                       must not fill this process's memory with its own complaints. */
                    if held.len() > 8000 {
                        let from = held.len() - 8000;
                        *held = held[from..].to_string();
                    }
                }
            });
        }

        let announced = match process.stdout.take() {
            Some(stdout) => first_line(stdout),
            None => Err(TIMED_OUT.to_string()),
        };
        let diagnostics = || said.lock().expect("diagnostics").clone();
        let kill = |mut process: std::process::Child, why: String| -> String {
            let _ = process.kill();
            let _ = process.wait();
            why
        };
        let announced = match announced {
            Ok(line) => line,
            Err(why) => {
                let said = diagnostics();
                let why = if said.trim().is_empty() { why } else { format!("{why} {}", said.trim()) };
                return Err(kill(process, why));
            }
        };
        let Ok(ready) = serde_json::from_str::<Value>(&announced) else {
            return Err(kill(process, format!("Workspace worker announced something that is not JSON: {announced}")));
        };
        let connection = match red_core::descriptor::check_connection(&ready) {
            Ok(connection) => connection,
            Err(why) => return Err(kill(process, why)),
        };
        /* The check that stops this supervisor adopting somebody else's worker. A binary from
           another checkout starts happily and answers happily; what it cannot do is belong to this
           session host. */
        match red_core::descriptor::request(&connection, "state", None, &[]) {
            Ok(state) => {
                let same = state.get("instance").and_then(Value::as_str).unwrap_or_default() == host.instance;
                let layered = state
                    .get("capabilities")
                    .and_then(|held| held.get("layeredUpdates"))
                    .and_then(Value::as_i64)
                    == Some(1);
                if !same || !layered {
                    return Err(kill(process, FAILED_CHECKS.to_string()));
                }
            }
            Err(why) => return Err(kill(process, format!("{FAILED_CHECKS} {why}"))),
        }
        let pid = ready.get("pid").and_then(Value::as_i64).unwrap_or(process.id() as i64) as u32;
        let control = process.stdin.take();
        Ok(Arc::new(Self {
            connection,
            pid,
            generation: red_core::service::uuid_v4(),
            process: Mutex::new(process),
            control: Mutex::new(control),
            requests: AtomicUsize::new(0),
            streams: AtomicUsize::new(0),
            error: Mutex::new(None),
        }))
    }

    /// Control of the PROCESS, down its stdin — not a route, because retiring a worker is nothing to
    /// do with the workspace it serves, and not a signal, because there is no second signal on every
    /// platform this runs on.
    pub fn tell(&self, message: &Value) {
        let mut held = self.control.lock().expect("control");
        if let Some(stdin) = held.as_mut() {
            let _ = writeln!(stdin, "{message}");
            let _ = stdin.flush();
        }
    }

    pub fn retired(&self) {
        self.tell(&json!({ "type": "retired" }));
    }

    /// Told to go. The pipe is dropped after, because a worker whose supervisor went away closes on
    /// its own and a held pipe would keep it waiting.
    pub fn close(&self) {
        self.tell(&json!({ "type": "close" }));
        self.control.lock().expect("control").take();
    }

    pub fn alive(&self) -> bool {
        self.process.lock().expect("process").try_wait().map(|over| over.is_none()).unwrap_or(false)
    }

    pub fn kill(&self) {
        let mut process = self.process.lock().expect("process");
        let _ = process.kill();
        let _ = process.wait();
    }

    /// Is anything still using this worker? A replaced one is kept until nothing is.
    pub fn busy(&self) -> bool {
        self.requests.load(Ordering::SeqCst) > 0 || self.streams.load(Ordering::SeqCst) > 0
    }
}

/// The first line a child prints, or why there was not one in time.
///
/// On its own thread, because reading a pipe blocks and a candidate that hangs must not hang the
/// supervisor that is deciding whether to keep it.
fn first_line(stdout: std::process::ChildStdout) -> Result<String, String> {
    let (said, heard) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let read = BufReader::new(stdout).read_line(&mut line);
        let _ = said.send(read.ok().filter(|read| *read > 0).map(|_| line.trim_end().to_string()));
    });
    match heard.recv_timeout(STARTUP_TIMEOUT) {
        Ok(Some(line)) => Ok(line),
        /* The stream ended with nothing on it: the process exited during startup. */
        Ok(None) => Err("Workspace worker exited during startup.".to_string()),
        Err(_) => Err(TIMED_OUT.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> Connection {
        Connection {
            url: "http://127.0.0.1:1".into(),
            token: "a".repeat(64),
            instance: "11111111-2222-3333-4444-555555555555".into(),
            pid: None,
        }
    }

    fn shim(name: &str, script: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("red-supervisor-worker-{name}-{}", std::process::id()));
        std::fs::write(&path, script).expect("a shim");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("executable");
        }
        path
    }

    /* A candidate that will not start is what a broken build looks like from here, and the sentence
       a person gets has to carry whatever the candidate printed — otherwise "it did not start" is
       all anybody ever learns. */
    #[test]
    fn a_candidate_that_exits_is_refused_with_what_it_said() {
        let binary = shim("exits", "#!/bin/sh\necho 'the build is broken' >&2\nexit 1\n");
        let refused = Child::start(&host(), &binary, "/tmp", 0).map_err(|why| why).err().expect("refused");
        assert!(refused.contains("exited during startup"), "{refused}");
        assert!(refused.contains("the build is broken"), "it carries what the candidate said: {refused}");
        let _ = std::fs::remove_file(&binary);
    }

    #[test]
    fn a_candidate_that_announces_nonsense_is_refused_before_it_is_asked_anything() {
        let binary = shim("nonsense", "#!/bin/sh\necho 'listening on some port'\nsleep 30\n");
        let refused = Child::start(&host(), &binary, "/tmp", 0).map_err(|why| why).err().expect("refused");
        assert!(refused.contains("not JSON"), "{refused}");
        let _ = std::fs::remove_file(&binary);
    }

    /* Shaped like an announcement and pointing nowhere: it never gets as far as the identity check,
       because a URL that is not this machine's loopback is refused by the descriptor rule. */
    #[test]
    fn a_candidate_that_names_another_machine_is_refused() {
        let binary = shim(
            "elsewhere",
            "#!/bin/sh\necho '{\"url\":\"http://10.0.0.1:9\",\"token\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"instance\":\"11111111-2222-3333-4444-555555555555\"}'\nsleep 30\n",
        );
        let refused = Child::start(&host(), &binary, "/tmp", 0).map_err(|why| why).err().expect("refused");
        assert_eq!(refused, red_core::descriptor::INVALID);
        let _ = std::fs::remove_file(&binary);
    }

    /* The check that stops this supervisor adopting somebody else's worker. It announces itself
       perfectly and answers nothing, which is indistinguishable from a worker for another host
       until it is asked. */
    #[test]
    fn a_candidate_that_will_not_answer_for_this_host_is_refused_and_killed() {
        let binary = shim(
            "silent",
            "#!/bin/sh\necho '{\"url\":\"http://127.0.0.1:1\",\"token\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"instance\":\"11111111-2222-3333-4444-555555555555\"}'\nsleep 30\n",
        );
        let refused = Child::start(&host(), &binary, "/tmp", 0).map_err(|why| why).err().expect("refused");
        assert!(refused.starts_with(FAILED_CHECKS), "{refused}");
        let _ = std::fs::remove_file(&binary);
    }

    /// The bound itself, without waiting thirty seconds for it.
    #[test]
    fn a_candidate_that_says_nothing_at_all_is_given_a_deadline() {
        let binary = shim("mute", "#!/bin/sh\nsleep 30\n");
        let (said, heard) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = said.send(first_line(
                std::process::Command::new(&binary)
                    .stdout(std::process::Stdio::piped())
                    .spawn()
                    .expect("spawned")
                    .stdout
                    .take()
                    .expect("stdout"),
            ));
        });
        /* The deadline is thirty seconds and this test is not: what is asserted is that nothing is
           answered before one, which is the property that keeps a hung candidate from being adopted. */
        assert!(heard.recv_timeout(Duration::from_millis(300)).is_err(), "a mute candidate answers nothing early");
        assert_eq!(STARTUP_TIMEOUT, Duration::from_secs(30));
    }
}
