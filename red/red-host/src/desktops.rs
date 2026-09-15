//! The desktops attached to this workspace, over the door's own socket (F189, spec 143).
//!
//! The registry itself is `red_core::desktops` — one implementation, because a WORKER serves the
//! same socket when there is one in front of this door, and above a session host that predates the
//! desktop routes it is the only thing that can (spec 065). What is here is the half that is this
//! door's: how it numbers a socket, and where it asks whether a project and a pane exist.

use std::sync::Arc;

use serde_json::{json, Value};

use red_core::desktops::{Bindings, Says};

use crate::events::Viewer;
use crate::Front;

/// A viewer, as the registry sees one: something that can be said a line to.
pub struct Said(pub Arc<Viewer>);

impl Says for Said {
    fn say(&self, line: String) {
        self.0.say(line);
    }
}

/// Resolve a registration's bindings against this workspace, then record it.
///
/// **A session this host has never had is not an invalid binding.** It ended with the host that
/// owned it and the desktop's saved layout outlived that process; refusing the frame would leave the
/// desktop unregistered and every desktop action invisible.
pub async fn register(front: &Arc<Front>, viewer: Arc<Viewer>, data: &Value) -> Result<(), String> {
    let outcome = registering(front, viewer, data).await;
    if let Err(message) = &outcome {
        front.desktops.refused(message, crate::panes::now_ms());
    }
    outcome
}

async fn registering(front: &Arc<Front>, viewer: Arc<Viewer>, data: &Value) -> Result<(), String> {
    if let Some(refusal) = red_core::desktops::Desktops::malformed(data, 0) {
        return Err(refusal.to_string());
    }
    let roots = red_core::desktops::unique(named(data, "rootIds"));
    for root in &roots {
        crate::ask(front, "root", json!([root])).await.map_err(crate::plain)?;
    }
    let mut sessions = Vec::new();
    let mut unknown = Vec::new();
    for id in red_core::desktops::unique(named(data, "sessionIds")) {
        match crate::ask_pty(front, "snapshot", json!([&id])).await {
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
                sessions.push(id);
            }
            Err(fault) if fault.starts_with("404|") => unknown.push(id),
            Err(fault) => return Err(crate::plain(fault)),
        }
    }
    let socket = front.hub.identify(&viewer).ok_or_else(|| "This socket is no longer registered.".to_string())?;
    front.desktops.register(
        socket,
        Arc::new(Said(viewer)),
        data,
        Bindings { roots, sessions, unknown },
        crate::uuid_v4(),
    );
    Ok(())
}

fn named(data: &Value, key: &str) -> Vec<String> {
    data.get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}
