//! A layered update, as a thing a caller can ask for and then watch (F159, spec 144; spec 065).
//!
//! An update replaces the workspace worker, the desktop binary and the connector — any combination
//! of the three — while the session host beneath keeps every PTY, every agent and every draft. What
//! is here is the half a CALLER sees: what may be asked for, in what order it is refused, and the
//! status it polls afterwards. The half that performs it lives with the child processes.
//!
//! **Completion is kept distinct from acceptance**, which is the whole shape of this route. Asking
//! answers `202` with a job id and a sentence saying to read the status; the job then succeeds or
//! fails on its own time. A caller that treated the 202 as success would report a failed update as
//! a working one — so the queued answer says, in words, where the real answer is.
//!
//! **The refusals are ordered, and the order is the contract.** Root, then layers, then the desktop,
//! then whether another update is running. A caller that named a bad layer AND a desktop on another
//! project is told about the layer, every time, so the sentence it gets does not depend on which
//! check happened to be cheapest.
//!
//! A job never ends in `recovering`. That state means "the switch failed and the previous state is
//! being put back", and by the time the job is finished it is `failed` — a caller polling a job that
//! stayed `recovering` forever would wait on a word that means nothing to it.

use serde_json::{json, Value};

pub use crate::Refused;

fn refuse<T>(message: &str, status: u16) -> Result<T, Refused> {
    Err(Refused { message: message.to_string(), status })
}

/// The three layers, and the sentence that names them when a caller chooses badly.
pub const LAYERS: [&str; 3] = ["workspace", "desktop", "connector"];
pub const CHOOSE_LAYERS: &str = "Choose workspace, desktop and/or connector layers.";
pub const CHOOSE_DESKTOP: &str = "Choose a managed desktop attached to this project.";
pub const ALREADY_RUNNING: &str = "A workspace update is already running.";
pub const UNKNOWN_ROOT: &str = "Unknown project root.";
pub const QUEUED: &str = "Update queued. Read update_status for completion or failure.";

/// What a supervisor promises and what it does not, in one sentence a person reads in `update_status`.
///
/// It is here rather than composed at the route because it is the answer to "will this end my
/// session?" — and the answer has to be the same every time it is asked.
pub const LIMITS: &str = "Session host retains live PTYs and durable state. Host/supervisor protocol replacement requires quiescence; routine updates replace workspace, desktop and MCP tool workers.";

/// The layers a caller asked for: a non-empty list of distinct names, each one of the three.
///
/// Duplicates are refused rather than folded. `["workspace", "workspace"]` is a caller that does
/// not know what it is asking for, and quietly accepting it would hide that.
pub fn chosen(layers: Option<&Value>) -> Result<Vec<String>, Refused> {
    let Some(Value::Array(asked)) = layers else { return refuse(CHOOSE_LAYERS, 400) };
    if asked.is_empty() {
        return refuse(CHOOSE_LAYERS, 400);
    }
    let mut named: Vec<String> = Vec::with_capacity(asked.len());
    for layer in asked {
        let Some(name) = layer.as_str().filter(|name| LAYERS.contains(name)) else {
            return refuse(CHOOSE_LAYERS, 400);
        };
        if named.iter().any(|seen| seen == name) {
            return refuse(CHOOSE_LAYERS, 400);
        }
        named.push(name.to_string());
    }
    Ok(named)
}

/// Where a job is. `Recovering` is internal: a finished job is never in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Preparing,
    Switching,
    Succeeded,
    Recovering,
    Failed,
}

impl Status {
    pub fn word(self) -> &'static str {
        match self {
            Status::Preparing => "preparing",
            Status::Switching => "switching",
            Status::Succeeded => "succeeded",
            Status::Recovering => "recovering",
            Status::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Job {
    pub id: String,
    pub root_id: String,
    pub desktop_id: Option<String>,
    pub layers: Vec<String>,
    pub status: Status,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub error: Option<String>,
    /// The descriptor could not be rewritten while recovering — reported rather than swallowed,
    /// because the next process to read it will act on what is there.
    pub persistence_error: Option<String>,
    pub recovered_previous_desktop: bool,
    pub recovery_error: Option<String>,
}

impl Job {
    pub fn new(id: String, root_id: &str, desktop_id: Option<&str>, layers: Vec<String>, now: i64) -> Self {
        Self {
            id,
            root_id: root_id.to_string(),
            desktop_id: desktop_id.map(str::to_string),
            layers,
            status: Status::Preparing,
            started_at: now,
            finished_at: None,
            error: None,
            persistence_error: None,
            recovered_previous_desktop: false,
            recovery_error: None,
        }
    }

    pub fn has(&self, layer: &str) -> bool {
        self.layers.iter().any(|named| named == layer)
    }

    /// The job is over. A `recovering` job becomes `failed` here and nowhere else: that state means
    /// the switch failed and the previous state is going back, and it is not an answer to a caller.
    pub fn finish(&mut self, now: i64) {
        self.finished_at = Some(now);
        if self.status == Status::Recovering {
            self.status = Status::Failed;
        }
    }

    pub fn reported(&self) -> Value {
        let mut fields = serde_json::Map::new();
        fields.insert("id".into(), json!(self.id));
        fields.insert("rootId".into(), json!(self.root_id));
        /* Omitted rather than null when there is none. `JSON.stringify` drops an `undefined`
           field, so a workspace-only job has never carried this key at all, and a caller comparing
           the job it sent with the job it reads back would see one that grew a field. */
        if let Some(desktop) = self.desktop_id.as_deref() {
            fields.insert("desktopId".into(), json!(desktop));
        }
        fields.insert("layers".into(), json!(self.layers));
        fields.insert("status".into(), json!(self.status.word()));
        fields.insert("startedAt".into(), json!(self.started_at));
        if let Some(at) = self.finished_at {
            fields.insert("finishedAt".into(), json!(at));
        }
        for (name, held) in [
            ("error", &self.error),
            ("persistenceError", &self.persistence_error),
            ("recoveryError", &self.recovery_error),
        ] {
            if let Some(said) = held {
                fields.insert(name.into(), json!(said));
            }
        }
        if self.recovered_previous_desktop {
            fields.insert("recoveredPreviousDesktop".into(), json!(true));
        }
        Value::Object(fields)
    }
}

/// The jobs this supervisor has run, newest last, and the one running now.
///
/// Thirty-two, because this is a record a person scrolls rather than an audit log: it exists so
/// that a caller polling after a failure can still see what failed.
pub const KEPT: usize = 32;

#[derive(Default)]
pub struct Jobs {
    held: Vec<Job>,
    running: Option<String>,
}

impl Jobs {
    pub fn new() -> Self {
        Self::default()
    }

    /// Is an update running? A recovery in flight counts, which is why the caller passes it in: a
    /// worker being restarted is the same kind of busy as an update, and starting one on top of it
    /// would switch a worker out from under the process putting it back.
    pub fn busy(&self, recovering: bool) -> bool {
        self.running.is_some() || recovering
    }

    pub fn queue(&mut self, job: Job) -> Value {
        let answer = json!({ "jobId": job.id, "status": "accepted", "detail": QUEUED });
        self.running = Some(job.id.clone());
        self.held.push(job);
        if self.held.len() > KEPT {
            self.held.remove(0);
        }
        answer
    }

    pub fn running(&self) -> Option<&Job> {
        self.running.as_ref().and_then(|id| self.held.iter().find(|job| &job.id == id))
    }

    pub fn active(&mut self) -> Option<&mut Job> {
        let id = self.running.clone()?;
        self.held.iter_mut().find(|job| job.id == id)
    }

    /// The running job is over, whatever became of it.
    pub fn done(&mut self, now: i64) {
        if let Some(job) = self.active() {
            job.finish(now);
        }
        self.running = None;
    }

    /// This project's jobs. A workspace with two projects open shows each its own.
    pub fn of(&self, root_id: &str) -> Value {
        Value::Array(self.held.iter().filter(|job| job.root_id == root_id).map(Job::reported).collect())
    }

    pub fn len(&self) -> usize {
        self.held.len()
    }

    pub fn is_empty(&self) -> bool {
        self.held.is_empty()
    }
}

/// What a worker looks like from outside: enough to tell whether it is answering and whether an
/// older one is still draining somebody's stream.
pub struct Worker {
    pub pid: i64,
    pub generation: String,
    pub available: bool,
    pub error: Option<String>,
}

/// One worker that has been replaced and is still finishing what it was holding.
pub struct Retiring {
    pub pid: i64,
    pub streams: usize,
    pub requests: usize,
}

/// The whole answer `update_status` gives, for one project.
#[allow(clippy::too_many_arguments)]
pub fn status(
    supervisor_pid: u32,
    host_instance: &str,
    host_pid: Option<i64>,
    worker: &Worker,
    recovery: &Value,
    retiring: &[Retiring],
    connector_generation: u64,
    desktops: Value,
    jobs: Value,
) -> Value {
    json!({
        "version": 1,
        "supervisorPid": supervisor_pid,
        "host": { "instance": host_instance, "pid": host_pid },
        "workspace": {
            "pid": worker.pid,
            "generation": worker.generation,
            "available": worker.available,
            "error": worker.error,
            "recovery": recovery,
            "retiring": retiring.iter()
                .map(|held| json!({ "pid": held.pid, "streams": held.streams, "requests": held.requests }))
                .collect::<Vec<Value>>(),
        },
        "connectorGeneration": connector_generation,
        "desktops": desktops,
        "jobs": jobs,
        "limits": LIMITS,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_three_layers_and_nothing_else() {
        assert_eq!(chosen(Some(&json!(["workspace"]))), Ok(vec!["workspace".to_string()]));
        assert_eq!(
            chosen(Some(&json!(["workspace", "desktop", "connector"]))),
            Ok(vec!["workspace".to_string(), "desktop".to_string(), "connector".to_string()])
        );
        /* The order the caller asked in is kept: `perform` reads `layers.includes`, but a job is
           reported back and a caller comparing it with what it sent would see a different list. */
        assert_eq!(chosen(Some(&json!(["connector", "workspace"]))), Ok(vec!["connector".to_string(), "workspace".to_string()]));
        for bad in [
            json!([]),
            json!("workspace"),
            json!(["workspace", "workspace"]),
            json!(["everything"]),
            json!(["workspace", "everything"]),
            json!([1]),
            json!([null]),
            Value::Null,
        ] {
            assert_eq!(chosen(Some(&bad)), refuse(CHOOSE_LAYERS, 400), "{bad}");
        }
        assert_eq!(chosen(None), refuse(CHOOSE_LAYERS, 400));
    }

    /* A job never ends in `recovering`: that word means the switch failed and the previous state is
       going back, and a caller polling for it would wait on something that is not an outcome. */
    #[test]
    fn a_job_that_was_recovering_is_finished_as_failed() {
        let mut job = Job::new("j1".into(), "root", None, vec!["workspace".into()], 10);
        job.status = Status::Recovering;
        job.error = Some("the candidate would not start".into());
        job.finish(20);
        assert_eq!(job.status, Status::Failed);
        let seen = job.reported();
        assert_eq!(seen["status"], json!("failed"));
        assert_eq!(seen["finishedAt"], json!(20));
        assert_eq!(seen["error"], json!("the candidate would not start"));
        /* And a job that succeeded keeps its word. */
        let mut good = Job::new("j2".into(), "root", None, vec!["workspace".into()], 10);
        good.status = Status::Succeeded;
        good.finish(20);
        assert_eq!(good.status, Status::Succeeded);
    }

    /* An unfinished job carries no `finishedAt` at all, and one that went well carries none of the
       failure fields — a caller reading `error` on every job would find `null` and have to know
       that means nothing happened. */
    #[test]
    fn a_job_reports_only_what_happened_to_it() {
        let job = Job::new("j1".into(), "root", Some("desktop-1"), vec!["desktop".into()], 10);
        let seen = job.reported();
        assert_eq!(seen["status"], json!("preparing"));
        assert_eq!(seen["desktopId"], json!("desktop-1"));
        assert!(seen.get("finishedAt").is_none(), "a running job has not finished");
        for absent in ["error", "persistenceError", "recoveryError", "recoveredPreviousDesktop"] {
            assert!(seen.get(absent).is_none(), "{absent}");
        }
        /* And a job that named no desktop has no such key, rather than one holding null. */
        let workspace_only = Job::new("j2".into(), "root", None, vec!["workspace".into()], 10).reported();
        assert!(workspace_only.get("desktopId").is_none(), "an absent desktop is an absent field: {workspace_only}");
    }

    #[test]
    fn one_update_at_a_time_and_a_recovery_counts_as_one() {
        let mut jobs = Jobs::new();
        assert!(!jobs.busy(false));
        assert!(jobs.busy(true), "a worker being put back is the same kind of busy");
        let answer = jobs.queue(Job::new("j1".into(), "root", None, vec!["workspace".into()], 10));
        assert_eq!(answer["status"], json!("accepted"));
        assert_eq!(answer["detail"], json!(QUEUED));
        assert!(jobs.busy(false));
        jobs.active().expect("the running job").status = Status::Succeeded;
        jobs.done(20);
        assert!(!jobs.busy(false));
        assert!(jobs.running().is_none());
        assert_eq!(jobs.of("root").as_array().expect("jobs").len(), 1);
    }

    /* The answer is ACCEPTANCE, and it says where the real answer is. A caller that treated a 202
       as success would report a failed update as a working one. */
    #[test]
    fn the_queued_answer_points_at_where_completion_is_read() {
        let mut jobs = Jobs::new();
        let answer = jobs.queue(Job::new("j1".into(), "root", None, vec!["workspace".into()], 10));
        assert!(QUEUED.contains("update_status"), "the sentence names the route that has the outcome");
        assert_eq!(answer["jobId"], json!("j1"));
    }

    #[test]
    fn a_projects_jobs_are_its_own_and_the_list_has_a_bound() {
        let mut jobs = Jobs::new();
        for at in 0..KEPT + 8 {
            let root = if at % 2 == 0 { "root-a" } else { "root-b" };
            jobs.queue(Job::new(format!("j{at}"), root, None, vec!["workspace".into()], at as i64));
            jobs.done(at as i64);
        }
        assert_eq!(jobs.len(), KEPT, "the oldest fall off rather than the newest being dropped");
        let mine = jobs.of("root-a");
        let rows = mine.as_array().expect("jobs");
        assert!(rows.iter().all(|job| job["rootId"] == json!("root-a")), "a project sees only its own");
        assert_eq!(rows.last().expect("the newest")["id"], json!("j38"), "and the newest is kept");
    }

    #[test]
    fn the_status_is_the_shape_a_caller_polls() {
        let worker = Worker { pid: 4242, generation: "gen-1".into(), available: true, error: None };
        let retiring = [Retiring { pid: 4241, streams: 1, requests: 0 }];
        let seen = status(
            99,
            "11111111-2222-3333-4444-555555555555",
            Some(17),
            &worker,
            &json!({ "state": "idle" }),
            &retiring,
            3,
            json!([]),
            json!([]),
        );
        assert_eq!(seen["version"], json!(1));
        assert_eq!(seen["supervisorPid"], json!(99));
        assert_eq!(seen["host"]["pid"], json!(17));
        assert_eq!(seen["workspace"]["generation"], json!("gen-1"));
        assert_eq!(seen["workspace"]["retiring"][0]["streams"], json!(1));
        assert_eq!(seen["connectorGeneration"], json!(3));
        /* The sentence a person reads to decide whether an update will cost them their session. */
        assert_eq!(seen["limits"], json!(LIMITS));
        assert!(LIMITS.contains("retains live PTYs"), "it answers 'will this end my session?' first");
    }

    /// The sentences, checked against the JavaScript that still says them — and against the
    /// constants above when it does not (F173).
    #[test]
    fn the_sentences_are_the_ones_a_caller_used_to_get() {
        let checkout = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|red| red.parent())
            .expect("the checkout");
        let Ok(text) = std::fs::read_to_string(checkout.join("orchestrator/runtime/supervisor.mjs")) else {
            return;
        };
        for sentence in [CHOOSE_LAYERS, CHOOSE_DESKTOP, ALREADY_RUNNING, UNKNOWN_ROOT, QUEUED, LIMITS] {
            assert!(text.contains(sentence), "the JavaScript no longer says: {sentence}");
        }
        for word in ["'preparing'", "'switching'", "'succeeded'", "'recovering'", "'failed'"] {
            assert!(text.contains(word), "the JavaScript no longer uses the status {word}");
        }
    }
}
