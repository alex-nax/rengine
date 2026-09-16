//! The desktop windows this supervisor manages (F159, spec 144; spec 098).
//!
//! A managed window is a child process with three things attached to it: the binding it was opened
//! on, a **snapshot** of the desktop binary taken at the moment it was opened, and a control channel.
//!
//! The snapshot is the part that looks like an optimisation and is not. A layered update replaces
//! the desktop binary on disk; a window that re-execed the file by name after an update would come
//! back as a version nobody asked for, and one whose file was mid-write would not come back at all.
//! So each window runs a copy taken when it opened, under its own directory, and an update means
//! "prepare a new copy, tell the window to detach, start it on the new copy" — which is also why a
//! failed update can put the previous copy back.
//!
//! **Exit code 75 means "I detached for an update"**, and it is the whole handshake: anything else
//! is the window closing. A supervisor that could not tell the two apart would either lose a window
//! on every update or resurrect one a person closed on purpose.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::desktop::{self, Binding, Control, Instance};

/// The exit code a desktop uses to say it detached for a prepared update rather than closed.
pub const DETACHED: i32 = 75;

/// Still running, as an exit code that is not one.
const RUNNING: i32 = i32::MIN;

/// One managed desktop window.
pub struct View {
    pub owner: String,
    pub binding: Mutex<Binding>,
    /// The copy this window is running. Replaced by an update, and put back by a failed one.
    pub binary: Mutex<PathBuf>,
    pub pid: AtomicU32,
    pub control: Mutex<Option<Arc<Control>>>,
    /// The last eight kilobytes it printed, which is what a person gets when it will not start.
    pub diagnostics: Arc<Mutex<String>>,
    /// An update is switching this window's binary, so its exit is expected.
    pub updating: AtomicBool,
    /// A close was asked for and has not finished. A second is refused rather than queued.
    pub closing: AtomicBool,
    pub error: Mutex<Option<String>>,
    exit: Arc<(Mutex<i32>, Condvar)>,
}

impl View {
    /// Wait for this window to exit, or say it is still running.
    pub fn exited(&self, within: Duration) -> Option<i32> {
        let (held, waiting) = &*self.exit;
        let mut code = held.lock().expect("exit");
        let deadline = Instant::now() + within;
        while *code == RUNNING {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            let (next, _) = waiting.wait_timeout(code, left).expect("exit");
            code = next;
        }
        Some(*code)
    }

    pub fn running(&self) -> bool {
        *self.exit.0.lock().expect("exit") == RUNNING
    }

    /// Ask it to stop, and take it if it will not.
    pub fn stop(&self) {
        let pid = self.pid.load(Ordering::SeqCst) as i64;
        if pid > 0 {
            red_core::descriptor::signal(pid, red_core::descriptor::TERM);
        }
        if self.exited(Duration::from_secs(5)).is_none() && pid > 0 {
            /* SIGKILL, for a window that did not answer SIGTERM. A desktop saves its drafts on the
               first one, so this is only ever reached by one that is already wedged. */
            red_core::descriptor::signal(pid, 9);
            self.exited(Duration::from_secs(2));
        }
    }
}

/// What a window's exit means to the supervisor above it.
pub enum Ended {
    /// It detached for a prepared update — the 75 handshake.
    Detached,
    /// It closed, and the supervisor should forget it.
    Closed,
    /// It went while an update was mid-switch, which that update is already watching for.
    Expected,
}

/// Start the window's process and attach to it.
///
/// `ended` is called once, from the watcher thread, with what the exit meant. It is where a window
/// that closed is forgotten and where the keyboard-driven update is started — both of which belong
/// to the layer above this one, because they need the whole supervisor.
pub fn spawn(
    owner: &str,
    binary: &Path,
    instance: &Instance,
    binding: &Binding,
    inspect_ui: bool,
    ended: impl FnOnce(Ended) + Send + 'static,
) -> Result<Arc<View>, String> {
    let mut command = std::process::Command::new(binary);
    command.args(desktop::arguments(inspect_ui));
    for (name, value) in desktop::environment(instance, binding) {
        command.env(name, value);
    }
    let mut child = command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("Desktop would not start: {error}"))?;

    let diagnostics = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let kept = diagnostics.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut held = kept.lock().expect("diagnostics");
                held.push_str(&line);
                held.push('\n');
                if held.len() > 8000 {
                    let from = held.len() - 8000;
                    *held = held[from..].to_string();
                }
            }
        });
    }
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        return Err("Desktop started without a control channel.".to_string());
    };
    let pid = child.id();
    let view = Arc::new(View {
        owner: owner.to_string(),
        binding: Mutex::new(binding.clone()),
        binary: Mutex::new(binary.to_path_buf()),
        pid: AtomicU32::new(pid),
        control: Mutex::new(Some(Control::over(stdin, stdout))),
        diagnostics,
        updating: AtomicBool::new(false),
        closing: AtomicBool::new(false),
        error: Mutex::new(None),
        exit: Arc::new((Mutex::new(RUNNING), Condvar::new())),
    });

    let exit = view.exit.clone();
    let watched = view.clone();
    /* The child is MOVED into the waiter, which is the only thing that holds it: everyone else
       signals by pid. A handle shared behind a mutex would have to be locked to kill and locked to
       wait, and one of those blocks. */
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|over| over.code()).unwrap_or(-1);
        {
            let (held, waiting) = &*exit;
            *held.lock().expect("exit") = code;
            waiting.notify_all();
        }
        /* The channel's reader is told too: a window that went away must not leave a caller waiting
           out the five-second reply timeout on a process that is already gone. */
        if let Some(control) = watched.control.lock().expect("control").as_ref() {
            control.ended();
        }
        let meaning = if watched.updating.load(Ordering::SeqCst) {
            Ended::Expected
        } else if code == DETACHED {
            Ended::Detached
        } else {
            Ended::Closed
        };
        ended(meaning);
    });
    Ok(view)
}

/// Take a copy of the desktop binary for one window to run.
///
/// The modules the desktop loads itself travel with it (F136): the scene plugin lives beside the
/// binary in `plugins/`, and a snapshot that took only `bin/` left the desktop unable to find it —
/// clicking a model said "refused" in a version directory with no modules in it. Absent in a build
/// that made none, which is why this is a copy that may find nothing rather than a check.
pub fn snapshot(binary: &Path, directory: &Path) -> Result<PathBuf, String> {
    let destination = directory.join("bin");
    std::fs::create_dir_all(&destination).map_err(|error| format!("{} cannot be created: {error}", destination.display()))?;
    let name = binary.file_name().ok_or_else(|| format!("{} names no file", binary.display()))?;
    let copy = destination.join(name);
    if cfg!(windows) {
        let from = binary.parent().ok_or_else(|| format!("{} has no directory", binary.display()))?;
        copy_tree(from, &destination)?;
    } else {
        std::fs::copy(binary, &copy).map_err(|error| format!("{} cannot be copied: {error}", binary.display()))?;
    }
    let modules = binary.parent().and_then(Path::parent).map(|above| above.join("plugins"));
    if let Some(modules) = modules.filter(|path| path.is_dir()) {
        copy_tree(&modules, &directory.join("plugins"))?;
    }
    Ok(copy)
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|error| format!("{} cannot be created: {error}", to.display()))?;
    let entries = std::fs::read_dir(from).map_err(|error| format!("{} cannot be read: {error}", from.display()))?;
    for entry in entries.filter_map(Result::ok) {
        let source = entry.path();
        let target = to.join(entry.file_name());
        if source.is_dir() {
            copy_tree(&source, &target)?;
        } else {
            std::fs::copy(&source, &target).map_err(|error| format!("{} cannot be copied: {error}", source.display()))?;
        }
    }
    Ok(())
}

/// How a desktop that never registers is explained (spec 098).
///
/// The two things that say why are already to hand: what the process printed, and the registration a
/// worker refused **while this view was being waited for** — never an older one, which would name
/// the wrong desktop.
pub fn never_registered(refused: Option<&str>, diagnostics: &str) -> String {
    let mut why: Vec<String> = Vec::new();
    if let Some(refused) = refused {
        why.push(format!("last registration refused: {refused}"));
    }
    let said = diagnostics.trim();
    if !said.is_empty() {
        let from = said.len().saturating_sub(2000);
        why.push(format!("desktop said: {}", &said[from..]));
    }
    if why.is_empty() {
        "Replacement desktop did not register before timeout.".to_string()
    } else {
        format!("Replacement desktop did not register before timeout. {}", why.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instance() -> Instance {
        Instance { url: "http://127.0.0.1:8931".into(), token: "a".repeat(64) }
    }

    fn binding() -> Binding {
        Binding { root: "root-1".into(), owner: "owner-1".into(), view: "view-1".into(), ..Binding::default() }
    }

    fn shim(name: &str, script: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("red-supervisor-view-{name}-{}", std::process::id()));
        std::fs::write(&path, script).expect("a shim");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("executable");
        }
        path
    }

    /* The 75 handshake, which is the whole of how an update keeps a window. A supervisor that could
       not tell it from a close would either lose the window on every update or resurrect one a
       person closed on purpose. */
    #[test]
    fn a_window_that_detaches_is_told_apart_from_one_that_closes() {
        for (code, expected) in [(DETACHED, "detached"), (0, "closed")] {
            let binary = shim(&format!("exit{code}"), &format!("#!/bin/sh\nexit {code}\n"));
            let (said, heard) = std::sync::mpsc::channel();
            let view = spawn("owner-1", &binary, &instance(), &binding(), false, move |ended| {
                let _ = said.send(match ended {
                    Ended::Detached => "detached",
                    Ended::Closed => "closed",
                    Ended::Expected => "expected",
                });
            })
            .expect("spawned");
            assert_eq!(view.exited(Duration::from_secs(5)), Some(code));
            assert_eq!(heard.recv_timeout(Duration::from_secs(5)).expect("told"), expected);
            assert!(!view.running());
            let _ = std::fs::remove_file(&binary);
        }
    }

    /* A window that goes while an update is switching its binary is that update's business: the
       job is already waiting for exactly this, and forgetting the window here would race it. */
    #[test]
    fn a_window_that_goes_mid_update_is_left_to_the_update() {
        let binary = shim("midupdate", "#!/bin/sh\nsleep 0.2\nexit 0\n");
        let (said, heard) = std::sync::mpsc::channel();
        let view = spawn("owner-1", &binary, &instance(), &binding(), false, move |ended| {
            let _ = said.send(matches!(ended, Ended::Expected));
        })
        .expect("spawned");
        view.updating.store(true, Ordering::SeqCst);
        assert!(heard.recv_timeout(Duration::from_secs(5)).expect("told"), "the update owns this exit");
        let _ = std::fs::remove_file(&binary);
    }

    /* What a person gets when a window will not come back. It says both things it knows, and the
       refusal is the one seen WHILE this view was waited for — an older one names another desktop. */
    #[test]
    fn a_desktop_that_never_registers_says_both_things_it_knows() {
        assert_eq!(never_registered(None, ""), "Replacement desktop did not register before timeout.");
        let both = never_registered(Some("another view holds this owner"), "vulkan: no device\n");
        assert!(both.contains("last registration refused: another view holds this owner"), "{both}");
        assert!(both.contains("desktop said: vulkan: no device"), "{both}");
        /* Bounded: a window that printed a megabyte must not put it in a refusal. */
        let long = never_registered(None, &"x".repeat(9000));
        assert!(long.len() < 2200, "{}", long.len());
    }

    /* The snapshot is what makes an update reversible: the window runs a COPY, so replacing the
       binary on disk cannot change what a running window is, and a failed update can put the
       previous copy back. */
    #[test]
    fn a_window_runs_a_copy_and_the_modules_travel_with_it() {
        let root = std::env::temp_dir().join(format!("red-supervisor-snapshot-{}", std::process::id()));
        let built = root.join("desktop/bin");
        std::fs::create_dir_all(&built).expect("a build");
        std::fs::create_dir_all(root.join("desktop/plugins")).expect("modules");
        std::fs::write(built.join("rengine"), "#!/bin/sh\nexit 0\n").expect("a binary");
        std::fs::write(root.join("desktop/plugins/scene.so"), "module").expect("a module");
        let into = root.join("versions/owner-1");
        let copy = snapshot(&built.join("rengine"), &into).expect("a snapshot");
        assert_eq!(copy, into.join("bin/rengine"));
        assert!(copy.is_file(), "the binary travelled");
        assert!(into.join("plugins/scene.so").is_file(), "and so did the modules beside it");
        /* A build that made no modules is a copy that finds nothing, never a failure. */
        std::fs::remove_dir_all(root.join("desktop/plugins")).expect("removed");
        assert!(snapshot(&built.join("rengine"), &root.join("versions/owner-2")).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }
}
