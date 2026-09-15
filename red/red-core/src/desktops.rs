//! The desktops attached to a workspace, and the actions it can ask them to perform (F189, F158).
//!
//! A desktop says it exists by sending a frame on a socket, so this belongs to whoever SERVES that
//! socket — and there are two such processes. The door serves `/events` for a workspace with no
//! worker in front of it; a worker serves it when there is one, and must, because the host beneath a
//! worker may predate the desktop routes entirely (spec 065). They are not two registries of one
//! thing: they are one registry, here, over two different sockets.
//!
//! What the registry is for is spec 098's reload, and spec 143's attach: the workspace asks a named
//! desktop to rebuild its windows or to show a retained pane, and the desktop answers. The rule that
//! matters is that **accepted does not mean done** — the answer says the desktop took the request.
//!
//! What is NOT here is looking a project or a pane up. Each server asks its own store and its own
//! PTY service, and hands the answers in: the rules about the FRAME are one thing, and where a
//! workspace keeps its records is another.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

/// One desktop's end of its socket. A registry never holds a socket, only something that can say a
/// line down one — which is what lets one registry serve two servers with different sockets.
pub trait Says: Send + Sync {
    fn say(&self, line: String);
}

struct Desktop {
    id: String,
    says: Arc<dyn Says>,
    root_ids: Vec<String>,
    session_ids: Vec<String>,
    can_reload: bool,
    can_attach: bool,
    owner: Option<String>,
    view: Option<String>,
}

struct Pending {
    desktop: String,
    action: &'static str,
    answer: std::sync::mpsc::Sender<Result<Value, String>>,
}

/// What a caller found out about the frame's bindings before handing it over: which projects it
/// named that exist, which panes it named that this workspace holds, and which it named that it
/// does not.
///
/// **A session this host has never had is not an invalid binding.** It ended with the host that
/// owned it and the desktop's saved layout outlived that process; refusing the frame would leave the
/// desktop unregistered and every desktop action invisible.
pub struct Bindings {
    pub roots: Vec<String>,
    pub sessions: Vec<String>,
    pub unknown: Vec<String>,
}

pub struct Desktops {
    /// Keyed by the caller's number for the socket, so a closed socket takes its desktop with it.
    clients: Mutex<HashMap<u64, Desktop>>,
    pending: Mutex<HashMap<String, Pending>>,
    /// The last registration this workspace REFUSED, so a launcher waiting for a window can name the
    /// reason one never appeared rather than only that it did not (spec 098). Cleared by the next
    /// registration that succeeds, because a stale reason is worse than none.
    refused: Mutex<Option<Value>>,
    sequence: AtomicU64,
    timeout: Duration,
}

impl Default for Desktops {
    fn default() -> Desktops {
        Desktops::new()
    }
}

impl Desktops {
    pub fn new() -> Desktops {
        Desktops {
            clients: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            refused: Mutex::new(None),
            sequence: AtomicU64::new(0),
            timeout: Duration::from_millis(
                std::env::var("RENGINE_DESKTOP_ACTION_MS").ok().and_then(|value| value.parse().ok()).unwrap_or(4000),
            ),
        }
    }

    /// The shape of a registration, judged before anything is looked up. `None` means it is one.
    ///
    /// The bounds are the JavaScript's, and they are bounds on somebody else's frame: a desktop that
    /// claimed a thousand roots would have this workspace asking its store a thousand questions.
    pub fn malformed(data: &Value, already_dropped: usize) -> Option<&'static str> {
        let roots = strings(data.get("rootIds"));
        let named = strings(data.get("sessionIds"));
        let (Some(roots), Some(named)) = (roots, named) else {
            return Some("Invalid desktop bindings.");
        };
        if unique(roots).len() > 128 || unique(named).len() + already_dropped > 64 {
            return Some("Invalid desktop bindings.");
        }
        None
    }

    /// Record a registration whose bindings a caller has already resolved.
    ///
    /// Returns the desktop's id. Told, not asked: whether the frame's projects and panes exist is
    /// each server's own question, and the answers arrive as `Bindings`.
    pub fn register(&self, socket: u64, says: Arc<dyn Says>, data: &Value, bindings: Bindings, id: String) -> String {
        let mut clients = self.clients.lock().expect("desktops lock");
        let desktop = clients.entry(socket).or_insert_with(|| Desktop {
            id,
            says: says.clone(),
            root_ids: Vec::new(),
            session_ids: Vec::new(),
            can_reload: false,
            can_attach: false,
            owner: None,
            view: None,
        });
        desktop.says = says;
        desktop.root_ids = unique(bindings.roots);
        desktop.session_ids = bindings.sessions;
        desktop.can_reload = data.get("canReload") == Some(&Value::Bool(true));
        desktop.can_attach = data.get("canAttach") == Some(&Value::Bool(true));
        /* Owner and view travel together or not at all: half an identity names nobody. */
        if let (Some(owner), Some(view)) = (data.get("owner").and_then(Value::as_str), data.get("view").and_then(Value::as_str)) {
            desktop.owner = Some(clip(owner));
            desktop.view = Some(clip(view));
        }
        let announced = json!({ "type": "desktop-registered", "id": desktop.id, "unknownSessions": bindings.unknown });
        desktop.says.say(announced.to_string());
        let named = desktop.id.clone();
        drop(clients);
        *self.refused.lock().expect("refused lock") = None;
        named
    }

    /// A registration this workspace refused, remembered for the launcher that is waiting.
    pub fn refused(&self, message: &str, at: i64) {
        *self.refused.lock().expect("refused lock") = Some(json!({ "at": at, "message": message }));
    }

    /// Every desktop attached to this workspace, and the last registration it refused.
    ///
    /// `list` answers a PROJECT's question — which desktops can show this root — and takes a root.
    /// This answers the WORKSPACE's: a launcher that has just started a desktop is waiting for one
    /// to appear at all and has no root to filter by yet.
    pub fn registry(&self) -> Value {
        json!({ "desktops": self.entries(|_| true), "registerError": self.refused.lock().expect("refused lock").clone() })
    }

    pub fn list(&self, root_id: &str) -> Value {
        json!(self.entries(|desktop| desktop.root_ids.iter().any(|root| root == root_id)))
    }

    /// The desktops matching a question, as a caller reads them — the socket itself never travels.
    fn entries(&self, wanted: impl Fn(&Desktop) -> bool) -> Vec<Value> {
        let clients = self.clients.lock().expect("desktops lock");
        clients
            .values()
            .filter(|desktop| wanted(desktop))
            .map(|desktop| {
                let mut entry = serde_json::Map::new();
                entry.insert("id".to_string(), json!(desktop.id));
                entry.insert("rootIds".to_string(), json!(desktop.root_ids));
                entry.insert("sessionIds".to_string(), json!(desktop.session_ids));
                entry.insert("canReload".to_string(), json!(desktop.can_reload));
                entry.insert("canAttach".to_string(), json!(desktop.can_attach));
                if let (Some(owner), Some(view)) = (&desktop.owner, &desktop.view) {
                    entry.insert("owner".to_string(), json!(owner));
                    entry.insert("view".to_string(), json!(view));
                }
                Value::Object(entry)
            })
            .collect()
    }

    /// Send one message to every desktop bound to a project, or to just one socket's.
    ///
    /// This is how anything reaches a desktop that it did not ask for: the pinned token segment, and
    /// nothing else so far.
    pub fn push(&self, root_id: &str, message: &str, only: Option<u64>) {
        let clients = self.clients.lock().expect("desktops lock");
        for (socket, desktop) in clients.iter() {
            if !desktop.root_ids.iter().any(|root| root == root_id) || only.is_some_and(|wanted| wanted != *socket) {
                continue;
            }
            desktop.says.say(message.to_string());
        }
    }

    /// The id this workspace knows one socket's desktop by, or `None` if it never registered.
    pub fn identify(&self, socket: u64) -> Option<String> {
        self.clients.lock().expect("desktops lock").get(&socket).map(|desktop| desktop.id.clone())
    }

    /// The projects one socket is bound to.
    pub fn bound(&self, socket: u64) -> Vec<String> {
        self.clients.lock().expect("desktops lock").get(&socket).map(|desktop| desktop.root_ids.clone()).unwrap_or_default()
    }

    /// Ask a desktop to do something, and wait for it to say it took the request.
    ///
    /// `carried` is what the ACTION needs and the frame does not already say. A reload carries
    /// nothing — the desktop knows how to rebuild itself. An attach carries the session, because a
    /// desktop told only an id would have to ask for the record back, and the one thing it must not
    /// do between being asked and answering is make another round trip.
    ///
    /// Blocking: the caller is on its own thread, and the answer comes from the socket's reader.
    pub fn act(&self, root_id: &str, desktop_id: &str, action: &'static str, carried: Value, uuid: &dyn Fn() -> String) -> Result<Value, String> {
        let (says, request) = self.target(root_id, desktop_id, action)?;
        let request_id = format!("{}-{}", uuid(), self.sequence.fetch_add(1, Ordering::SeqCst));
        let (sender, receiver) = std::sync::mpsc::channel();
        self.pending
            .lock()
            .expect("pending lock")
            .insert(request_id.clone(), Pending { desktop: request, action, answer: sender });
        let mut frame = json!({ "type": "desktop-action", "action": action, "desktopId": desktop_id, "requestId": request_id });
        if let (Some(frame), Some(carried)) = (frame.as_object_mut(), carried.as_object()) {
            for (name, value) in carried {
                frame.insert(name.clone(), value.clone());
            }
        }
        says.say(frame.to_string());
        match receiver.recv_timeout(self.timeout) {
            Ok(outcome) => outcome,
            /* The desktop said nothing in time, or went away while it was thinking. */
            Err(_) => {
                self.pending.lock().expect("pending lock").remove(&request_id);
                Err("500|Desktop did not acknowledge the action.".to_string())
            }
        }
    }

    /// Can this desktop be asked to do this at all?
    ///
    /// Asked on its own by a caller that is about to do WORK first — opening a script starts a pane,
    /// and a caller whose desktop cannot show one should be told to update it rather than told, a
    /// moment later, that the pane it started is unattachable. The JavaScript checked this before it
    /// even looked at the path, and the order is what a person reads.
    pub fn may(&self, root_id: &str, desktop_id: &str, action: &'static str) -> Result<(), String> {
        self.target(root_id, desktop_id, action).map(|_| ())
    }

    fn target(&self, root_id: &str, desktop_id: &str, action: &'static str) -> Result<(Arc<dyn Says>, String), String> {
        let clients = self.clients.lock().expect("desktops lock");
        let Some(desktop) = clients
            .values()
            .find(|desktop| desktop.id == desktop_id && desktop.root_ids.iter().any(|root| root == root_id))
        else {
            return Err("404|Desktop is not attached to this project.".to_string());
        };
        if action == "reload" && !desktop.can_reload {
            return Err("409|This desktop was not started through the reload-capable launcher.".to_string());
        }
        if action == "attach-session" && !desktop.can_attach {
            return Err("409|Update this desktop before opening script tabs.".to_string());
        }
        if self.pending.lock().expect("pending lock").values().any(|entry| entry.desktop == desktop.id) {
            return Err("409|A desktop action is already pending.".to_string());
        }
        Ok((desktop.says.clone(), desktop.id.clone()))
    }

    pub fn acknowledge(&self, socket: u64, data: &Value) -> Result<(), String> {
        let request_id = data.get("requestId").and_then(Value::as_str).unwrap_or_default().to_string();
        let owner = {
            let clients = self.clients.lock().expect("desktops lock");
            let pending = self.pending.lock().expect("pending lock");
            let Some(entry) = pending.get(&request_id) else {
                return Err("Unknown desktop action acknowledgement.".to_string());
            };
            clients.get(&socket).is_some_and(|desktop| desktop.id == entry.desktop)
        };
        if !owner {
            return Err("Unknown desktop action acknowledgement.".to_string());
        }
        self.finish(&request_id, data.get("accepted") == Some(&Value::Bool(true)));
        Ok(())
    }

    fn finish(&self, request_id: &str, accepted: bool) {
        let Some(entry) = self.pending.lock().expect("pending lock").remove(request_id) else { return };
        let answer = if accepted {
            Ok(json!({
                "requestId": request_id,
                "desktopId": entry.desktop,
                "status": "accepted",
                "detail": if entry.action == "reload" {
                    "Native reload requested. Re-list desktops after rebuild; accepted does not mean the build succeeded."
                } else {
                    "Retained session attached to a native tab."
                },
            }))
        } else {
            Err(format!(
                "500|Desktop rejected {} because it is closing or cannot perform it.",
                if entry.action == "reload" { "reload" } else { "session attachment" }
            ))
        };
        let _ = entry.answer.send(answer);
    }

    /// A socket closed: its desktop is gone, and anything it was asked to do will never be answered.
    pub fn disconnected(&self, socket: u64) {
        let Some(desktop) = self.clients.lock().expect("desktops lock").remove(&socket) else { return };
        let orphaned: Vec<String> = self
            .pending
            .lock()
            .expect("pending lock")
            .iter()
            .filter(|(_, entry)| entry.desktop == desktop.id)
            .map(|(id, _)| id.clone())
            .collect();
        for request_id in orphaned {
            if let Some(entry) = self.pending.lock().expect("pending lock").remove(&request_id) {
                let _ = entry.answer.send(Err("500|Desktop disconnected before acknowledging reload.".to_string()));
            }
        }
    }
}

fn strings(value: Option<&Value>) -> Option<Vec<String>> {
    let items = value?.as_array()?;
    items.iter().map(|item| item.as_str().map(str::to_string)).collect()
}

pub fn unique(values: Vec<String>) -> Vec<String> {
    let mut seen = Vec::new();
    for value in values {
        if !seen.contains(&value) {
            seen.push(value);
        }
    }
    seen
}

fn clip(value: &str) -> String {
    value.chars().take(64).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Heard(Mutex<Vec<Value>>);

    impl Says for Heard {
        fn say(&self, line: String) {
            self.0.lock().expect("heard").push(serde_json::from_str(&line).expect("a frame"));
        }
    }

    impl Heard {
        fn of(&self, kind: &str) -> Option<Value> {
            self.0.lock().expect("heard").iter().find(|frame| frame["type"] == json!(kind)).cloned()
        }
    }

    fn bindings(roots: &[&str], sessions: &[&str], unknown: &[&str]) -> Bindings {
        Bindings {
            roots: roots.iter().map(|value| value.to_string()).collect(),
            sessions: sessions.iter().map(|value| value.to_string()).collect(),
            unknown: unknown.iter().map(|value| value.to_string()).collect(),
        }
    }

    /* The bounds are on somebody else's frame: a desktop claiming a thousand roots would have this
       workspace asking its store a thousand questions before it refused. */
    #[test]
    fn a_frame_that_is_not_a_registration_is_refused_before_anything_is_looked_up() {
        assert!(Desktops::malformed(&json!({ "rootIds": [], "sessionIds": [] }), 0).is_none());
        assert!(Desktops::malformed(&json!({ "rootIds": "not an array", "sessionIds": [] }), 0).is_some());
        assert!(Desktops::malformed(&json!({ "rootIds": [] }), 0).is_some(), "a missing list is not an empty one");
        assert!(Desktops::malformed(&json!({ "rootIds": [1], "sessionIds": [] }), 0).is_some(), "a root id is a string");
        let many: Vec<String> = (0..129).map(|n| n.to_string()).collect();
        assert!(Desktops::malformed(&json!({ "rootIds": many, "sessionIds": [] }), 0).is_some());
        let panes: Vec<String> = (0..64).map(|n| n.to_string()).collect();
        assert!(Desktops::malformed(&json!({ "rootIds": [], "sessionIds": panes.clone() }), 0).is_none(), "64 is the bound");
        /* The ones a layer above already dropped count against it, so one frame reports every id
           this registration lost (spec 098). */
        assert!(Desktops::malformed(&json!({ "rootIds": [], "sessionIds": panes }), 1).is_some());
    }

    /* A pane this workspace never had is reported back rather than refused: it ended with the host
       that owned it, and the desktop's saved layout outlived that process. */
    #[test]
    fn a_registration_names_the_panes_it_lost_and_stays_registered() {
        let registry = Desktops::new();
        let heard = Arc::new(Heard::default());
        let frame = json!({ "rootIds": ["root-1"], "sessionIds": ["p1", "gone"], "canReload": true, "canAttach": true,
                            "owner": "alex", "view": "workspace" });
        let id = registry.register(1, heard.clone(), &frame, bindings(&["root-1"], &["p1"], &["gone"]), "d-1".into());
        assert_eq!(id, "d-1");
        let announced = heard.of("desktop-registered").expect("registered");
        assert_eq!(announced["id"], json!("d-1"));
        assert_eq!(announced["unknownSessions"], json!(["gone"]));

        let listed = registry.list("root-1");
        assert_eq!(listed[0]["sessionIds"], json!(["p1"]), "with the pane that is actually here");
        assert_eq!(listed[0]["canReload"], json!(true));
        assert_eq!(listed[0]["owner"], json!("alex"));
        assert_eq!(registry.list("root-2").as_array().expect("a list").len(), 0);
        /* The socket itself never travels: a caller reads a desktop, not a connection. */
        assert_eq!(listed[0].get("says"), None);
    }

    /* Owner and view travel together or not at all: half an identity names nobody. */
    #[test]
    fn half_an_identity_is_no_identity() {
        let registry = Desktops::new();
        let heard = Arc::new(Heard::default());
        registry.register(1, heard, &json!({ "rootIds": ["r"], "sessionIds": [], "owner": "alex" }), bindings(&["r"], &[], &[]), "d".into());
        assert_eq!(registry.list("r")[0].get("owner"), None);
        assert_eq!(registry.list("r")[0].get("view"), None);
    }

    /* A launcher waiting for a window is told WHY one never appeared, and a stale reason is worse
       than none — so the next registration that succeeds clears it. */
    #[test]
    fn a_refusal_is_remembered_until_one_succeeds() {
        let registry = Desktops::new();
        assert_eq!(registry.registry()["registerError"], Value::Null);
        registry.refused("Invalid desktop bindings.", 1_700_000_000_000);
        assert_eq!(registry.registry()["registerError"]["message"], json!("Invalid desktop bindings."));
        assert_eq!(registry.registry()["registerError"]["at"], json!(1_700_000_000_000i64));
        registry.register(1, Arc::new(Heard::default()), &json!({ "rootIds": ["r"], "sessionIds": [] }), bindings(&["r"], &[], &[]), "d".into());
        assert_eq!(registry.registry()["registerError"], Value::Null);
        assert_eq!(registry.registry()["desktops"].as_array().expect("desktops").len(), 1);
    }

    /* Accepted does not mean done: the answer says the desktop took the request, and says so in the
       words a caller re-lists on. */
    #[test]
    fn an_action_is_taken_or_refused_by_name() {
        let registry = Arc::new(Desktops::new());
        let heard = Arc::new(Heard::default());
        registry.register(1, heard.clone(), &json!({ "rootIds": ["r"], "sessionIds": [], "canReload": true }), bindings(&["r"], &[], &[]), "d".into());

        let asking = registry.clone();
        let acting = std::thread::spawn(move || asking.act("r", "d", "reload", Value::Null, &|| "req".to_string()));
        let asked = loop {
            if let Some(frame) = heard.of("desktop-action") {
                break frame;
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(asked["action"], json!("reload"));
        /* Nobody else may answer for it: a second socket knows the request id — it was never a
           secret — and is still not the desktop that was asked. */
        assert!(registry.acknowledge(2, &asked).is_err());
        registry.acknowledge(1, &json!({ "requestId": asked["requestId"], "accepted": true })).expect("acknowledged");
        let answer = acting.join().expect("joined").expect("accepted");
        assert_eq!(answer["status"], json!("accepted"));
        assert!(answer["detail"].as_str().expect("detail").contains("accepted does not mean the build succeeded"));

        /* A desktop that was not started through the reload-capable launcher says so, and one that
           is not attached to this project is a different refusal with a different status. */
        let plain = Desktops::new();
        plain.register(1, Arc::new(Heard::default()), &json!({ "rootIds": ["r"], "sessionIds": [] }), bindings(&["r"], &[], &[]), "d".into());
        assert!(plain.act("r", "d", "reload", Value::Null, &|| "x".into()).expect_err("refused").starts_with("409|"));
        /* And the same question asked on its own, which is what a caller about to start a pane asks
           FIRST: being told to update a desktop beats being told the pane you just started cannot
           be shown in it. */
        assert!(plain.may("r", "d", "attach-session").expect_err("refused").contains("Update this desktop"));
        assert_eq!(plain.may("r", "d", "anything-else"), Ok(()), "a desktop that is there can be asked");
        assert!(plain.act("r", "nobody", "reload", Value::Null, &|| "x".into()).expect_err("refused").starts_with("404|"));
        assert!(plain.act("other", "d", "reload", Value::Null, &|| "x".into()).expect_err("refused").starts_with("404|"));
    }

    /* The registry is the socket's, so it cannot outlive it — and anything that socket was asked to
       do will never be answered, which a caller waiting has to be told rather than left to time out. */
    #[test]
    fn a_socket_that_closes_takes_its_desktop_and_its_pending_action_with_it() {
        let registry = Arc::new(Desktops::new());
        let heard = Arc::new(Heard::default());
        registry.register(1, heard.clone(), &json!({ "rootIds": ["r"], "sessionIds": [], "canReload": true }), bindings(&["r"], &[], &[]), "d".into());
        let asking = registry.clone();
        let acting = std::thread::spawn(move || asking.act("r", "d", "reload", Value::Null, &|| "req".to_string()));
        while heard.of("desktop-action").is_none() {
            std::thread::sleep(Duration::from_millis(5));
        }
        registry.disconnected(1);
        let refused = acting.join().expect("joined").expect_err("refused");
        assert!(refused.contains("disconnected before acknowledging"), "{refused}");
        assert_eq!(registry.list("r").as_array().expect("a list").len(), 0);
        assert_eq!(registry.identify(1), None);
        assert_eq!(registry.bound(1), Vec::<String>::new());
    }

    /* A push reaches the desktops bound to a project and nobody else: a status bar showing another
       project's token is a person about to act on a workspace they are not looking at. */
    #[test]
    fn a_push_reaches_the_bound_desktops_and_no_others() {
        let registry = Desktops::new();
        let (mine, theirs) = (Arc::new(Heard::default()), Arc::new(Heard::default()));
        registry.register(1, mine.clone(), &json!({ "rootIds": ["r"], "sessionIds": [] }), bindings(&["r"], &[], &[]), "d1".into());
        registry.register(2, theirs.clone(), &json!({ "rootIds": ["other"], "sessionIds": [] }), bindings(&["other"], &[], &[]), "d2".into());
        registry.push("r", &json!({ "type": "token", "rootId": "r" }).to_string(), None);
        assert!(mine.of("token").is_some());
        assert!(theirs.of("token").is_none(), "another project's segment is not this desktop's");
        /* And one socket alone, for the desktop that has just registered. */
        registry.push("r", &json!({ "type": "token", "rootId": "r", "only": true }).to_string(), Some(2));
        assert_eq!(mine.0.lock().expect("heard").iter().filter(|frame| frame["type"] == json!("token")).count(), 1);
    }
}
