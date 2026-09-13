//! What every tool call goes through (F185/F150b, spec 129): the bound workspace, the runtime that
//! actually serves the routes, and this launch's identity.
//!
//! Three things the JS worker does that are easy to miss and are the whole behaviour:
//!
//! * **The runtime, not the host.** Tools call the root-bound *worker* when one is running — it is
//!   the thing that owns the token ledger, the tracker and the feed — and fall back to the session
//!   host when none is. That resolution happens per call, because a worker can be replaced between
//!   two calls of the same pane (spec 065).
//! * **The identity is re-read per call, the binding never is.** The CLI reports the conversation
//!   it is actually running and `red-agents report-session` rewrites the context file with it, so
//!   the identity can change under a running pane. Nothing else in that file is re-read: no file
//!   on disk may retarget a pane's instance or root.
//! * **The identity headers are arbitration, never authentication** (spec 095). They name who is
//!   asking so a refusal can name a holder; they prove nothing.

use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub struct Binding {
    pub url: String,
    pub token: String,
    pub instance: String,
    pub root_id: String,
    pub runtime_directory: Option<String>,
    pub context_file: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Identity {
    pub agent_id: String,
    pub label: String,
    pub pid: Option<i64>,
}

/// The workspace as a pane reaches it, with the identity it currently reports.
pub struct Workspace {
    pub binding: Binding,
    pub identity: Option<Identity>,
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// The `agent` block of a context file, if it names one. A file that is missing, torn or anonymous
/// leaves the identity this process already has.
pub fn identity_of(value: &Value) -> Option<Identity> {
    let agent = value.get("agent")?;
    let agent_id = text(agent, "agentId");
    let uuid = agent_id.len() == 36 && agent_id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
    if !uuid {
        return None;
    }
    let label = match agent.get("label").and_then(Value::as_str) {
        Some(label) => label.to_string(),
        None => "agent".to_string(),
    };
    Some(Identity { agent_id, label, pid: agent.get("pid").and_then(Value::as_i64) })
}

impl Workspace {
    pub fn open(binding: Binding, identity: Option<Identity>) -> Self {
        Workspace { binding, identity }
    }

    /// The label and pid travel beside the id so a refusal can name a holder and say whether its
    /// process is still there. Only printable ASCII, and only 64 characters of it.
    pub fn headers(&self) -> Vec<(String, String)> {
        let Some(identity) = self.identity.as_ref() else { return Vec::new() };
        let printable: String = identity
            .label
            .chars()
            .filter(|c| (' '..='~').contains(c))
            .take(64)
            .collect();
        let mut headers = vec![
            ("X-Rengine-Agent".to_string(), identity.agent_id.clone()),
            ("X-Rengine-Agent-Label".to_string(), if printable.is_empty() { "agent".into() } else { printable }),
        ];
        if let Some(pid) = identity.pid.filter(|pid| *pid > 0) {
            headers.push(("X-Rengine-Agent-Pid".to_string(), pid.to_string()));
        }
        headers
    }

    pub fn refresh_identity(&mut self) {
        let Some(file) = self.binding.context_file.as_ref() else { return };
        let Ok(document) = std::fs::read_to_string(file) else { return };
        let Ok(value) = serde_json::from_str::<Value>(&document) else { return };
        if let Some(identity) = identity_of(&value) {
            self.identity = Some(identity);
        }
    }

    /// Where this project's routes are served from right now: the root-bound runtime worker when
    /// one is alive and belongs to this host, the session host otherwise.
    fn runtime(&self) -> (String, String) {
        let host = (self.binding.url.clone(), self.binding.token.clone());
        let Some(directory) = self.binding.runtime_directory.as_ref() else { return host };
        let descriptor = std::path::Path::new(directory).join("runtime.json");
        let Ok(document) = std::fs::read_to_string(&descriptor) else { return host };
        let Ok(value) = serde_json::from_str::<Value>(&document) else { return host };
        let belongs = value.get("version").and_then(Value::as_i64) == Some(1)
            && text_at(&value, &["host", "url"]) == self.binding.url
            && text_at(&value, &["host", "token"]) == self.binding.token
            && text_at(&value, &["host", "instance"]) == self.binding.instance
            && text(&value, "instance") == self.binding.instance;
        if !belongs || !alive(value.get("pid").and_then(Value::as_i64)) {
            return host;
        }
        let url = text(&value, "url");
        let token = text(&value, "token");
        if url.is_empty() || token.is_empty() { host } else { (url, token) }
    }

    /// A GET on the workspace's own API, with this launch's identity attached.
    pub fn get(&self, route: &str) -> Result<Value, String> {
        let (url, token) = self.runtime();
        red_core::http::get_as(&url, &token, &format!("/api/{route}"), &self.headers())
    }

    /// A POST on the workspace's own API, with this launch's identity attached.
    pub fn post(&self, route: &str, body: Value) -> Result<Value, String> {
        let (url, token) = self.runtime();
        red_core::http::post(&url, &token, &format!("/api/{route}"), &body, &self.headers())
    }

    /// The state a tool call is answered against: the bound root, the capabilities this workspace
    /// declares, and only this project's sessions, drafts and conversations.
    pub fn scoped_state(&mut self) -> Result<Value, String> {
        self.refresh_identity();
        let state = self.get("state")?;
        if text(&state, "instance") != self.binding.instance {
            return Err("The original sidecar instance is no longer available. Reopen this agent from the workspace.".into());
        }
        let root = state
            .get("roots")
            .and_then(Value::as_array)
            .and_then(|roots| roots.iter().find(|root| text(root, "id") == self.binding.root_id))
            .cloned()
            .ok_or("The bound project is no longer available.")?;
        let mine = |key: &str| -> Vec<Value> {
            state
                .get(key)
                .and_then(Value::as_array)
                .map(|items| items.iter().filter(|item| text(item, "rootId") == self.binding.root_id).cloned().collect())
                .unwrap_or_default()
        };
        let conversations = state
            .get("conversations")
            .and_then(|all| all.get(&self.binding.root_id))
            .cloned()
            .unwrap_or_else(|| json!([]));
        let mut scoped = serde_json::Map::new();
        scoped.insert("root".into(), root);
        scoped.insert("capabilities".into(), state.get("capabilities").cloned().unwrap_or_else(|| json!({})));
        scoped.insert("sessions".into(), Value::Array(mine("sessions")));
        scoped.insert("drafts".into(), Value::Array(mine("drafts")));
        scoped.insert("conversations".into(), conversations);
        if let Some(identity) = self.identity.as_ref() {
            let mut agent = serde_json::Map::new();
            agent.insert("agentId".into(), json!(identity.agent_id));
            agent.insert("label".into(), json!(identity.label));
            if let Some(pid) = identity.pid {
                agent.insert("pid".into(), json!(pid));
            }
            /* The rest of the identity block travels as the file wrote it: startedAt, the session
               and its resume line are the CLI's own words about itself, and this process neither
               composes nor validates them. */
            if let Some(file) = self.binding.context_file.as_ref() {
                if let Ok(document) = std::fs::read_to_string(file) {
                    if let Ok(value) = serde_json::from_str::<Value>(&document) {
                        if let Some(source) = value.get("agent").and_then(Value::as_object) {
                            for key in ["startedAt", "session", "sessionId"] {
                                if let Some(carried) = source.get(key) {
                                    agent.insert(key.into(), carried.clone());
                                }
                            }
                        }
                    }
                }
            }
            scoped.insert("agent".into(), Value::Object(agent));
        }
        Ok(Value::Object(scoped))
    }
}

fn text_at(value: &Value, path: &[&str]) -> String {
    let mut current = value;
    for key in path {
        match current.get(key) {
            Some(next) => current = next,
            None => return String::new(),
        }
    }
    current.as_str().unwrap_or_default().to_string()
}

/// `kill(pid, 0)` without a libc dependency: the process table, the way the rest of the tree asks.
fn alive(pid: Option<i64>) -> bool {
    let Some(pid) = pid.filter(|pid| *pid > 0) else { return false };
    if cfg!(windows) {
        return true;
    }
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding() -> Binding {
        Binding {
            url: "http://127.0.0.1:1".into(), token: "t".into(), instance: "i".into(),
            root_id: "r".into(), runtime_directory: None, context_file: None,
        }
    }

    #[test]
    fn an_anonymous_context_carries_no_identity() {
        assert!(identity_of(&json!({})).is_none());
        assert!(identity_of(&json!({ "agent": { "agentId": "not-a-uuid" } })).is_none());
        let identity = identity_of(&json!({ "agent": { "agentId": "3f85774e-05bb-4791-bb9f-1c90dc37d0e6" } })).expect("named");
        assert_eq!(identity.label, "agent", "a launch that named no label is still an agent");
    }

    #[test]
    fn the_identity_headers_are_printable_and_bounded() {
        let workspace = Workspace::open(binding(), Some(Identity {
            agent_id: "3f85774e-05bb-4791-bb9f-1c90dc37d0e6".into(),
            label: format!("claude\u{7}{}", "x".repeat(200)),
            pid: Some(42),
        }));
        let headers = workspace.headers();
        let label = &headers.iter().find(|(name, _)| name == "X-Rengine-Agent-Label").expect("labelled").1;
        assert!(!label.contains('\u{7}'), "a control character never reaches a header line");
        assert_eq!(label.chars().count(), 64, "and the label is bounded");
        assert!(headers.iter().any(|(name, value)| name == "X-Rengine-Agent-Pid" && value == "42"));
    }

    #[test]
    fn a_launch_with_no_identity_sends_no_headers() {
        assert!(Workspace::open(binding(), None).headers().is_empty());
    }
}
