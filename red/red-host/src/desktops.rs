//! The desktops attached to this workspace, and the actions it can ask them to perform (F189).
//!
//! A desktop registers itself on the `/events` socket — which is why this belongs to whoever serves
//! that socket, and why it moved with it. What the registry is for is spec 098's reload: the
//! workspace asks a named desktop to rebuild and reopen its windows, and the desktop answers. The
//! rule that matters is that **accepted does not mean done**: the answer says the desktop took the
//! request, and the caller is told in the same words the JS host uses to re-list afterwards.
//!
//! A session this host has never had is not an invalid binding. It ended with the host that owned
//! it and the desktop's saved layout outlived that process; refusing the frame would leave the
//! desktop unregistered and every desktop action invisible.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::events::{same, Viewer};
use crate::Front;

struct Desktop {
    id: String,
    viewer: Arc<Viewer>,
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
    answer: oneshot::Sender<Result<Value, String>>,
}

pub struct Desktops {
    /// Keyed by the hub's id for the socket, so a closed socket takes its desktop with it.
    clients: Mutex<HashMap<u64, Desktop>>,
    pending: Mutex<HashMap<String, Pending>>,
    /// The last registration this workspace REFUSED, so a launcher waiting for a window can name
    /// the reason one never appeared rather than only that it did not (spec 098). Cleared by the
    /// next registration that succeeds, because a stale reason is worse than none.
    refused: Mutex<Option<Value>>,
    sequence: AtomicU64,
    timeout: Duration,
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

    pub async fn register(&self, front: &Arc<Front>, viewer: Arc<Viewer>, data: &Value) -> Result<(), String> {
        let outcome = self.registering(front, viewer, data).await;
        /* Recorded here rather than by the caller, so every way in remembers it the same way. */
        *self.refused.lock().expect("refused lock") = match &outcome {
            Err(message) => Some(json!({ "at": crate::panes::now_ms(), "message": message })),
            Ok(()) => None,
        };
        outcome
    }

    async fn registering(&self, front: &Arc<Front>, viewer: Arc<Viewer>, data: &Value) -> Result<(), String> {
        let roots = strings(data.get("rootIds"));
        let named = strings(data.get("sessionIds"));
        if roots.is_none() || named.is_none() {
            return Err("Invalid desktop bindings.".to_string());
        }
        let (roots, named) = (unique(roots.unwrap()), unique(named.unwrap()));
        if roots.len() > 128 || named.len() > 64 {
            return Err("Invalid desktop bindings.".to_string());
        }
        for root in &roots {
            crate::ask(front, "root", json!([root])).await.map_err(crate::plain)?;
        }
        /* A session this host never had is reported back rather than refused, so the desktop knows
           which of its saved panes are gone and stays registered for everything else. */
        let mut session_ids = Vec::new();
        let mut unknown: Vec<String> = Vec::new();
        for id in &named {
            match crate::ask_pty(front, "snapshot", json!([id])).await {
                Ok(session) => {
                    let root = session
                        .get("meta")
                        .and_then(|record| record.get("rootId"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if !roots.contains(&root) {
                        return Err("Desktop session has a different root.".to_string());
                    }
                    session_ids.push(id.clone());
                }
                Err(fault) if fault.starts_with("404|") => unknown.push(id.clone()),
                Err(fault) => return Err(crate::plain(fault)),
            }
        }
        let identity = viewer_key(front, &viewer)?;
        let mut clients = self.clients.lock().expect("desktops lock");
        let desktop = clients.entry(identity).or_insert_with(|| Desktop {
            id: crate::uuid_v4(),
            viewer: viewer.clone(),
            root_ids: Vec::new(),
            session_ids: Vec::new(),
            can_reload: false,
            can_attach: false,
            owner: None,
            view: None,
        });
        desktop.root_ids = roots;
        desktop.session_ids = session_ids;
        desktop.can_reload = data.get("canReload") == Some(&Value::Bool(true));
        desktop.can_attach = data.get("canAttach") == Some(&Value::Bool(true));
        /* Owner and view travel together or not at all: half an identity names nobody. */
        let owner = data.get("owner").and_then(Value::as_str);
        let view = data.get("view").and_then(Value::as_str);
        if let (Some(owner), Some(view)) = (owner, view) {
            desktop.owner = Some(clip(owner));
            desktop.view = Some(clip(view));
        }
        let announced = json!({ "type": "desktop-registered", "id": desktop.id, "unknownSessions": unknown });
        desktop.viewer.say(announced.to_string());
        Ok(())
    }

    /// Every desktop attached to this workspace, and the last registration it refused.
    ///
    /// `list` answers a PROJECT's question — which desktops can show this root — and takes a root.
    /// This answers the WORKSPACE's: a launcher that has just started a desktop is waiting for one
    /// to appear at all and has no root to filter by yet.
    pub fn registry(&self) -> Value {
        let listed = self.entries(|_| true);
        json!({ "desktops": listed, "registerError": self.refused.lock().expect("refused lock").clone() })
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

    /// Ask a desktop to do something, and wait for it to say it took the request. The refusals are
    /// the JS host's, including the statuses a caller acts on.
    ///
    /// `carried` is what the ACTION needs and the frame does not already say. A reload carries
    /// nothing — the desktop knows how to rebuild itself. An attach carries the session, because a
    /// desktop that was told only an id would have to ask for the record back, and the one thing it
    /// must not do between being asked and answering is make another round trip.
    pub async fn act(
        &self,
        root_id: &str,
        desktop_id: &str,
        action: &'static str,
        carried: Value,
    ) -> Result<Value, String> {
        let (viewer, request) = {
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
            (desktop.viewer.clone(), desktop.id.clone())
        };
        let request_id = format!("{}-{}", crate::uuid_v4(), self.sequence.fetch_add(1, Ordering::SeqCst));
        let (sender, receiver) = oneshot::channel();
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
        viewer.say(frame.to_string());
        match tokio::time::timeout(self.timeout, receiver).await {
            Ok(Ok(outcome)) => outcome,
            /* The desktop said nothing in time, or went away while it was thinking. */
            _ => {
                self.pending.lock().expect("pending lock").remove(&request_id);
                Err("500|Desktop did not acknowledge the action.".to_string())
            }
        }
    }

    pub fn acknowledge(&self, viewer: &Arc<Viewer>, data: &Value) -> Result<(), String> {
        let request_id = data.get("requestId").and_then(Value::as_str).unwrap_or_default().to_string();
        let owner = {
            let clients = self.clients.lock().expect("desktops lock");
            let pending = self.pending.lock().expect("pending lock");
            let Some(entry) = pending.get(&request_id) else {
                return Err("Unknown desktop action acknowledgement.".to_string());
            };
            clients.values().any(|desktop| desktop.id == entry.desktop && same(&desktop.viewer, viewer))
        };
        if !owner {
            return Err("Unknown desktop action acknowledgement.".to_string());
        }
        let accepted = data.get("accepted") == Some(&Value::Bool(true));
        self.finish(&request_id, accepted);
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
    pub fn disconnected(&self, identity: u64) {
        let Some(desktop) = self.clients.lock().expect("desktops lock").remove(&identity) else { return };
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

fn viewer_key(front: &Arc<Front>, viewer: &Arc<Viewer>) -> Result<u64, String> {
    front.hub.identify(viewer).ok_or_else(|| "This socket is no longer registered.".to_string())
}

fn strings(value: Option<&Value>) -> Option<Vec<String>> {
    let items = value?.as_array()?;
    items.iter().map(|item| item.as_str().map(str::to_string)).collect()
}

fn unique(values: Vec<String>) -> Vec<String> {
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
