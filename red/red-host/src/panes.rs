//! The pane routes that compose rather than deliver (F189): what a pane is CALLED, and what
//! conversation it is holding.
//!
//! Everything here is the JS host's `recordConversation`, which is two writes that must not come
//! apart: the workspace's record of the conversation (the store's, shared since D61) and the pane's
//! own record of which conversation it is running (the service's, shared since D62). A host that
//! wrote one without the other would leave a pane offering to resume something the workspace has
//! never heard of, or a workspace remembering a conversation no pane claims.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::{ask, ask_pty, Front};

/// `shortAgentId`, which is the CLI's own rule: a prefix to strip and a length, declared in the
/// agent registry. The registry is red-agents' — this crate reads it rather than restating it,
/// because a title that shortened a kimi id by eight characters would show `session_` every time.
fn recipes() -> Vec<(String, red_agents::Value)> {
    let path = registry();
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    red_agents::load_registry(&text, &path, None).unwrap_or_default()
}

fn registry() -> String {
    if let Ok(declared) = std::env::var("RENGINE_AGENT_REGISTRY") {
        if !declared.is_empty() {
            return declared;
        }
    }
    /* The checkout this binary was built in, the way red-agents-serve finds the same file. */
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .map(|checkout| checkout.join("orchestrator/agents/registry.toml").to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The pane's title when nobody has given it one: the agent, its conversation's short form, and the
/// project — `agentTitle` in `sessions-client.mjs`, word for word, because a person recognises the
/// same eight characters in the pane title, the picker row and the identity label.
pub(crate) fn agent_title(agent: &str, conversation: Option<&str>, root_name: &str) -> String {
    let named = if agent.is_empty() { "Choose agent" } else { agent };
    match conversation.filter(|id| !id.is_empty()) {
        Some(id) => format!("{named} {} · {root_name}", red_agents::launch::short_agent_id(&recipes()[..], agent, id)),
        None => format!("{named} · {root_name}"),
    }
}

/// `/api/agent-conversation`: the pane reports what it actually launched. The workspace may have
/// minted a conversation, the person at the pane may have chosen a different one from the offered
/// list, and their own `--resume` beats both — so this is the pane correcting the record, and
/// `null` means *this launch continues or forks a conversation the CLI names itself*, which the
/// record must claim nothing about rather than keep an id that would resume the wrong one.
pub(crate) async fn record_conversation(front: &Arc<Front>, body: &str) -> String {
    let payload: Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(error) => return crate::faulted(&format!("400|Invalid JSON body: {error}")),
    };
    let id = payload.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let Some(pane) = front.panes.lock().expect("panes lock").get(&id).cloned() else {
        return crate::faulted("404|Unknown session.");
    };
    let held = |name: &str| pane.get("meta").and_then(|record| record.get(name)).filter(|value| !value.is_null()).cloned();
    if held("type").and_then(|value| value.as_str().map(str::to_string)).as_deref() != Some("agent") {
        return crate::faulted("400|Only an agent session holds a conversation.");
    }
    let root_id = held("rootId").and_then(|value| value.as_str().map(str::to_string)).unwrap_or_default();
    let named = payload.get("agent").and_then(Value::as_str).unwrap_or_default().to_string();
    let known = held("agent").and_then(|value| value.as_str().map(str::to_string)).unwrap_or_default();
    /* The pane may be the first to know which agent it is: a launch that offered a choice starts
       with none, and the pane says so when it has one. An agent it already has is not replaced. */
    let agent = if !named.is_empty() && known.is_empty() { named.clone() } else { known.clone() };
    let root = match ask(front, "root", json!([root_id])).await {
        Ok(root) => root,
        Err(fault) => return crate::faulted(&fault),
    };
    let root_name = root.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
    let automatic = held("titleAuto").and_then(|value| value.as_bool()).unwrap_or(false);

    let mut patch = serde_json::Map::new();
    if agent != known {
        patch.insert("agent".to_string(), json!(agent));
    }
    let conversation = payload.get("conversation").cloned().unwrap_or(Value::Null);
    if conversation.is_null() {
        patch.insert("conversation".to_string(), Value::Null);
        if automatic {
            patch.insert("title".to_string(), json!(agent_title(&agent, None, &root_name)));
        }
    } else {
        let entry = match ask(front, "recordConversation", json!([root_id, {
            "conversation": conversation,
            "agent": if agent.is_empty() { Value::Null } else { json!(agent) },
            "task": payload.get("task").cloned().unwrap_or(Value::Null),
        }])).await {
            Ok(entry) => entry,
            Err(fault) => return crate::faulted(&fault),
        };
        let recorded = entry.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        patch.insert("conversation".to_string(), json!(recorded));
        patch.insert("task".to_string(), entry.get("task").cloned().unwrap_or(Value::Null));
        if automatic {
            patch.insert("title".to_string(), json!(agent_title(&agent, Some(&recorded), &root_name)));
        }
    }
    match ask_pty(front, "describe", json!([id, Value::Object(patch)])).await {
        /* `describe` answers with the pane it just changed, which is the snapshot this route
           returns — so the caller reads the record it wrote rather than one read back after it. */
        Ok(session) => crate::http_text(200, "OK", &crate::pane_answer(&session, false)),
        Err(fault) => crate::faulted(&fault),
    }
}
