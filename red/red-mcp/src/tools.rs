//! The 38 tool calls (F185/F150b, spec 129, KI-100), ported from `agents/mcp-worker.mjs`.
//!
//! Nearly every tool is the same three steps — check that this workspace has the route, check the
//! token where the tool is gated, and ask the workspace — so they are a table. The six that carry
//! real logic (the file excerpt, the output tail, the preview budget, the two feed shapes and the
//! scoped state itself) are written out, because a table that could express them would be a worse
//! way of saying the same thing.
//!
//! The refusals are the interesting half. An agent meets *"This retained service predates …"* far
//! more often than the happy path, so those sentences are part of the surface and are reproduced
//! exactly: a workspace that has not been updated must be told what to update and what was NOT
//! attempted, in the same words it used before.

use serde_json::{json, Map, Value};

use crate::workspace::Workspace;

/// Arguments, with the defaults the JS side's schema applied and the same bounds enforced.
struct Args<'a> {
    map: &'a Map<String, Value>,
}

impl<'a> Args<'a> {
    fn new(value: &'a Value) -> Self {
        static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        Args { map: value.as_object().unwrap_or_else(|| EMPTY.get_or_init(Map::new)) }
    }

    fn string(&self, key: &str) -> String {
        self.map.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
    }

    fn optional_string(&self, key: &str) -> Option<String> {
        self.map.get(key).and_then(Value::as_str).map(str::to_string)
    }

    fn bool(&self, key: &str) -> bool {
        self.map.get(key).and_then(Value::as_bool).unwrap_or(false)
    }

    fn integer(&self, key: &str, fallback: i64) -> i64 {
        self.map.get(key).and_then(Value::as_i64).unwrap_or(fallback)
    }

    fn optional_integer(&self, key: &str) -> Option<i64> {
        self.map.get(key).and_then(Value::as_i64)
    }

    fn value(&self, key: &str) -> Value {
        self.map.get(key).cloned().unwrap_or(Value::Null)
    }
}

fn capability(state: &Value, name: &str) -> bool {
    state.get("capabilities").and_then(|caps| caps.get(name)).and_then(Value::as_i64) == Some(1)
}

/// The workspace layer that serves a route, and the sentence a pane is given when it is missing.
fn needs(state: &Value, name: &str, refusal: &str) -> Result<(), String> {
    if capability(state, name) { Ok(()) } else { Err(refusal.to_string()) }
}

fn session_of(state: &Value, id: &str) -> Result<Value, String> {
    state
        .get("sessions")
        .and_then(Value::as_array)
        .and_then(|sessions| sessions.iter().find(|session| session.get("id").and_then(Value::as_str) == Some(id)))
        .cloned()
        .ok_or_else(|| "Session is not bound to this project.".to_string())
}

/// Whether this launch is an agent the ledger arbitrates between. An anonymous caller — the update
/// probe, an older launch — is not an agent and is never gated (spec 095).
fn token_capability(workspace: &Workspace, state: &Value, tool: &str) -> Result<bool, String> {
    if workspace.identity.is_none() {
        return Ok(false);
    }
    if !capability(state, "agentToken") {
        return Err(format!(
            "{tool} is gated by the project token, and this workspace worker predates the ledger that serves it. Update the workspace layer first: update_workspace with layers [\"workspace\"]. Nothing was attempted."
        ));
    }
    Ok(true)
}

/// `update_workspace` and `reload_desktop` are answered by the runtime supervisor, which never sees
/// the worker's own gate — so for those two the ledger is read here, before the call.
fn token_gate(workspace: &Workspace, state: &Value, tool: &str) -> Result<(), String> {
    if !token_capability(workspace, state, tool)? {
        return Ok(());
    }
    let status = workspace.get(&format!("token?rootId={}&tool={}", encode(&workspace.binding.root_id), encode(tool)))?;
    match status.get("refusal").and_then(Value::as_str) {
        Some(refusal) if !refusal.is_empty() => Err(refusal.to_string()),
        _ => Ok(()),
    }
}

fn encode(value: &str) -> String {
    red_core::http::encode(value)
}

const PREVIEW_BUDGET: usize = 32000;

const DESKTOP_CAPABILITY: &str = "This retained service predates agent desktop actions. Upgrade it through explicit session/service management; native keyboard reload remains available.";
const LAYERED_CAPABILITY: &str = "Load the layered native bootstrap once before using updates.";
const WINDOW_CAPABILITY: &str = "Project-window control needs the current runtime supervisor. Use the documented context-bound bootstrap.";
const SCRIPT_CAPABILITY: &str = "Update the workspace worker before opening script tabs.";
const DASHBOARD_CAPABILITY: &str = "This retained service predates the project dashboard. Update the workspace layer first.";
const FORMAT_CAPABILITY: &str = "This retained service predates the project format registry. Update the workspace layer first.";
const DEVICE_CAPABILITY: &str = "This retained service predates project devices (contract 4). Update the workspace layer first.";
const TRACKER_CAPABILITY: &str = "This retained service predates the task tracker (spec 083). Update the workspace layer first.";
const MENU_CAPABILITY: &str = "This workspace worker predates the agent menu (spec 103). Update the workspace layer first.";
const SPAWN_CAPABILITY: &str = "spawn_agent starts an agent pane through the workspace, and this workspace worker predates that route (spec 103). Update the workspace layer first: update_workspace with layers [\"workspace\"]. Nothing was started.";
const GAME_CAPABILITY: &str = "This retained service predates per-project game declarations. Update the workspace layer first.";
const LAUNCH_CAPABILITY: &str = "This retained session host predates per-project game declarations and would launch its removed built-in game; game_preflight answers from the declaration. Replacing the session host requires quiescence.";
const RECORDING_CAPABILITY: &str = "This retained service predates game recording. Update the workspace layer first.";
const CONVERSATION_CAPABILITY: &str = "This retained session host predates agent conversations, so it cannot name or resume one. Replacing the session host requires quiescence.";

fn write_capability(state: &Value, tool: &str) -> Result<(), String> {
    if capability(state, "taskWrites") {
        return Ok(());
    }
    Err(format!(
        "{tool} writes the project's task inventory through the workspace, and this workspace worker predates that route (spec 103). Update the workspace layer first: update_workspace with layers [\"workspace\"]. Nothing was written."
    ))
}

/// Everything the caller sent, plus the root this pane is bound to. The root is added rather than
/// taken from the arguments: nothing a caller sends may retarget the pane.
fn body(args: &Args<'_>, root_id: &str, extra: &[(&str, Value)]) -> Value {
    let mut map = args.map.clone();
    map.insert("rootId".into(), json!(root_id));
    for (key, value) in extra {
        map.insert((*key).into(), value.clone());
    }
    Value::Object(map)
}

pub fn names() -> Vec<&'static str> {
    vec![
        "workspace_info", "list_files", "read_file", "list_sessions", "list_desktops", "reload_desktop",
        "update_status", "update_workspace", "open_project_window", "list_project_windows", "project_window_action",
        "report_integration", "integration_inbox", "open_script", "dashboard_actions", "dashboard_capture",
        "show_session", "session_output", "preview_file", "devices", "list_tasks", "task_add", "task_update",
        "task_decompose", "list_agents_menu", "spawn_agent", "game_preflight", "launch_game", "recordings_list",
        "recording_read", "token_status", "token_contest", "token_reject", "token_release", "feed_url", "feed_read",
        "stop_session", "restart_agent",
    ]
}

/// One tool call, answered against a freshly scoped state — the same order the JS wrapper uses, so
/// a workspace that moved is reported the same way whichever tool noticed.
pub fn call(workspace: &mut Workspace, name: &str, arguments: &Value) -> Result<Value, String> {
    let state = workspace.scoped_state()?;
    let args = Args::new(arguments);
    let root = workspace.binding.root_id.clone();
    let root_query = encode(&root);
    match name {
        "workspace_info" => Ok(state),

        "list_files" => workspace.get(&format!(
            "tree?rootId={root_query}&path={}&hidden={}",
            encode(&args.string("path")),
            if args.bool("hidden") { "true" } else { "false" }
        )),

        "read_file" => {
            let file = workspace.get(&format!("file?rootId={root_query}&path={}", encode(&args.string("path"))))?;
            let start_line = args.integer("startLine", 1).max(1) as usize;
            let max_lines = args.integer("maxLines", 200).clamp(1, 400) as usize;
            let use_draft = args.bool("useDraft");
            let draft = file.get("draft").filter(|value| !value.is_null());
            let source = match (use_draft, draft) {
                (true, Some(draft)) => draft.get("text").and_then(Value::as_str).unwrap_or_default(),
                _ => file.get("text").and_then(Value::as_str).unwrap_or_default(),
            };
            let lines: Vec<&str> = source.split('\n').collect();
            let from = start_line - 1;
            let excerpt = lines.iter().skip(from).take(max_lines).copied().collect::<Vec<_>>().join("\n");
            /* `excerpt.length > PREVIEW_BUDGET` in the worker this replaced: UTF-16 units. */
            let truncated = red_core::text::utf16_len(&excerpt) > PREVIEW_BUDGET || from + max_lines < lines.len();
            Ok(json!({
                "path": file.get("path").cloned().unwrap_or(Value::Null),
                "version": file.get("version").cloned().unwrap_or(Value::Null),
                "startLine": start_line,
                "totalLines": lines.len(),
                "draftAvailable": draft.is_some(),
                "usingDraft": use_draft && draft.is_some(),
                "text": excerpt.chars().take(PREVIEW_BUDGET).collect::<String>(),
                "truncated": truncated,
            }))
        }

        "list_sessions" => Ok(json!({ "sessions": state.get("sessions").cloned().unwrap_or_else(|| json!([])) })),

        "list_desktops" => {
            needs(&state, "desktopActions", DESKTOP_CAPABILITY)?;
            workspace.get(&format!("desktops?rootId={root_query}"))
        }

        "reload_desktop" => {
            needs(&state, "desktopActions", DESKTOP_CAPABILITY)?;
            token_gate(workspace, &state, "reload_desktop")?;
            workspace.post("desktop-action", json!({ "rootId": root, "desktopId": args.string("id"), "action": "reload" }))
        }

        "update_status" => {
            needs(&state, "layeredUpdates", LAYERED_CAPABILITY)?;
            let mut status = workspace.get(&format!("update-status?rootId={root_query}"))?;
            if let Some(map) = status.as_object_mut() {
                map.insert("toolWorkerPid".into(), json!(std::process::id()));
            }
            Ok(status)
        }

        "update_workspace" => {
            needs(&state, "layeredUpdates", LAYERED_CAPABILITY)?;
            token_gate(workspace, &state, "update_workspace")?;
            workspace.post("update-workspace", json!({
                "rootId": root,
                "layers": args.value("layers"),
                "desktopId": args.value("desktopId"),
            }))
        }

        "open_project_window" => {
            needs(&state, "projectWindows", WINDOW_CAPABILITY)?;
            session_of(&state, &args.string("agentId"))?;
            workspace.post("project-window-open", body(&args, &root, &[]))
        }

        "list_project_windows" => {
            needs(&state, "projectWindows", WINDOW_CAPABILITY)?;
            workspace.get(&format!("project-windows?rootId={root_query}"))
        }

        "project_window_action" => {
            needs(&state, "projectWindows", WINDOW_CAPABILITY)?;
            workspace.post("project-window-action", body(&args, &root, &[]))
        }

        "report_integration" => {
            needs(&state, "projectWindows", WINDOW_CAPABILITY)?;
            workspace.post("integration-report", body(&args, &root, &[]))
        }

        "integration_inbox" => {
            needs(&state, "projectWindows", WINDOW_CAPABILITY)?;
            let mut query = format!("integration-inbox?rootId={root_query}&after={}", args.integer("after", 0).max(0));
            if let Some(window) = args.optional_string("windowId") {
                query.push_str(&format!("&windowId={}", encode(&window)));
            }
            query.push_str(&format!("&projectSide={}", if args.bool("projectSide") { "true" } else { "false" }));
            workspace.get(&query)
        }

        "open_script" => {
            needs(&state, "scriptActions", SCRIPT_CAPABILITY)?;
            token_capability(workspace, &state, "open_script")?;
            workspace.post("script-open", body(&args, &root, &[]))
        }

        "dashboard_actions" => {
            needs(&state, "dashboard", DASHBOARD_CAPABILITY)?;
            workspace.get(&format!("dashboard?rootId={root_query}"))
        }

        "dashboard_capture" => {
            needs(&state, "dashboard", DASHBOARD_CAPABILITY)?;
            token_capability(workspace, &state, "dashboard_capture")?;
            workspace.post("dashboard-capture", json!({ "rootId": root, "actionId": args.string("actionId") }))
        }

        "show_session" => {
            needs(&state, "scriptActions", SCRIPT_CAPABILITY)?;
            session_of(&state, &args.string("id"))?;
            workspace.post("session-view", body(&args, &root, &[]))
        }

        "session_output" => {
            let id = args.string("id");
            session_of(&state, &id)?;
            let max = args.integer("maxCharacters", 8000).clamp(1, 32000) as usize;
            let mut session = workspace.get(&format!("session?id={}", encode(&id)))?;
            let output: Vec<char> = session.get("output").and_then(Value::as_str).unwrap_or_default().chars().collect();
            let truncated = output.len() > max;
            let tail: String = output.iter().skip(output.len().saturating_sub(max)).collect();
            if let Some(map) = session.as_object_mut() {
                map.insert("output".into(), json!(tail));
                map.insert("truncated".into(), json!(truncated));
            }
            Ok(session)
        }

        "preview_file" => {
            needs(&state, "formatRegistry", FORMAT_CAPABILITY)?;
            preview(workspace, &state, &args, &root)
        }

        "devices" => {
            needs(&state, "projectDevices", DEVICE_CAPABILITY)?;
            let mut query = format!("devices?rootId={root_query}");
            if args.bool("refresh") {
                query.push_str("&refresh=1");
            }
            workspace.get(&query)
        }

        "list_tasks" => {
            needs(&state, "tracker", TRACKER_CAPABILITY)?;
            let mut query = format!("tracker?rootId={root_query}");
            if args.bool("refresh") {
                query.push_str("&refresh=1");
            }
            workspace.get(&query)
        }

        "task_add" | "task_update" | "task_decompose" => {
            write_capability(&state, name)?;
            token_capability(workspace, &state, name)?;
            let action = match name {
                "task_add" => "add",
                "task_update" => "update",
                _ => "decompose",
            };
            let mut payload = json!({ "rootId": root, "action": action, "row": args.value("row") });
            if let Some(map) = payload.as_object_mut() {
                match name {
                    "task_decompose" => { map.insert("parent".into(), json!(args.string("parent"))); }
                    "task_add" => {
                        if let Some(parent) = args.optional_string("parent") {
                            map.insert("parent".into(), json!(parent));
                        }
                    }
                    _ => {}
                }
            }
            workspace.post("task", payload)
        }

        "list_agents_menu" => {
            needs(&state, "agentsMenu", MENU_CAPABILITY)?;
            workspace.get(&format!("agents-menu?rootId={root_query}"))
        }

        "spawn_agent" => {
            needs(&state, "agentSpawn", SPAWN_CAPABILITY)?;
            token_capability(workspace, &state, "spawn_agent")?;
            let mut payload = args.map.clone();
            payload.insert("rootId".into(), json!(root));
            if !payload.contains_key("brief") {
                payload.insert("brief".into(), json!("task"));
            }
            workspace.post("agent-spawn", Value::Object(payload))
        }

        "game_preflight" => {
            needs(&state, "projectGame", GAME_CAPABILITY)?;
            let mut query = format!("game-config?rootId={root_query}");
            if let Some(game) = args.optional_string("gameId") {
                query.push_str(&format!("&gameId={}", encode(&game)));
            }
            workspace.get(&query)
        }

        "launch_game" => {
            needs(&state, "projectGame", GAME_CAPABILITY)?;
            needs(&state, "projectGameLaunch", LAUNCH_CAPABILITY)?;
            token_capability(workspace, &state, "launch_game")?;
            let mut payload = json!({ "rootId": root });
            if let Some(map) = payload.as_object_mut() {
                if let Some(game) = args.optional_string("gameId") {
                    map.insert("gameId".into(), json!(game));
                }
                if let Some(extra) = args.map.get("args") {
                    map.insert("args".into(), extra.clone());
                }
            }
            workspace.post("game", payload)
        }

        "recordings_list" => {
            needs(&state, "recordings", RECORDING_CAPABILITY)?;
            let mut query = format!("recordings?rootId={root_query}");
            if let Some(limit) = args.optional_integer("limit") {
                query.push_str(&format!("&limit={limit}"));
            }
            workspace.get(&query)
        }

        "recording_read" => {
            needs(&state, "recordings", RECORDING_CAPABILITY)?;
            let artifact = args.optional_string("artifact").unwrap_or_else(|| "all".into());
            workspace.get(&format!(
                "recording?rootId={root_query}&id={}&artifact={}&offset={}&limit={}&maxCharacters={}",
                encode(&args.string("id")),
                encode(&artifact),
                args.integer("offset", 0).max(0),
                args.integer("limit", 200).clamp(1, 1000),
                args.integer("maxCharacters", 8000).clamp(1, 32000)
            ))
        }

        "token_status" => {
            token_capability(workspace, &state, "token_status")?;
            workspace.get(&format!("token?rootId={root_query}"))
        }

        "token_contest" | "token_reject" | "token_release" => {
            token_capability(workspace, &state, name)?;
            let action = name.trim_start_matches("token_");
            let mut payload = json!({ "rootId": root, "action": action });
            if let Some(map) = payload.as_object_mut() {
                if let Some(reason) = args.optional_string("reason") {
                    map.insert("reason".into(), json!(reason));
                }
                if let Some(contest) = args.optional_string("contestId") {
                    map.insert("contestId".into(), json!(contest));
                }
            }
            workspace.post("token-action", payload)
        }

        "feed_url" => {
            token_capability(workspace, &state, "feed_url")?;
            let feed = workspace.get(&format!("feed?rootId={root_query}&after=0&limit=0"))?;
            let cursor = args.optional_integer("after").unwrap_or_else(|| feed.get("cursor").and_then(Value::as_i64).unwrap_or(0));
            let socket = feed.get("socket").and_then(Value::as_str).unwrap_or_default();
            Ok(json!({
                "url": format!("{socket}&after={cursor}"),
                "cursor": cursor,
                "retainedFrom": feed.get("retainedFrom").cloned().unwrap_or(Value::Null),
                "detail": "Open this with a WebSocket monitor. Frames arrive as one JSON object per message.",
            }))
        }

        "feed_read" => {
            token_capability(workspace, &state, "feed_read")?;
            let mut feed = workspace.get(&format!(
                "feed?rootId={root_query}&after={}&limit={}",
                args.integer("after", 0).max(0),
                args.integer("limit", 200).clamp(1, 1000)
            ))?;
            /* The socket URL carries this workspace's token; feed_url composes it deliberately and
               feed_read must not leak it as a side effect of reading frames. */
            if let Some(map) = feed.as_object_mut() {
                map.remove("socket");
            }
            Ok(feed)
        }

        "stop_session" => {
            let id = args.string("id");
            session_of(&state, &id)?;
            token_capability(workspace, &state, "stop_session")?;
            workspace.post("stop", json!({ "id": id }))
        }

        "restart_agent" => {
            needs(&state, "agentConversations", CONVERSATION_CAPABILITY)?;
            let id = args.string("id");
            session_of(&state, &id)?;
            token_capability(workspace, &state, "restart_agent")?;
            workspace.post("agent-restart", json!({ "id": id }))
        }

        other => Err(format!("Tool {other} not found")),
    }
}

/// The preview's budget loop: the reply stays inside 32,000 characters, shrinking depth first and
/// then the page, and says which of the two it had to do.
fn preview(workspace: &Workspace, state: &Value, args: &Args<'_>, root: &str) -> Result<Value, String> {
    let root_path = state.get("root").and_then(|root| root.get("path")).and_then(Value::as_str).unwrap_or_default().to_string();
    let relative = |value: &Value| -> Value {
        match value.as_str() {
            Some(text) if text.starts_with(&format!("{root_path}/")) => json!(text[root_path.len() + 1..]),
            _ => value.clone(),
        }
    };
    let mut payload = json!({ "rootId": root, "path": args.string("path") });
    if let Some(entry) = args.optional_string("entry") {
        payload.as_object_mut().expect("object").insert("entry".into(), json!(entry));
    }
    let mut result = workspace.post("format-preview", payload)?;
    if let Some(command) = result.get("command").and_then(Value::as_array) {
        let mapped: Vec<Value> = command.iter().map(relative).collect();
        result.as_object_mut().expect("object").insert("command".into(), Value::Array(mapped));
    }
    if result.get("kind").and_then(Value::as_str) != Some("tree") {
        let map = result.as_object_mut().expect("object");
        map.remove("window");
        if let Some(text) = map.get("text").and_then(Value::as_str) {
            if red_core::text::utf16_len(text) > PREVIEW_BUDGET {
                let cut = red_core::text::truncate_utf16(text, PREVIEW_BUDGET);
                map.insert("text".into(), json!(cut));
                map.insert("truncated".into(), json!(true));
            }
        }
        return Ok(result);
    }

    let tree = result.get("tree").cloned().unwrap_or(Value::Null);
    let dir = args.string("dir");
    let mut node = &tree;
    for part in dir.split('/').filter(|part| !part.is_empty()) {
        node = node
            .get("dirs")
            .and_then(Value::as_array)
            .and_then(|dirs| dirs.iter().find(|entry| entry.get("name").and_then(Value::as_str) == Some(part)))
            .ok_or_else(|| format!("Directory {dir} is not in the preview tree."))?;
    }
    let node = node.clone();
    let mut base = result.clone();
    base.as_object_mut().expect("object").remove("tree");

    let depth = args.integer("depth", 1).clamp(1, 8);
    let limit = args.integer("limit", 200).clamp(1, 1000);
    let offset = args.integer("offset", 0).max(0) as usize;
    let (mut use_depth, mut use_limit) = (depth, limit);
    loop {
        let sliced = slice(&node, 1, true, use_depth, use_limit as usize, offset);
        let files = sliced.get("files").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
        let total_here = node.get("files").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
        let next = offset + files;
        let more = next < total_here;
        let mut output = base.clone();
        {
            let map = output.as_object_mut().expect("object");
            map.insert("dir".into(), json!(dir));
            map.insert("depth".into(), json!(use_depth));
            map.insert("offset".into(), json!(offset));
            map.insert("limit".into(), json!(use_limit));
            map.insert("totalFiles".into(), json!(count(&tree)));
            map.insert("truncated".into(), json!(more || use_depth < depth || use_limit < limit));
            if more {
                map.insert("nextOffset".into(), json!(next));
            }
            map.insert("tree".into(), sliced);
        }
        if red_core::text::utf16_len(&output.to_string()) <= PREVIEW_BUDGET || (use_depth == 1 && use_limit == 1) {
            return Ok(output);
        }
        if use_depth > 1 {
            use_depth -= 1;
        } else {
            use_limit = (use_limit / 2).max(1);
        }
    }
}

fn count(node: &Value) -> usize {
    let files = node.get("files").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
    let dirs = node
        .get("dirs")
        .and_then(Value::as_array)
        .map(|dirs| dirs.iter().map(count).sum::<usize>())
        .unwrap_or(0);
    files + dirs
}

fn summary(node: &Value) -> Value {
    json!({
        "name": node.get("name").cloned().unwrap_or(Value::Null),
        "dirs": node.get("dirs").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
        "files": node.get("files").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
    })
}

fn slice(node: &Value, level: i64, first: bool, depth: i64, limit: usize, offset: usize) -> Value {
    let all = node.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
    let start = if first { offset } else { 0 };
    let files: Vec<Value> = all.iter().skip(start).take(limit).cloned().collect();
    let mut out = serde_json::Map::new();
    out.insert("name".into(), node.get("name").cloned().unwrap_or(Value::Null));
    out.insert("files".into(), Value::Array(files.clone()));
    if start + files.len() < all.len() {
        out.insert("moreFiles".into(), json!(all.len() - start - files.len()));
    }
    let dirs: Vec<Value> = node
        .get("dirs")
        .and_then(Value::as_array)
        .map(|dirs| {
            dirs.iter()
                .map(|entry| if level <= depth { slice(entry, level + 1, false, depth, limit, offset) } else { summary(entry) })
                .collect()
        })
        .unwrap_or_default();
    out.insert("dirs".into(), Value::Array(dirs));
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_the_declaration_names_has_an_arm() {
        let declaration: Value = serde_json::from_str(crate::DECLARATION).expect("json");
        let declared: Vec<String> = declaration["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .map(|tool| tool["name"].as_str().unwrap_or_default().to_string())
            .collect();
        let mut ported = names();
        ported.sort_unstable();
        let mut expected: Vec<String> = declared.clone();
        expected.sort();
        assert_eq!(ported, expected.iter().map(String::as_str).collect::<Vec<_>>(),
                   "the surface and the calls are the same set of tools");
    }

    #[test]
    fn a_capability_the_workspace_lacks_is_refused_in_its_own_words() {
        let state = json!({ "capabilities": { "dashboard": 1 } });
        assert!(needs(&state, "dashboard", DASHBOARD_CAPABILITY).is_ok());
        assert_eq!(needs(&state, "recordings", RECORDING_CAPABILITY).unwrap_err(), RECORDING_CAPABILITY);
    }

    #[test]
    fn a_session_from_another_project_is_not_this_panes_to_name() {
        let state = json!({ "sessions": [{ "id": "mine" }] });
        assert!(session_of(&state, "mine").is_ok());
        assert_eq!(session_of(&state, "theirs").unwrap_err(), "Session is not bound to this project.");
    }
}
