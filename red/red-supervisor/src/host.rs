//! The session host of a state directory, as a launcher deals with it (F159, spec 145; spec 129).
//!
//! `launcher/sidecar.mjs`'s half of the job: find the binary, start one if the directory has none,
//! and say how old the running one is. The finding and the lock discipline are
//! [`red_core::descriptor`]'s — the same `ensure` the store, the PTY service and the supervisor take
//! their start under, because "one per directory" is one question and three answers to it was three
//! races.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use red_core::descriptor::{self, Connection};

/// `$RENGINE_RED_HOST`, then the repo's release or debug build — the order `launcher/sidecar.mjs`
/// resolved it in. A missing binary is named with the command that makes one, because this is the
/// failure a person meets running a workspace out of a fresh clone.
pub fn binary(checkout: &Path) -> Result<PathBuf, String> {
    if let Some(declared) = std::env::var("RENGINE_RED_HOST").ok().filter(|value| !value.is_empty()) {
        let named = PathBuf::from(&declared);
        if !named.exists() {
            return Err(format!("RENGINE_RED_HOST names {declared}, which does not exist."));
        }
        return Ok(named);
    }
    for profile in ["release", "debug"] {
        let candidate = checkout.join("red/target").join(profile).join("red-host");
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("The red-host binary is required (run: cargo build -p red-host, or set RENGINE_RED_HOST).".to_string())
}

/// The host serving this directory, started if there is none.
///
/// The child is detached in its own session with its output in `sidecar.log`: it outlives the
/// launcher that started it, which is the whole point of a retained workspace.
pub fn ensure(directory: &Path, checkout: &Path) -> Result<Connection, String> {
    let host = binary(checkout)?;
    let log_path = directory.join("sidecar.log");
    let held = |path: &Path| format!("Sidecar startup is still owned by {}. Check its process and sidecar.log.", path.display());
    let exited = |_path: &Path| format!("Sidecar exited during startup. See {}.", log_path.display());
    let slow = |pid: i64| format!("Sidecar PID {pid} is still starting. Inspect sidecar.log; startup ownership is retained.");
    let options = descriptor::Starting {
        directory,
        lock: "startup.lock",
        log: "sidecar.log",
        deadline: Duration::from_secs(15),
        held: &held,
        exited: &exited,
        slow: &slow,
    };
    let state = directory.to_path_buf();
    let args = vec!["--state".to_string(), directory.to_string_lossy().to_string()];
    descriptor::ensure(
        &options,
        &|| descriptor::discover_sidecar(&state),
        &|log| red_core::service::spawn_detached(&host, &args, log),
    )
}

/// How old the running host is, against the checkout it was started from.
pub struct Age {
    pub started_at: SystemTime,
    pub newest_at: SystemTime,
    pub newest_file: String,
    pub stale: bool,
}

/* The areas whose mtime is compared against the descriptor's. They are the JavaScript's list, kept
   as it was: it is the heuristic the notice already describes as one, and the record of what a
   person has been told. It predates the host being a binary (F152) — `orchestrator/server` is now
   two files — so it under-reports rather than over-reports, which is the safe direction for a
   notice that tells someone to restart. KI-126. */
pub const CODE_AREAS: [&str; 5] =
    ["orchestrator/server", "orchestrator/launcher", "orchestrator/agents", "scripts", "contracts"];

/// `sidecar.json` is written at host start, so its time is the host's — a heuristic, and the notice
/// says so.
pub fn age(state_dir: &Path, checkout: &Path, areas: &[&str]) -> Result<Option<Age>, String> {
    let descriptor = state_dir.join("sidecar.json");
    let started_at = match std::fs::metadata(&descriptor).and_then(|meta| meta.modified()) {
        Ok(at) => at,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{} cannot be read: {error}", descriptor.display())),
    };
    let mut newest_at = SystemTime::UNIX_EPOCH;
    let mut newest_file = String::new();
    for area in areas {
        let directory = checkout.join(area);
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("{} cannot be read: {error}", directory.display())),
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            /* A sidecar note beside a file is not the file changing. */
            if name.ends_with("._llm.json") {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let Ok(at) = meta.modified() else { continue };
            if at > newest_at {
                newest_at = at;
                newest_file = format!("{area}/{name}");
            }
        }
    }
    /* A second of slack, as the JavaScript had: a checkout written in the same second the host
       started is not a host running old code. */
    let stale = newest_at > started_at + Duration::from_secs(1);
    Ok(Some(Age { started_at, newest_at, newest_file, stale }))
}

/// The time a person reads, in the shape `Date.prototype.toISOString` gave them.
pub fn iso(at: SystemTime) -> String {
    let millis = at.duration_since(SystemTime::UNIX_EPOCH).map(|since| since.as_millis() as i64).unwrap_or(0);
    red_core::time::iso(millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("rengine-host-age-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("scratch");
        directory
    }

    fn touch(path: &Path, at: SystemTime) {
        let time = filetime_from(at);
        set_times(path, time);
    }

    fn filetime_from(at: SystemTime) -> Duration {
        at.duration_since(SystemTime::UNIX_EPOCH).expect("after the epoch")
    }

    #[cfg(unix)]
    fn set_times(path: &Path, since_epoch: Duration) {
        use std::os::unix::ffi::OsStrExt;
        #[repr(C)]
        struct TimeVal {
            seconds: i64,
            micros: i64,
        }
        extern "C" {
            fn utimes(path: *const std::os::raw::c_char, times: *const TimeVal) -> i32;
        }
        let value = TimeVal { seconds: since_epoch.as_secs() as i64, micros: since_epoch.subsec_micros() as i64 };
        let times = [TimeVal { seconds: value.seconds, micros: value.micros }, value];
        let mut bytes = path.as_os_str().as_bytes().to_vec();
        bytes.push(0);
        unsafe {
            utimes(bytes.as_ptr() as *const std::os::raw::c_char, times.as_ptr());
        }
    }

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
    }

    /* The JavaScript's own case, moved here with the function: a descriptor older than the code is
       stale, a newer one is not, and a sidecar note beside a file is not the file changing. */
    #[test]
    fn a_host_older_than_the_code_is_stale_and_a_sidecar_note_is_not_code() {
        let state = scratch("state");
        let checkout = scratch("checkout");
        assert!(age(&state, &checkout, &CODE_AREAS).expect("read").is_none(), "no descriptor, no host, no age");

        std::fs::write(state.join("sidecar.json"), "{}").expect("descriptor");
        std::fs::create_dir_all(checkout.join("orchestrator/server")).expect("area");
        std::fs::create_dir_all(checkout.join("contracts")).expect("area");
        let main = checkout.join("orchestrator/server/main.mjs");
        let note = checkout.join("orchestrator/server/main.mjs._llm.json");
        let schema = checkout.join("contracts/project-v1.schema.json");
        for file in [&main, &note, &schema] {
            std::fs::write(file, "").expect("file");
        }
        let started = at(1_757_237_773);
        touch(&state.join("sidecar.json"), started);
        touch(&main, at(1_757_232_000));
        touch(&schema, at(1_757_243_636));
        touch(&note, at(1_757_247_200));

        let stale = age(&state, &checkout, &CODE_AREAS).expect("read").expect("an age");
        assert!(stale.stale);
        assert_eq!(
            stale.newest_file, "contracts/project-v1.schema.json",
            "the schema counts: it is frozen in the host too, and a sidecar note does not"
        );
        assert_eq!(stale.started_at, started);

        touch(&state.join("sidecar.json"), at(1_757_245_800));
        assert!(!age(&state, &checkout, &CODE_AREAS).expect("read").expect("an age").stale);
    }
}
