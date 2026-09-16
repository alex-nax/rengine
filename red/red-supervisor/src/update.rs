//! What actually happens during a layered update (F159, spec 144; spec 065, spec 098).
//!
//! Every line of the order below is a failure that has happened, so the order is the contract:
//!
//! 1. **Prepare everything before switching anything.** A candidate worker is started and checked, a
//!    desktop binary built and snapshotted, a connector built and probed. Any of those failing is a
//!    job that failed with nothing switched and a workspace still serving.
//! 2. **The desktop detaches before the worker changes.** It is told to reload and exits 75 to say
//!    it saved and let go. A timeout here is persistence refusing, and is reported as that rather
//!    than as a generic failure — the person needs to know their drafts were the thing that said no.
//! 3. **The previous worker is preserved across the switch**, so a failure can make it current
//!    again. It is told it is retired only once the switch is COMMITTED: a worker told it was
//!    retired while it is still current would forward requests to itself.
//! 4. **A failed job puts the previous desktop back**, on the binary it was running before.
//!
//! The connector is a compiled binary now (F187), so its layer BUILDS before it probes — the
//! JavaScript worker changed as soon as the checkout did, a binary does not.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use crate::runtime::{Chosen, Supervisor, CLOSING, NOT_ACCEPTED, NOT_DETACHED};
use crate::views;
use crate::worker;

/// How long a desktop has to detach after being told to reload.
pub const DETACH_TIMEOUT: Duration = Duration::from_secs(12);
/// How long a candidate connector has to prove itself.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

impl Supervisor {
    pub(crate) fn switching(self: &Arc<Self>, chosen: Option<&Chosen>, closed: bool) -> Result<(), String> {
        let layers = self.jobs.lock().expect("jobs").running().map(|job| job.layers.clone()).unwrap_or_default();
        let has = |layer: &str| layers.iter().any(|named| named == layer);
        let job_id = self.jobs.lock().expect("jobs").running().map(|job| job.id.clone()).unwrap_or_default();
        let root_id = self.jobs.lock().expect("jobs").running().map(|job| job.root_id.clone()).unwrap_or_default();
        let previous_connector = *self.connector_generation.lock().expect("generation");

        let mut candidate: Option<Arc<worker::Child>> = None;
        let mut replacement: Option<std::path::PathBuf> = None;
        let mut previous_binary: Option<std::path::PathBuf> = None;
        let mut previous_worker: Option<Arc<worker::Child>> = None;
        let mut started_desktop = false;

        let prepared = (|| -> Result<(), String> {
            if has("workspace") {
                candidate = Some(worker::Child::start(
                    &self.host,
                    &self.worker_binary,
                    &self.state.to_string_lossy(),
                    self.ide_port,
                )?);
            }
            if has("desktop") {
                replacement = Some(self.prepare_desktop(&self.state.join("versions").join(&job_id))?);
            }
            if has("connector") {
                self.prepare_connector(&root_id)?;
            }
            if self.closing.load(Ordering::SeqCst) {
                return Err(CLOSING.to_string());
            }
            Ok(())
        })();

        let switched = prepared.and_then(|()| {
            if let Some(job) = self.jobs.lock().expect("jobs").active() {
                job.status = crate::jobs::Status::Switching;
            }
            if let Some(chosen) = chosen {
                let view = self.views.lock().expect("views").get(&chosen.owner).cloned();
                if let Some(view) = view {
                    previous_binary = Some(view.binary.lock().expect("binary").clone());
                    view.updating.store(true, Ordering::SeqCst);
                    if !closed {
                        /* Told through the worker it registered on, which may be a retiring one. */
                        let asked = json!({ "rootId": root_id, "desktopId": chosen.desktop_id, "action": "reload" });
                        red_core::descriptor::request(&chosen.worker.connection, "desktop-action", Some(&asked), &[])?;
                        match view.exited(DETACH_TIMEOUT) {
                            Some(views::DETACHED) => {}
                            Some(_) => return Err(NOT_ACCEPTED.to_string()),
                            None => return Err(NOT_DETACHED.to_string()),
                        }
                    }
                }
            }
            /* Committed. The previous worker is kept reachable until the end, so a failure below can
               make it current again — which is why it is told nothing yet. */
            if let Some(next) = candidate.take() {
                let previous = self.worker();
                self.preserve(&previous.generation);
                *self.current.lock().expect("current") = next;
                self.retiring.lock().expect("retiring").push(previous.clone());
                previous_worker = Some(previous);
            }
            if has("connector") {
                *self.connector_generation.lock().expect("generation") += 1;
            }
            self.persist()?;
            if let Some(chosen) = chosen {
                let view = self.views.lock().expect("views").get(&chosen.owner).cloned();
                if let Some(view) = view {
                    let binary = replacement.clone().unwrap_or_else(|| view.binary.lock().expect("binary").clone());
                    let binding = view.binding.lock().expect("binding").clone();
                    let restarted = self
                        .start_view(&chosen.owner, &binary, binding)
                        .map_err(|refused| refused.message)?;
                    started_desktop = true;
                    self.views.lock().expect("views").insert(chosen.owner.clone(), restarted.clone());
                    self.wait_view(&restarted).map_err(|refused| refused.message)?;
                }
            }
            if has("workspace") {
                self.clear_recovery_budget();
            }
            Ok(())
        });

        if let Err(why) = &switched {
            self.put_back(
                chosen,
                closed,
                candidate.take(),
                previous_worker.clone(),
                previous_binary,
                started_desktop,
                previous_connector,
            );
            let outcome = Err(why.clone());
            self.finish_retirement(previous_worker.as_ref(), chosen);
            return outcome;
        }
        self.finish_retirement(previous_worker.as_ref(), chosen);
        Ok(())
    }

    /// The previous worker is no longer needed for a rollback: tell it, and close it if nothing is
    /// using it. Told ONCE, and only here — this is the moment the switch is final.
    fn finish_retirement(self: &Arc<Self>, previous: Option<&Arc<worker::Child>>, chosen: Option<&Chosen>) {
        if let Some(previous) = previous {
            self.release(&previous.generation);
            if self.is_retiring(&previous.generation) {
                previous.retired();
            }
            self.retire(previous);
        }
        if let Some(chosen) = chosen {
            if let Some(view) = self.views.lock().expect("views").get(&chosen.owner) {
                view.updating.store(false, Ordering::SeqCst);
            }
        }
    }

    /// Undo whatever the failed switch managed to do, in the reverse order it did it.
    #[allow(clippy::too_many_arguments)]
    fn put_back(
        self: &Arc<Self>,
        chosen: Option<&Chosen>,
        closed: bool,
        candidate: Option<Arc<worker::Child>>,
        previous_worker: Option<Arc<worker::Child>>,
        previous_binary: Option<std::path::PathBuf>,
        started_desktop: bool,
        previous_connector: u64,
    ) {
        if let Some(candidate) = candidate {
            candidate.kill();
        }
        if let Some(previous) = previous_worker {
            /* The candidate that was made current is rejected and the previous one goes back. The
               rejected one is told it is retired HERE, because it is no longer current. */
            let rejected = self.worker();
            *self.current.lock().expect("current") = previous.clone();
            self.retiring.lock().expect("retiring").retain(|held| held.generation != previous.generation);
            self.retiring.lock().expect("retiring").push(rejected.clone());
            rejected.retired();
            self.retire(&rejected);
        }
        *self.connector_generation.lock().expect("generation") = previous_connector;
        if let Err(why) = self.persist() {
            if let Some(job) = self.jobs.lock().expect("jobs").active() {
                job.persistence_error = Some(why);
            }
        }
        let Some(chosen) = chosen else { return };
        let view = self.views.lock().expect("views").get(&chosen.owner).cloned();
        let Some(view) = view else { return };
        /* A replacement that started but never registered is taken down before the previous one is
           put back: two windows on one owner is two windows fighting over the same persistence. */
        if started_desktop && view.running() && view.error.lock().expect("error").is_none() {
            view.stop();
        }
        if self.closing.load(Ordering::SeqCst) {
            return;
        }
        let gone = closed || !view.running() || view.error.lock().expect("error").is_some();
        if !gone {
            return;
        }
        let binary = previous_binary.unwrap_or_else(|| view.binary.lock().expect("binary").clone());
        let binding = view.binding.lock().expect("binding").clone();
        match self.start_view(&chosen.owner, &binary, binding) {
            Ok(back) => {
                self.views.lock().expect("views").insert(chosen.owner.clone(), back.clone());
                match self.wait_view(&back) {
                    Ok(()) => {
                        if let Some(job) = self.jobs.lock().expect("jobs").active() {
                            job.recovered_previous_desktop = true;
                        }
                    }
                    Err(refused) => {
                        if let Some(job) = self.jobs.lock().expect("jobs").active() {
                            job.recovery_error = Some(refused.message);
                        }
                    }
                }
            }
            Err(refused) => {
                if let Some(job) = self.jobs.lock().expect("jobs").active() {
                    job.recovery_error = Some(refused.message);
                }
            }
        }
    }

    /// Build the desktop and take the copy this update would run.
    fn prepare_desktop(&self, into: &std::path::Path) -> Result<std::path::PathBuf, String> {
        if let Some(command) = std::env::var("RENGINE_DESKTOP_BUILD").ok().filter(|value| !value.is_empty()) {
            run(&command, &[], Duration::from_secs(600))?;
        }
        views::snapshot(&self.desktop_binary, into)
    }

    /// Build the connector, adopt what it built, and let it check itself.
    ///
    /// The probe is the binary answering for itself: it carries the tools the update path needs and
    /// answers bound to this root, and it says so by exiting 0.
    fn prepare_connector(&self, root_id: &str) -> Result<(), String> {
        if let Some(command) = std::env::var("RENGINE_CONNECTOR_BUILD").ok().filter(|value| !value.is_empty()) {
            run(&command, &[], Duration::from_secs(600))?;
        }
        if !self.named_connector {
            if let Ok(built) = red_core::service::serve_binary("RENGINE_RED_MCP", "red-mcp") {
                *self.connector.lock().expect("connector") = built;
            }
        }
        let context = self.state.join(format!("tool-probe-{}.json", red_core::service::uuid_v4()));
        let document = json!({
            "url": self.host.url, "token": self.host.token, "instance": self.host.instance,
            "rootId": root_id, "runtimeDirectory": self.state.to_string_lossy(),
        });
        std::fs::write(&context, document.to_string()).map_err(|error| format!("{} cannot be written: {error}", context.display()))?;
        let binary = self.connector.lock().expect("connector").clone();
        let probed = run(
            &binary.to_string_lossy(),
            &["--probe".to_string(), "--context".to_string(), context.to_string_lossy().to_string()],
            PROBE_TIMEOUT,
        );
        let _ = std::fs::remove_file(&context);
        probed.map(|_| ()).map_err(|why| format!("Candidate MCP worker failed: {why}"))
    }
}

/// One command, bounded, with whatever it said if it failed.
fn run(command: &str, args: &[String], within: Duration) -> Result<String, String> {
    let child = std::process::Command::new(command)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("{command} would not run: {error}"))?;
    let pid = child.id() as i64;
    let (over, waited) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = over.send(child.wait_with_output());
    });
    match waited.recv_timeout(within) {
        Ok(Ok(output)) => {
            let said = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            if output.status.success() {
                Ok(said)
            } else {
                Err(format!("{command} failed ({}): {}", output.status, said.trim()))
            }
        }
        Ok(Err(error)) => Err(format!("{command} failed: {error}")),
        Err(_) => {
            red_core::descriptor::signal(pid, red_core::descriptor::TERM);
            Err(format!("{command} timed out"))
        }
    }
}

/// The three-second granularity a caller sees on a detach timeout, in the unit the job reports.
pub const DETACH_TIMEOUT_MS: u64 = 12_000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_that_fails_carries_what_it_said() {
        let refused = run("/bin/sh", &["-c".into(), "echo nope >&2; exit 3".into()], Duration::from_secs(5)).expect_err("failed");
        assert!(refused.contains("nope"), "{refused}");
        assert!(refused.contains("exit"), "and the status: {refused}");
    }

    #[test]
    fn a_command_that_hangs_is_ended_rather_than_waited_on() {
        let started = std::time::Instant::now();
        let refused = run("/bin/sh", &["-c".into(), "sleep 30".into()], Duration::from_millis(200)).expect_err("timed out");
        assert!(refused.contains("timed out"), "{refused}");
        assert!(started.elapsed() < Duration::from_secs(5), "it did not wait the command out");
    }

    #[test]
    fn the_detach_timeout_is_the_one_the_javascript_gave() {
        assert_eq!(DETACH_TIMEOUT, Duration::from_millis(DETACH_TIMEOUT_MS));
    }
}
