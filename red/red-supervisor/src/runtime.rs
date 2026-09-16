//! The supervisor itself: what it holds, and the four things it does with it (F159, spec 144).
//!
//! It holds one **current** worker and however many **retiring** ones still have somebody's stream
//! on them; the managed desktop windows; the project-window store; and the job list. What it does is
//! open a window, list what is open, perform a layered update, and put things back when one fails.
//!
//! The ordering inside a layered update is the part worth reading, because every line of it is a
//! failure that has happened:
//!
//! 1. **Prepare everything before switching anything.** A candidate worker is started and checked, a
//!    desktop binary is built and snapshotted, a connector is built and probed — and any of those
//!    failing is a job that failed with nothing switched.
//! 2. **The desktop detaches before the worker changes.** It is told to reload, and it exits 75 to
//!    say it saved and let go. A timeout here is persistence refusing, and it is reported as that.
//! 3. **The previous worker is preserved across the switch**, so a failure can make it current
//!    again. It is told it is retired only once the switch is COMMITTED — a worker told it was
//!    retired while it is still current would be forwarding requests to itself.
//! 4. **A failed job puts the previous desktop back**, on the binary it was running before.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use red_core::descriptor::{self, Connection};
use serde_json::{json, Value};

use crate::desktop::{Binding, Instance};
use crate::jobs::{self, Job, Jobs, Refused, Status};
use crate::views::{self, Ended, View};
use crate::windows::Windows;
use crate::worker;

pub const NO_HOST: &str = "Original session host is no longer available.";
pub const ROOT_REQUIRED: &str = "Initial root must be explicit (empty for an empty workspace).";
pub const FOREIGN_SESSION: &str = "Initial session belongs to another root.";
pub const BINDINGS_CHANGED: &str = "Project window bindings changed.";
pub const CLOSING: &str = "Supervisor is closing.";
pub const NOT_DETACHED: &str = "Desktop did not detach; persistence may have refused the update.";
pub const NOT_ACCEPTED: &str = "Desktop closed without accepting the prepared update.";
pub const AUTH_REQUIRED: &str = "Workspace authentication required.";
pub const WAIT_FOR_UPDATE: &str = "Wait for the current workspace update.";
pub const WINDOW_CLOSED: &str = "Project window is closed; reopen it explicitly.";
pub const CHOOSE_ACTION: &str = "Choose inspect, focus, close or reopen.";
pub const CLOSE_PENDING: &str = "Window close is already pending.";
pub const CLOSE_REJECTED: &str = "Native window rejected close.";
pub const CLOSE_UNFINISHED: &str = "Window did not finish a normal close; inspect its persistence status.";
pub const SELECT_AGENT: &str = "Select a running agent bound to the originating project.";
pub const DIFFERENT_PROJECT: &str = "Select a different integration project.";
pub const UNKNOWN_ACTION: &str = "Unknown desktop action.";
pub const NO_SNAPSHOT: &str = "Native snapshot failed.";

/// How long a replacement desktop has to register before the update gives up on it.
const REGISTER_TIMEOUT: Duration = Duration::from_secs(10);

fn refuse<T>(message: &str, status: u16) -> Result<T, Refused> {
    Err(Refused { message: message.to_string(), status })
}

fn failed<T>(message: &str) -> Result<T, Refused> {
    refuse(message, 400)
}

pub struct Supervisor {
    pub state: PathBuf,
    pub host: Connection,
    /// What this supervisor's own clients present.
    pub token: String,
    pub url: Mutex<String>,
    /// One port for this runtime's whole life, handed to every worker it starts. Claude Code
    /// reconnects to the port it first read and never re-reads the directory, so a port that moved
    /// with each worker would end every IDE session on every layered update (KI-066).
    pub ide_port: u16,
    pub worker_binary: PathBuf,
    pub connector: Mutex<PathBuf>,
    /// A caller that named its own connector keeps it: only the default path may move on an update.
    pub named_connector: bool,
    pub desktop_binary: PathBuf,
    pub inspect_ui: bool,
    pub current: Mutex<Arc<worker::Child>>,
    pub retiring: Mutex<Vec<Arc<worker::Child>>>,
    /// Workers that must not be closed yet because a switch may still put them back.
    preserved: Mutex<Vec<String>>,
    pub windows: Mutex<Windows>,
    pub views: Mutex<BTreeMap<String, Arc<View>>>,
    opening: Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
    pub jobs: Mutex<Jobs>,
    pub connector_generation: Mutex<u64>,
    pub recovery: Mutex<Value>,
    pub recovering: AtomicBool,
    /// Automatic recovery is used ONCE between successful updates: a worker that crashes on every
    /// start would otherwise be restarted forever, and the loop looks like a working workspace.
    recovery_used: AtomicBool,
    pub closing: AtomicBool,
}

impl Supervisor {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        state: PathBuf,
        host: Connection,
        ide_port: u16,
        worker_binary: PathBuf,
        connector: PathBuf,
        named_connector: bool,
        desktop_binary: PathBuf,
        inspect_ui: bool,
        current: Arc<worker::Child>,
        windows: Windows,
    ) -> Arc<Self> {
        Arc::new(Self {
            state,
            host,
            token: red_core::service::secret(),
            url: Mutex::new(String::new()),
            ide_port,
            worker_binary,
            connector: Mutex::new(connector),
            named_connector,
            desktop_binary,
            inspect_ui,
            current: Mutex::new(current),
            retiring: Mutex::new(Vec::new()),
            preserved: Mutex::new(Vec::new()),
            windows: Mutex::new(windows),
            views: Mutex::new(BTreeMap::new()),
            opening: Mutex::new(BTreeMap::new()),
            jobs: Mutex::new(Jobs::new()),
            connector_generation: Mutex::new(1),
            recovery: Mutex::new(json!({ "state": "idle" })),
            recovering: AtomicBool::new(false),
            recovery_used: AtomicBool::new(false),
            closing: AtomicBool::new(false),
        })
    }

    pub fn worker(&self) -> Arc<worker::Child> {
        self.current.lock().expect("current").clone()
    }

    fn instance(&self) -> Instance {
        Instance { url: self.url.lock().expect("url").clone(), token: self.token.clone() }
    }

    /// The session host's own state, and the check that it is still the host this belongs to.
    pub fn host_state(&self) -> Result<Value, Refused> {
        let state = descriptor::request(&self.host, "state", None, &[]).map_err(|why| Refused { message: why, status: 502 })?;
        if state.get("instance").and_then(Value::as_str).unwrap_or_default() != self.host.instance {
            return failed(NO_HOST);
        }
        Ok(state)
    }

    /// This project, or the refusal that says the host does not have it.
    pub fn own_root(&self, root_id: &str) -> Result<Value, Refused> {
        let state = self.host_state()?;
        let known = state
            .get("roots")
            .and_then(Value::as_array)
            .is_some_and(|roots| roots.iter().any(|root| root.get("id").and_then(Value::as_str) == Some(root_id)));
        if known {
            Ok(state)
        } else {
            refuse(jobs::UNKNOWN_ROOT, 404)
        }
    }

    /// Every worker this supervisor has: the current one first, then the ones still draining.
    fn all_workers(&self) -> Vec<Arc<worker::Child>> {
        let mut all = vec![self.worker()];
        all.extend(self.retiring.lock().expect("retiring").iter().cloned());
        all
    }

    /// The desktops attached through any of this supervisor's workers, with the worker each came
    /// from. A retiring worker still holds the desktops that registered on it.
    fn attached(&self, root_id: &str) -> Vec<(Arc<worker::Child>, Value)> {
        let mut found = Vec::new();
        for held in self.all_workers() {
            let route = format!("desktops?rootId={}", red_core::http::encode(root_id));
            match descriptor::request(&held.connection, &route, None, &[]) {
                Ok(answer) => {
                    *held.error.lock().expect("error") = None;
                    for desktop in answer.get("desktops").and_then(Value::as_array).cloned().unwrap_or_default() {
                        found.push((held.clone(), desktop));
                    }
                }
                Err(why) => *held.error.lock().expect("error") = Some(why),
            }
        }
        found
    }

    /// A desktop as a caller sees it: whether this supervisor manages it, and the process if so.
    fn public(&self, desktop: &Value) -> Value {
        let mut seen = desktop.as_object().cloned().unwrap_or_default();
        let owner = desktop.get("owner").and_then(Value::as_str).unwrap_or_default();
        let view = self.views.lock().expect("views").get(owner).cloned();
        seen.insert("managed".into(), json!(view.is_some()));
        /* `pid` is omitted for one this supervisor does not manage, rather than null: the JavaScript
           wrote `undefined` there and `JSON.stringify` dropped the key. */
        if let Some(view) = view {
            seen.insert("pid".into(), json!(view.pid.load(Ordering::SeqCst)));
        }
        Value::Object(seen)
    }

    pub fn desktops(&self, root_id: &str) -> Result<Value, Refused> {
        self.own_root(root_id)?;
        Ok(Value::Array(self.attached(root_id).iter().map(|(_, desktop)| self.public(desktop)).collect()))
    }

    /// What `update_status` answers for one project.
    pub fn status(&self, root_id: &str) -> Result<Value, Refused> {
        let desktops = self.desktops(root_id)?;
        let current = self.worker();
        let retiring: Vec<jobs::Retiring> = self
            .retiring
            .lock()
            .expect("retiring")
            .iter()
            .map(|held| jobs::Retiring {
                pid: held.pid as i64,
                streams: held.streams.load(Ordering::SeqCst),
                requests: held.requests.load(Ordering::SeqCst),
            })
            .collect();
        let described = jobs::Worker {
            pid: current.pid as i64,
            generation: current.generation.clone(),
            available: current.alive(),
            error: current.error.lock().expect("error").clone(),
        };
        Ok(jobs::status(
            std::process::id(),
            &self.host.instance,
            self.host.pid,
            &described,
            &self.recovery.lock().expect("recovery").clone(),
            &retiring,
            *self.connector_generation.lock().expect("generation"),
            desktops,
            self.jobs.lock().expect("jobs").of(root_id),
        ))
    }

    /// The descriptor that says where this supervisor is, written whole or not at all.
    pub fn persist(&self) -> Result<(), String> {
        let document = json!({
            "version": 1,
            "pid": std::process::id(),
            "token": self.token,
            "instance": self.host.instance,
            "host": host_document(&self.host),
            "directory": self.state.to_string_lossy(),
            "url": self.url.lock().expect("url").clone(),
            "connectorGeneration": *self.connector_generation.lock().expect("generation"),
            "toolWorker": self.connector.lock().expect("connector").to_string_lossy(),
            "idePort": self.ide_port,
        });
        let filename = self.state.join("runtime.json");
        let temporary = self.state.join(format!("runtime.json.{}.tmp", std::process::id()));
        write_private(&temporary, &document.to_string()).map_err(|error| format!("{} cannot be written: {error}", temporary.display()))?;
        std::fs::rename(&temporary, &filename).map_err(|error| format!("{} cannot be written: {error}", filename.display()))
    }

    /// Close a replaced worker, but only once nothing is using it and no switch may put it back.
    pub fn retire(&self, held: &Arc<worker::Child>) {
        let mut retiring = self.retiring.lock().expect("retiring");
        let listed = retiring.iter().any(|other| other.generation == held.generation);
        if !listed || held.busy() || self.preserved.lock().expect("preserved").contains(&held.generation) {
            return;
        }
        retiring.retain(|other| other.generation != held.generation);
        drop(retiring);
        held.close();
    }

    /// A worker that went away on its own is replaced ONCE between successful updates.
    ///
    /// A worker that crashes on every start would otherwise be restarted forever, and a workspace
    /// restarting in a loop looks from outside like a working one.
    pub fn recover(self: &Arc<Self>) {
        let previous = self.worker();
        /* The whole decision under one lock, so two callers cannot both take the one budget — and
           so that ASKING does not spend it. Consuming the flag in the condition burned the budget on
           every call, and `perform` calls this at the end of every job: one update was enough to
           leave a workspace with no recovery left, and nothing said so. */
        {
            let mut recovery = self.recovery.lock().expect("recovery");
            if self.closing.load(Ordering::SeqCst)
                || self.recovering.load(Ordering::SeqCst)
                || self.recovery_used.load(Ordering::SeqCst)
                || previous.alive()
            {
                return;
            }
            self.recovery_used.store(true, Ordering::SeqCst);
            self.recovering.store(true, Ordering::SeqCst);
            *recovery = json!({ "state": "restarting", "previousPid": previous.pid });
        }
        let held = self.clone();
        std::thread::spawn(move || {
            match worker::Child::start(&held.host, &held.worker_binary, &held.state.to_string_lossy(), held.ide_port) {
                Ok(next) => {
                    if held.closing.load(Ordering::SeqCst) {
                        next.kill();
                    } else {
                        let pid = next.pid;
                        *held.current.lock().expect("current") = next;
                        held.retiring.lock().expect("retiring").push(previous.clone());
                        held.retire(&previous);
                        *held.recovery.lock().expect("recovery") =
                            json!({ "state": "recovered", "previousPid": previous.pid, "pid": pid });
                    }
                }
                Err(why) => *held.recovery.lock().expect("recovery") = json!({ "state": "failed", "error": why }),
            }
            held.recovering.store(false, Ordering::SeqCst);
        });
    }

    /// Open a desktop window, or hand back the one that already answers this binding.
    pub fn open_desktop(self: &Arc<Self>, data: &Value) -> Result<Value, Refused> {
        let Some(root) = data.get("root").and_then(Value::as_str) else { return failed(ROOT_REQUIRED) };
        let key = ["windowId", "root", "terminal", "agent", "game"]
            .iter()
            .map(|name| data.get(*name).and_then(Value::as_str).unwrap_or_default().to_string())
            .collect::<Vec<String>>()
            .join("\u{1f}");
        /* One open at a time per binding: two callers asking for the same window together get one
           window, because the second finds the first's once it has the turn. */
        let turn = {
            let mut opening = self.opening.lock().expect("opening");
            opening.entry(key.clone()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
        };
        let _held = turn.lock().expect("opening");
        let opened = self.open_view(root, data);
        self.opening.lock().expect("opening").remove(&key);
        opened
    }

    fn open_view(self: &Arc<Self>, root: &str, data: &Value) -> Result<Value, Refused> {
        let state = if root.is_empty() { self.host_state()? } else { self.own_root(root)? };
        let text = |name: &str| data.get(name).and_then(Value::as_str).unwrap_or_default();
        let linked = match (text("windowId"), text("originRootId")) {
            ("", _) => None,
            (window, origin) => Some(self.windows.lock().expect("windows").get(origin, window)?),
        };
        if let Some(linked) = linked.as_ref() {
            let same_project = linked.get("projectRootId").and_then(Value::as_str).unwrap_or_default() == root;
            let same_agent = linked.get("agentId").and_then(Value::as_str).unwrap_or_default() == text("agent");
            if !same_project || !same_agent {
                return refuse(BINDINGS_CHANGED, 403);
            }
        }
        /* A pane this window opens on has to belong to this project — except an AGENT on a project
           window, which belongs to the root that opened it. That is the whole point of a project
           window: somebody else's agent, looking at your project. */
        let sessions = state.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
        for name in ["terminal", "agent", "game"] {
            let asked = text(name);
            if asked.is_empty() {
                continue;
            }
            let origin = linked.as_ref().and_then(|window| window.get("originRootId")).and_then(Value::as_str);
            let allowed = sessions.iter().any(|session| {
                session.get("id").and_then(Value::as_str) == Some(asked)
                    && (session.get("rootId").and_then(Value::as_str) == Some(root)
                        || (name == "agent" && origin.is_some() && session.get("rootId").and_then(Value::as_str) == origin))
            });
            if !allowed {
                return refuse(FOREIGN_SESSION, 403);
            }
        }
        let binding = Binding {
            window_id: Some(text("windowId")).filter(|held| !held.is_empty()).map(str::to_string),
            title: linked.as_ref().and_then(|window| window.get("title")).and_then(Value::as_str).map(str::to_string),
            root: root.to_string(),
            terminal: Some(text("terminal")).filter(|held| !held.is_empty()).map(str::to_string),
            agent: Some(text("agent")).filter(|held| !held.is_empty()).map(str::to_string),
            game: Some(text("game")).filter(|held| !held.is_empty()).map(str::to_string),
            resume: data.get("resume") == Some(&Value::Bool(true)),
            owner: String::new(),
            view: String::new(),
        };
        /* Already open on exactly this binding: the same window, not a second one beside it. */
        let same = self
            .views
            .lock()
            .expect("views")
            .values()
            .find(|view| {
                let held = view.binding.lock().expect("binding");
                held.window_id == binding.window_id
                    && held.root == binding.root
                    && held.terminal == binding.terminal
                    && held.agent == binding.agent
                    && held.game == binding.game
            })
            .cloned();
        if let Some(same) = same {
            self.wait_view(&same)?;
            return Ok(json!({ "owner": same.owner, "pid": same.pid.load(Ordering::SeqCst), "reused": true }));
        }
        let owner = match binding.window_id.clone() {
            Some(window) => window,
            None => red_core::service::uuid_v4(),
        };
        let binary = views::snapshot(&self.desktop_binary, &self.state.join("versions").join(&owner))
            .map_err(|why| Refused { message: why, status: 500 })?;
        let view = self.start_view(&owner, &binary, binding)?;
        self.views.lock().expect("views").insert(owner.clone(), view.clone());
        match self.wait_view(&view) {
            Ok(()) => Ok(json!({ "owner": owner, "pid": view.pid.load(Ordering::SeqCst), "reused": false })),
            Err(why) => {
                view.stop();
                self.views.lock().expect("views").remove(&owner);
                Err(why)
            }
        }
    }

    /// Start (or restart) one window's process, with a fresh view id so its registration is its own.
    pub fn start_view(self: &Arc<Self>, owner: &str, binary: &Path, mut binding: Binding) -> Result<Arc<View>, Refused> {
        binding.owner = owner.to_string();
        binding.view = red_core::service::uuid_v4();
        let held = self.clone();
        let named = owner.to_string();
        views::spawn(owner, binary, &self.instance(), &binding, self.inspect_ui, move |ended| match ended {
            Ended::Closed => {
                held.views.lock().expect("views").remove(&named);
            }
            Ended::Detached => held.keyboard_update(&named),
            Ended::Expected => {}
        })
        .map_err(|why| Refused { message: why, status: 500 })
    }

    /// Wait for a window to register itself through one of this supervisor's workers.
    ///
    /// Registration rather than "the process is running", because a window that started and could
    /// not reach the workspace is not a window a person can use — and the refusal a worker gave
    /// WHILE this view was being waited for is the sentence that says why (spec 098).
    pub fn wait_view(&self, view: &Arc<View>) -> Result<(), Refused> {
        let started = red_core::time::iso(now());
        let deadline = Instant::now() + REGISTER_TIMEOUT;
        let mut refused: Option<String> = None;
        while Instant::now() < deadline {
            if !view.running() {
                let said = view.error.lock().expect("error").clone().unwrap_or_else(|| view.diagnostics.lock().expect("diagnostics").clone());
                return failed(&format!("Replacement desktop exited: {said}"));
            }
            let wanted = view.binding.lock().expect("binding").view.clone();
            for held in self.all_workers() {
                let Ok(answer) = descriptor::request(&held.connection, "runtime-desktops", None, &[]) else { continue };
                let listed = answer.get("desktops").and_then(Value::as_array).cloned().unwrap_or_default();
                if listed.iter().any(|desktop| {
                    desktop.get("owner").and_then(Value::as_str) == Some(view.owner.as_str())
                        && desktop.get("view").and_then(Value::as_str) == Some(wanted.as_str())
                }) {
                    return Ok(());
                }
                /* Only a refusal seen since this wait began: an older one names another desktop. */
                if let Some(error) = answer.get("registerError") {
                    let at = error.get("at").and_then(Value::as_str).unwrap_or_default();
                    if at >= started.as_str() {
                        refused = error.get("message").and_then(Value::as_str).map(str::to_string);
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(75));
        }
        let said = view.diagnostics.lock().expect("diagnostics").clone();
        failed(&views::never_registered(refused.as_deref(), &said))
    }

    /// The person pressed the desktop's own update key, and it detached expecting to come back.
    fn keyboard_update(self: &Arc<Self>, owner: &str) {
        let Some(view) = self.views.lock().expect("views").get(owner).cloned() else { return };
        /* An update is already running and will restart this window itself; starting a second one
           here would race it for the same binary directory. */
        if self.jobs.lock().expect("jobs").busy(self.recovering.load(Ordering::SeqCst)) {
            let binary = view.binary.lock().expect("binary").clone();
            let binding = view.binding.lock().expect("binding").clone();
            if let Ok(restarted) = self.start_view(owner, &binary, binding) {
                self.views.lock().expect("views").insert(owner.to_string(), restarted);
            }
            return;
        }
        let root = view.binding.lock().expect("binding").root.clone();
        let root = if root.is_empty() {
            self.host_state()
                .ok()
                .and_then(|state| state.get("roots").and_then(Value::as_array).and_then(|roots| roots.first().cloned()))
                .and_then(|root| root.get("id").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_default()
        } else {
            root
        };
        let job = Job::new(red_core::service::uuid_v4(), &root, Some(owner), vec!["desktop".into()], now());
        self.jobs.lock().expect("jobs").queue(job);
        view.updating.store(true, Ordering::SeqCst);
        /* `closed` — the window is already gone, so there is nothing to tell to detach. It detached
           itself, which is what exit 75 meant. */
        let chosen = Chosen { worker: self.worker(), desktop_id: String::new(), owner: owner.to_string() };
        self.perform(Some(chosen), true);
    }
}

/// The session host as the descriptor records it.
fn host_document(host: &Connection) -> Value {
    let mut fields = serde_json::Map::new();
    fields.insert("url".into(), json!(host.url));
    fields.insert("token".into(), json!(host.token));
    fields.insert("instance".into(), json!(host.instance));
    if let Some(pid) = host.pid {
        fields.insert("pid".into(), json!(pid));
    }
    Value::Object(fields)
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

fn write_private(path: &Path, bytes: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
        file.write_all(bytes.as_bytes())?;
        file.sync_all()
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)
    }
}

/// The desktop an update was asked to replace: which worker it registered on, what it is called
/// there, and which of this supervisor's windows it is.
#[derive(Clone)]
pub struct Chosen {
    pub worker: Arc<worker::Child>,
    pub desktop_id: String,
    pub owner: String,
}

impl Supervisor {
    /// Queue a layered update, refusing in the order the JavaScript refused in: root, layers,
    /// desktop, then whether another is running.
    pub fn update(self: &Arc<Self>, data: &Value) -> Result<Value, Refused> {
        let root_id = data.get("rootId").and_then(Value::as_str).unwrap_or_default();
        self.own_root(root_id)?;
        let layers = jobs::chosen(data.get("layers"))?;
        let desktop_id = data.get("desktopId").and_then(Value::as_str);
        let mut chosen: Option<Chosen> = None;
        if layers.iter().any(|layer| layer == "desktop") {
            chosen = self.chosen_desktop(root_id, desktop_id);
            if chosen.is_none() {
                return refuse(jobs::CHOOSE_DESKTOP, 404);
            }
        }
        if self.jobs.lock().expect("jobs").busy(self.recovering.load(Ordering::SeqCst)) {
            return refuse(jobs::ALREADY_RUNNING, 409);
        }
        let job = Job::new(red_core::service::uuid_v4(), root_id, desktop_id, layers, now());
        let answer = self.jobs.lock().expect("jobs").queue(job);
        let held = self.clone();
        std::thread::spawn(move || held.perform(chosen, false));
        Ok(answer)
    }

    /// The managed window this desktop id names, if this supervisor manages it. A desktop attached
    /// to this project through a worker but started by somebody else is not one it may replace.
    fn chosen_desktop(&self, root_id: &str, desktop_id: Option<&str>) -> Option<Chosen> {
        let desktop_id = desktop_id.filter(|id| !id.is_empty())?;
        let attached = self.attached(root_id);
        let (worker, desktop) = attached
            .into_iter()
            .find(|(_, desktop)| desktop.get("id").and_then(Value::as_str) == Some(desktop_id))?;
        let owner = desktop.get("owner").and_then(Value::as_str)?.to_string();
        self.views.lock().expect("views").get(&owner)?;
        Some(Chosen { worker, desktop_id: desktop_id.to_string(), owner })
    }

    /// Prepare, switch, and put back if the switch failed; then finish the job.
    pub fn perform(self: &Arc<Self>, chosen: Option<Chosen>, closed: bool) {
        let outcome = self.switching(chosen.as_ref(), closed);
        {
            let mut jobs = self.jobs.lock().expect("jobs");
            if let Some(job) = jobs.active() {
                match outcome {
                    Ok(()) => job.status = Status::Succeeded,
                    Err(why) => {
                        job.status = Status::Recovering;
                        job.error = Some(why);
                    }
                }
            }
        }
        self.jobs.lock().expect("jobs").done(now());
        self.recover();
    }

    pub(crate) fn preserve(&self, generation: &str) {
        self.preserved.lock().expect("preserved").push(generation.to_string());
    }

    pub(crate) fn release(&self, generation: &str) {
        self.preserved.lock().expect("preserved").retain(|held| held != generation);
    }

    pub(crate) fn is_retiring(&self, generation: &str) -> bool {
        self.retiring.lock().expect("retiring").iter().any(|held| held.generation == generation)
    }

    /// The project windows on this root, and whether each one is open right now.
    pub fn window_list(&self, root_id: &str) -> Result<Value, Refused> {
        self.own_root(root_id)?;
        let listed = self.windows.lock().expect("windows").list(root_id);
        let views = self.views.lock().expect("views");
        let rows: Vec<Value> = listed
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|window| {
                let mut row = window.as_object().cloned().unwrap_or_default();
                let id = window.get("id").and_then(Value::as_str).unwrap_or_default();
                match views.get(id) {
                    Some(view) => {
                        row.insert("status".into(), json!("open"));
                        row.insert("pid".into(), json!(view.pid.load(Ordering::SeqCst)));
                    }
                    None => {
                        row.insert("status".into(), json!("closed"));
                    }
                }
                Value::Object(row)
            })
            .collect();
        Ok(json!({ "windows": rows }))
    }

    /// Open a window on somebody else's project, for one agent of this one.
    pub fn open_project(self: &Arc<Self>, data: &Value) -> Result<Value, Refused> {
        let root_id = data.get("rootId").and_then(Value::as_str).unwrap_or_default();
        let agent_id = data.get("agentId").and_then(Value::as_str).unwrap_or_default();
        let state = self.own_root(root_id)?;
        let running = state
            .get("sessions")
            .and_then(Value::as_array)
            .is_some_and(|sessions| {
                sessions.iter().any(|session| {
                    session.get("id").and_then(Value::as_str) == Some(agent_id)
                        && session.get("rootId").and_then(Value::as_str) == Some(root_id)
                        && session.get("type").and_then(Value::as_str) == Some("agent")
                        && session.get("state").and_then(Value::as_str) == Some("running")
                })
            });
        if !running {
            return refuse(SELECT_AGENT, 403);
        }
        let asked = json!({ "path": data.get("path").cloned().unwrap_or(Value::Null) });
        let project = descriptor::request(&self.host, "roots", Some(&asked), &[])
            .map_err(|why| Refused { message: why, status: 502 })?;
        if project.get("id").and_then(Value::as_str) == Some(root_id) {
            return failed(DIFFERENT_PROJECT);
        }
        let window = self
            .windows
            .lock()
            .expect("windows")
            .create(root_id, &project, agent_id, &red_core::service::uuid_v4, now())?;
        let opened = self.reopen_window(&window)?;
        /* The window as the store holds it, minus its layout, with what opening it answered on top. */
        let mut answer = window.as_object().cloned().unwrap_or_default();
        answer.shift_remove("layout");
        for (name, value) in opened.as_object().cloned().unwrap_or_default() {
            answer.insert(name, value);
        }
        Ok(Value::Object(answer))
    }

    pub fn reopen_window(self: &Arc<Self>, window: &Value) -> Result<Value, Refused> {
        self.open_desktop(&json!({
            "root": window.get("projectRootId").cloned().unwrap_or(Value::Null),
            "agent": window.get("agentId").cloned().unwrap_or(Value::Null),
            "windowId": window.get("id").cloned().unwrap_or(Value::Null),
            "originRootId": window.get("originRootId").cloned().unwrap_or(Value::Null),
        }))
    }

    /// Inspect, focus, close or reopen one project window.
    pub fn window_action(self: &Arc<Self>, data: &Value) -> Result<Value, Refused> {
        let root_id = data.get("rootId").and_then(Value::as_str).unwrap_or_default();
        let window_id = data.get("windowId").and_then(Value::as_str).unwrap_or_default();
        self.own_root(root_id)?;
        let window = self.windows.lock().expect("windows").get(root_id, window_id)?;
        /* Never while an update is switching: reopening a window mid-switch would race the update
           for the same owner, and closing one would take away what it is about to put back. */
        if self.jobs.lock().expect("jobs").busy(self.recovering.load(Ordering::SeqCst)) {
            return refuse(WAIT_FOR_UPDATE, 409);
        }
        let action = data.get("action").and_then(Value::as_str).unwrap_or_default();
        if action == "reopen" {
            return self.reopen_window(&window);
        }
        let Some(view) = self.views.lock().expect("views").get(window_id).cloned() else {
            return refuse(WINDOW_CLOSED, 409);
        };
        let control = view.control.lock().expect("control").clone();
        let Some(control) = control else { return refuse(WINDOW_CLOSED, 409) };
        match action {
            "inspect" => self.inspect(&view, &control, data.get("screenshot") == Some(&Value::Bool(true))),
            "focus" => Ok(json!({ "requested": control.ask(json!({ "op": "control-focus" })) == Ok(json!(true)) })),
            "close" => {
                if view.closing.swap(true, Ordering::SeqCst) {
                    return refuse(CLOSE_PENDING, 409);
                }
                let outcome = (|| {
                    if control.ask(json!({ "op": "control-close" })) != Ok(json!(true)) {
                        return failed(CLOSE_REJECTED);
                    }
                    /* A clean close is exit 0. Anything else — including no exit at all — means the
                       window did not finish saving, and a person needs to know that before they
                       decide it is gone. */
                    match view.exited(Duration::from_secs(7)) {
                        Some(0) => Ok(json!({ "windowId": window_id, "status": "closed", "sessionsRetained": true })),
                        _ => refuse(CLOSE_UNFINISHED, 409),
                    }
                })();
                view.closing.store(false, Ordering::SeqCst);
                outcome
            }
            _ => failed(CHOOSE_ACTION),
        }
    }

    fn inspect(&self, view: &Arc<View>, control: &Arc<crate::desktop::Control>, screenshot: bool) -> Result<Value, Refused> {
        let answered = control.ask(json!({ "op": "control-state" })).map_err(|why| Refused { message: why, status: 409 })?;
        let state = crate::desktop::inspection(&answered).map_err(|why| Refused { message: why, status: 409 })?;
        let mut answer = serde_json::Map::new();
        answer.insert("pid".into(), json!(view.pid.load(Ordering::SeqCst)));
        answer.insert("state".into(), state);
        answer.insert("diagnostics".into(), json!(view.diagnostics.lock().expect("diagnostics").clone()));
        if screenshot {
            let captures = self.state.join("inspection");
            std::fs::create_dir_all(&captures).map_err(|error| Refused::new(&format!("{} cannot be created: {error}", captures.display()), 500))?;
            let into = captures.join(format!("{}-{}.bmp", view.owner, red_core::service::uuid_v4()));
            let asked = json!({ "op": "control-snapshot", "path": into.to_string_lossy() });
            if control.ask(asked) != Ok(json!(true)) {
                return failed(NO_SNAPSHOT);
            }
            answer.insert("snapshot".into(), json!(into.to_string_lossy()));
        }
        Ok(Value::Object(answer))
    }

    /// Stop everything this supervisor started. The session host is never signalled.
    pub fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        for view in self.views.lock().expect("views").values() {
            view.stop();
        }
        for held in self.all_workers() {
            held.close();
            held.kill();
        }
    }

    pub(crate) fn clear_recovery_budget(&self) {
        self.recovery_used.store(false, Ordering::SeqCst);
        *self.recovery.lock().expect("recovery") = json!({ "state": "idle" });
    }
}
