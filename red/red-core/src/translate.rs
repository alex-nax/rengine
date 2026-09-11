//! The host's JSON into the contract's types, strictly (spec 128, decision 5).
//!
//! "Strictly" is the whole point. The owner chose a schema-first contract over mirroring the host's
//! JSON, accepting that two descriptions of one API can drift; the control that makes that safe is
//! this module refusing to guess. So:
//!
//!   * a field the contract expects and the host did not send is drift,
//!   * a field whose type is not what the contract says is drift,
//!   * an enum value the contract does not know is drift, and
//!   * **a field the host sent that nothing here consumed is drift too** — that is the case worth
//!     the trouble, because it is what a host gaining a field looks like, and it is exactly the
//!     change that would otherwise reach a phone as a missing feature nobody noticed.
//!
//! A field v1 deliberately does not carry is declared with [`Fields::ignore`], so "we decided not
//! to" and "nobody looked" are different things in the source.

use serde_json::{Map, Value};

pub mod pb {
    include!(concat!(env!("OUT_DIR"), "/red.v1.rs"));
}

/// One disagreement between the host and the contract, at the path it was found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Drift {
    pub path: String,
    pub reason: String,
}

impl std::fmt::Display for Drift {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.path, self.reason)
    }
}

/// Reads one JSON object, remembering which keys were consumed so the leftovers can be reported.
struct Fields<'a> {
    path: String,
    map: &'a Map<String, Value>,
    seen: Vec<String>,
    drift: &'a mut Vec<Drift>,
}

impl<'a> Fields<'a> {
    fn new(path: impl Into<String>, map: &'a Map<String, Value>, drift: &'a mut Vec<Drift>) -> Self {
        Self { path: path.into(), map, seen: Vec::new(), drift }
    }

    fn at(&self, key: &str) -> String {
        format!("{}.{}", self.path, key)
    }

    fn note(&mut self, key: &str, reason: impl Into<String>) {
        let path = self.at(key);
        self.drift.push(Drift { path, reason: reason.into() });
    }

    fn take(&mut self, key: &str) -> Option<&'a Value> {
        self.seen.push(key.to_string());
        match self.map.get(key) {
            None | Some(Value::Null) => None,
            some => some,
        }
    }

    /// A field v1 knowingly does not carry. Recorded so the omission is a decision in the source.
    fn ignore(&mut self, key: &str) {
        self.seen.push(key.to_string());
    }

    fn string(&mut self, key: &str) -> String {
        match self.take(key) {
            Some(Value::String(s)) => s.clone(),
            Some(other) => { self.note(key, format!("expected a string, the host sent {}", kind_of(other))); String::new() }
            None => { self.note(key, "expected a string, the host sent nothing"); String::new() }
        }
    }

    /// A string the contract models as absent-or-set; null and missing are both "not set".
    fn optional_string(&mut self, key: &str) -> String {
        match self.take(key) {
            Some(Value::String(s)) => s.clone(),
            Some(other) => { self.note(key, format!("expected a string or null, the host sent {}", kind_of(other))); String::new() }
            None => String::new(),
        }
    }

    fn bool(&mut self, key: &str) -> bool {
        match self.take(key) {
            Some(Value::Bool(b)) => *b,
            Some(other) => { self.note(key, format!("expected a boolean, the host sent {}", kind_of(other))); false }
            None => { self.note(key, "expected a boolean, the host sent nothing"); false }
        }
    }

    fn optional_bool(&mut self, key: &str) -> Option<bool> {
        match self.take(key) {
            Some(Value::Bool(b)) => Some(*b),
            Some(other) => { self.note(key, format!("expected a boolean or null, the host sent {}", kind_of(other))); None }
            None => None,
        }
    }

    fn integer(&mut self, key: &str) -> i64 {
        match self.take(key) {
            Some(Value::Number(n)) if n.is_i64() || n.is_u64() => n.as_i64().unwrap_or_default(),
            Some(other) => { self.note(key, format!("expected a whole number, the host sent {}", kind_of(other))); 0 }
            None => { self.note(key, "expected a whole number, the host sent nothing"); 0 }
        }
    }

    fn optional_integer(&mut self, key: &str) -> Option<i64> {
        match self.take(key) {
            Some(Value::Number(n)) if n.is_i64() || n.is_u64() => Some(n.as_i64().unwrap_or_default()),
            Some(other) => { self.note(key, format!("expected a whole number or null, the host sent {}", kind_of(other))); None }
            None => None,
        }
    }

    fn strings(&mut self, key: &str) -> Vec<String> {
        match self.take(key) {
            Some(Value::Array(items)) => {
                let mut out = Vec::with_capacity(items.len());
                for (index, item) in items.iter().enumerate() {
                    match item {
                        Value::String(s) => out.push(s.clone()),
                        other => self.note(&format!("{key}[{index}]"), format!("expected a string, the host sent {}", kind_of(other))),
                    }
                }
                out
            }
            Some(other) => { self.note(key, format!("expected an array of strings, the host sent {}", kind_of(other))); Vec::new() }
            None => Vec::new(),
        }
    }

    fn object(&mut self, key: &str) -> Option<&'a Map<String, Value>> {
        match self.take(key) {
            Some(Value::Object(map)) => Some(map),
            Some(other) => { self.note(key, format!("expected an object, the host sent {}", kind_of(other))); None }
            None => None,
        }
    }

    /// Every key the host sent that nothing above consumed. This is the drift that matters.
    fn finish(self) {
        for key in self.map.keys() {
            if !self.seen.iter().any(|seen| seen == key) {
                self.drift.push(Drift {
                    path: format!("{}.{}", self.path, key),
                    reason: "the host sends this and the contract does not carry it".to_string(),
                });
            }
        }
    }
}

fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

fn as_object<'a>(path: &str, value: &'a Value, drift: &mut Vec<Drift>) -> Option<&'a Map<String, Value>> {
    match value {
        Value::Object(map) => Some(map),
        other => {
            drift.push(Drift { path: path.to_string(), reason: format!("expected an object, the host sent {}", kind_of(other)) });
            None
        }
    }
}

// ---- enums: an unknown value is drift, never a silent default --------------------------------

fn session_kind(path: &str, raw: &str, drift: &mut Vec<Drift>) -> i32 {
    match raw {
        "terminal" => pb::SessionKind::Terminal as i32,
        "agent" => pb::SessionKind::Agent as i32,
        "game" => pb::SessionKind::Game as i32,
        other => {
            drift.push(Drift { path: format!("{path}.type"), reason: format!("the host sent the session kind {other:?}, which the contract does not know") });
            pb::SessionKind::Unspecified as i32
        }
    }
}

fn session_state(path: &str, raw: &str, drift: &mut Vec<Drift>) -> i32 {
    match raw {
        "running" => pb::SessionState::Running as i32,
        "exited" => pb::SessionState::Exited as i32,
        other => {
            drift.push(Drift { path: format!("{path}.state"), reason: format!("the host sent the session state {other:?}, which the contract does not know") });
            pb::SessionState::Unspecified as i32
        }
    }
}

fn action_kind(path: &str, raw: &str, drift: &mut Vec<Drift>) -> i32 {
    match raw {
        "script" => pb::ActionKind::Script as i32,
        "log" => pb::ActionKind::Log as i32,
        "capture" => pb::ActionKind::Capture as i32,
        "game" => pb::ActionKind::Game as i32,
        other => {
            drift.push(Drift { path: format!("{path}.kind"), reason: format!("the host sent the action kind {other:?}, which the contract does not know") });
            pb::ActionKind::Unspecified as i32
        }
    }
}

// ---- the shapes --------------------------------------------------------------------------------

fn root(path: &str, value: &Value, drift: &mut Vec<Drift>) -> pb::Root {
    let Some(map) = as_object(path, value, drift) else { return pb::Root::default() };
    let mut f = Fields::new(path, map, drift);
    let out = pb::Root { id: f.string("id"), path: f.string("path"), name: f.string("name") };
    f.finish();
    out
}

pub fn session(path: &str, value: &Value, drift: &mut Vec<Drift>) -> pb::Session {
    let Some(map) = as_object(path, value, drift) else { return pb::Session::default() };
    let mut out = pb::Session::default();
    let kind_raw;
    let state_raw;
    {
        let mut f = Fields::new(path, map, drift);
        out.id = f.string("id");
        out.root_id = f.string("rootId");
        kind_raw = f.string("type");
        out.agent = f.optional_string("agent");
        out.title = f.string("title");
        out.pid = f.integer("pid").max(0) as u32;
        state_raw = f.string("state");
        out.exit_code = f.optional_integer("exitCode").map(|v| v as i32);
        out.signal = f.optional_integer("signal").map(|v| v as i32);
        out.created_at = f.integer("createdAt");
        out.ended_at = f.optional_integer("endedAt");
        out.cols = f.integer("cols").max(0) as u32;
        out.rows = f.integer("rows").max(0) as u32;
        out.sequence = f.integer("sequence").max(0) as u64;
        out.waiting_for_view = f.optional_bool("waitingForView").unwrap_or(false);
        f.ignore("handoff");
        // The live terminal buffer rides its own stream, not a snapshot field (spec 128 decision 9:
        // terminal attach is v0.2). Declared so "not carried" is a decision, not an oversight.
        f.ignore("output");
        f.finish();
    }
    out.kind = session_kind(path, &kind_raw, drift);
    out.state = session_state(path, &state_raw, drift);
    if let Some(Value::Object(h)) = map.get("handoff") {
        let handoff_path = format!("{path}.handoff");
        let mut f = Fields::new(&handoff_path, h, drift);
        out.handoff = Some(pb::Handoff { session_id: f.string("sessionId"), checkpoint: f.string("checkpoint") });
        f.finish();
    }
    out
}

pub fn workspace(value: &Value) -> (pb::Workspace, Vec<Drift>) {
    let mut drift = Vec::new();
    let path = "workspace";
    let Some(map) = as_object(path, value, &mut drift) else { return (pb::Workspace::default(), drift) };
    let mut capabilities = std::collections::HashMap::new();
    let mut out = pb::Workspace::default();
    {
        let mut f = Fields::new(path, map, &mut drift);
        out.instance = f.string("instance");
        out.state_dir = f.string("stateDir");
        out.pid = f.integer("pid").max(0) as u32;
        if let Some(caps) = f.object("capabilities") {
            for (name, level) in caps {
                match level {
                    Value::Number(n) if n.is_u64() => { capabilities.insert(name.clone(), n.as_u64().unwrap_or_default() as u32); }
                    other => f.note(&format!("capabilities.{name}"), format!("expected a number, the host sent {}", kind_of(other))),
                }
            }
        }
        // Carried by their own messages rather than folded into the workspace snapshot.
        f.ignore("layout");
        f.ignore("preferences");
        f.ignore("conversations");
        f.ignore("drafts");
        f.ignore("roots");
        f.ignore("sessions");
        f.finish();
    }
    out.capabilities = capabilities;
    if let Some(Value::Array(items)) = map.get("roots") {
        out.roots = items.iter().enumerate().map(|(i, v)| root(&format!("{path}.roots[{i}]"), v, &mut drift)).collect();
    } else {
        drift.push(Drift { path: format!("{path}.roots"), reason: "expected an array of roots".into() });
    }
    if let Some(Value::Array(items)) = map.get("sessions") {
        out.sessions = items.iter().enumerate().map(|(i, v)| session(&format!("{path}.sessions[{i}]"), v, &mut drift)).collect();
    } else {
        drift.push(Drift { path: format!("{path}.sessions"), reason: "expected an array of sessions".into() });
    }
    (out, drift)
}

fn device(path: &str, map: &Map<String, Value>, drift: &mut Vec<Drift>) -> pb::Device {
    let mut f = Fields::new(path, map, drift);
    let out = pb::Device {
        id: f.string("id"), kind: f.string("kind"), title: f.string("title"),
        reachable: f.bool("reachable"), checked_at: f.optional_string("checkedAt"),
        issues: f.strings("issues"),
    };
    f.finish();
    out
}

fn dashboard_action(path: &str, value: &Value, drift: &mut Vec<Drift>) -> pb::DashboardAction {
    let Some(map) = as_object(path, value, drift) else { return pb::DashboardAction::default() };
    let device_path = format!("{path}.device");
    let mut env = std::collections::HashMap::new();
    let mut out = pb::DashboardAction::default();
    {
        let mut f = Fields::new(path, map, drift);
        out.id = f.string("id");
        out.title = f.string("title");
        out.description = f.optional_string("description");
        let kind_raw = f.string("kind");
        out.script = f.optional_string("script");
        out.args = f.strings("args");
        out.requires = f.strings("requires");
        out.tools = f.strings("tools");
        out.artifacts = f.strings("artifacts");
        out.command = f.strings("command");
        out.filters = f.strings("filters");
        out.into = f.optional_string("into");
        out.format = f.optional_string("format");
        out.game_id = f.optional_string("gameId");
        if let Some(vars) = f.object("env") {
            for (name, value) in vars {
                match value {
                    Value::String(s) => { env.insert(name.clone(), s.clone()); }
                    other => f.note(&format!("env.{name}"), format!("expected a string, the host sent {}", kind_of(other))),
                }
            }
        }
        out.available = f.bool("available");
        out.missing = f.strings("missing");
        f.ignore("device");
        f.finish();
        out.kind = action_kind(path, &kind_raw, drift);
    }
    out.env = env;
    if let Some(Value::Object(d)) = map.get("device") {
        out.device = Some(device(&device_path, d, drift));
    }
    out
}

pub fn dashboard(value: &Value) -> (pb::Dashboard, Vec<Drift>) {
    let mut drift = Vec::new();
    let path = "dashboard";
    let Some(map) = as_object(path, value, &mut drift) else { return (pb::Dashboard::default(), drift) };
    let mut out = pb::Dashboard::default();
    {
        let mut f = Fields::new(path, map, &mut drift);
        out.root_id = f.string("rootId");
        out.declared = f.bool("declared");
        out.contract = f.optional_integer("contract").unwrap_or_default().max(0) as u32;
        out.title = f.optional_string("title");
        f.ignore("groups");
        f.finish();
    }
    match map.get("groups") {
        Some(Value::Array(groups)) => {
            for (i, group) in groups.iter().enumerate() {
                let group_path = format!("{path}.groups[{i}]");
                let Some(g) = as_object(&group_path, group, &mut drift) else { continue };
                let mut actions = Vec::new();
                let (id, title);
                {
                    let mut f = Fields::new(&group_path, g, &mut drift);
                    id = f.string("id");
                    title = f.string("title");
                    f.ignore("actions");
                    f.finish();
                }
                if let Some(Value::Array(items)) = g.get("actions") {
                    for (k, action) in items.iter().enumerate() {
                        actions.push(dashboard_action(&format!("{group_path}.actions[{k}]"), action, &mut drift));
                    }
                }
                out.groups.push(pb::DashboardGroup { id, title, actions });
            }
        }
        _ => drift.push(Drift { path: format!("{path}.groups"), reason: "expected an array of groups".into() }),
    }
    (out, drift)
}

pub fn task_list(value: &Value) -> (pb::TaskList, Vec<Drift>) {
    let mut drift = Vec::new();
    let path = "tasks";
    let Some(map) = as_object(path, value, &mut drift) else { return (pb::TaskList::default(), drift) };
    let mut out = pb::TaskList::default();
    {
        let mut f = Fields::new(path, map, &mut drift);
        out.root_id = f.string("rootId");
        out.declared = f.bool("declared");
        out.provider = f.string("provider");
        out.contract = f.optional_integer("contract").unwrap_or_default().max(0) as u32;
        out.fresh = f.bool("fresh");
        out.categories = f.strings("categories");
        out.denied = f.optional_string("denied");
        out.unavailable = f.optional_string("unavailable");
        out.invalid = f.strings("invalid");
        out.sign_in = f.optional_string("signIn");
        f.ignore("rows");
        f.finish();
    }
    for (i, row) in map.get("rows").and_then(Value::as_array).into_iter().flatten().enumerate() {
        let row_path = format!("{path}.rows[{i}]");
        let Some(r) = as_object(&row_path, row, &mut drift) else { continue };
        let state_path = format!("{row_path}.state");
        let mut task = pb::Task::default();
        {
            let mut f = Fields::new(&row_path, r, &mut drift);
            task.id = f.string("id");
            task.key = f.string("key");
            task.title = f.string("title");
            task.priority = f.optional_string("priority");
            task.labels = f.strings("labels");
            task.assignee = f.optional_string("assignee");
            task.url = f.optional_string("url");
            task.updated_at = f.optional_string("updatedAt");
            task.blocked_by = f.strings("blockedBy");
            task.criteria = f.strings("criteria");
            task.evidence = f.strings("evidence");
            // Contract 10's per-task test manifest (F137): a nested shape with runs, outcomes and
            // artifacts. Companion v0.1 is see/chat/approve (spec 128 decision 9) and does not show
            // test outcomes, so v1 does not carry it — a decision, not an oversight. It becomes its
            // own message when the companion grows the Tasks view that reads it.
            f.ignore("tests");
            f.ignore("state");
            f.finish();
        }
        if let Some(Value::Object(s)) = r.get("state") {
            let mut f = Fields::new(&state_path, s, &mut drift);
            task.state = Some(pb::TaskState { id: f.string("id"), name: f.string("name"), category: f.string("category") });
            f.finish();
        } else {
            drift.push(Drift { path: state_path, reason: "expected the task's state object".into() });
        }
        out.rows.push(task);
    }
    (out, drift)
}

pub fn agent_menu(value: &Value) -> (pb::AgentMenu, Vec<Drift>) {
    let mut drift = Vec::new();
    let path = "agents";
    let Some(map) = as_object(path, value, &mut drift) else { return (pb::AgentMenu::default(), drift) };
    let mut out = pb::AgentMenu::default();
    {
        let mut f = Fields::new(path, map, &mut drift);
        out.root_id = f.string("rootId");
        out.declared = f.bool("declared");
        f.ignore("agents");
        f.ignore("live");
        f.finish();
    }
    for (i, entry) in map.get("agents").and_then(Value::as_array).into_iter().flatten().enumerate() {
        let entry_path = format!("{path}.agents[{i}]");
        let Some(e) = as_object(&entry_path, entry, &mut drift) else { continue };
        let mut f = Fields::new(&entry_path, e, &mut drift);
        out.agents.push(pb::AgentRecipe {
            cli: f.string("cli"), installed: f.bool("installed"),
            models: f.strings("models"), default_model: f.optional_string("default"),
        });
        f.finish();
    }
    for (i, entry) in map.get("live").and_then(Value::as_array).into_iter().flatten().enumerate() {
        let entry_path = format!("{path}.live[{i}]");
        let Some(e) = as_object(&entry_path, entry, &mut drift) else { continue };
        let mut f = Fields::new(&entry_path, e, &mut drift);
        out.live.push(pb::LiveAgent {
            session_id: f.string("sessionId"), conversation: f.optional_string("conversation"),
            label: f.string("label"), task: f.optional_string("task"),
        });
        f.finish();
    }
    (out, drift)
}

fn token_party(path: &str, value: &Value, drift: &mut Vec<Drift>) -> Option<pb::TokenParty> {
    let Value::Object(map) = value else {
        if !value.is_null() {
            drift.push(Drift { path: path.to_string(), reason: format!("expected an object or null, the host sent {}", kind_of(value)) });
        }
        return None;
    };
    let mut f = Fields::new(path, map, drift);
    let out = pb::TokenParty {
        kind: f.optional_string("kind"), pid: f.optional_integer("pid").unwrap_or_default().max(0) as u32,
        id: f.optional_string("id"), label: f.optional_string("label"),
    };
    f.finish();
    Some(out)
}

pub fn token(value: &Value) -> (pb::Token, Vec<Drift>) {
    let mut drift = Vec::new();
    let path = "token";
    let Some(map) = as_object(path, value, &mut drift) else { return (pb::Token::default(), drift) };
    let mut cooldown = std::collections::HashMap::new();
    let mut out = pb::Token::default();
    {
        let mut f = Fields::new(path, map, &mut drift);
        out.root_id = f.string("rootId");
        out.window_ms = f.integer("window").max(0) as u32;
        out.holds_token = f.bool("holdsToken");
        out.holder_alive = f.optional_bool("holderAlive");
        out.sequence = f.integer("sequence").max(0) as u64;
        out.token_sequence = f.integer("tokenSequence").max(0) as u64;
        out.feed_cursor = f.integer("feedCursor").max(0) as u64;
        if let Some(rows) = f.object("cooldown") {
            for (name, until) in rows {
                match until {
                    Value::String(s) => { cooldown.insert(name.clone(), s.clone()); }
                    Value::Number(n) => { cooldown.insert(name.clone(), n.to_string()); }
                    other => f.note(&format!("cooldown.{name}"), format!("expected a string or number, the host sent {}", kind_of(other))),
                }
            }
        }
        f.ignore("holder");
        f.ignore("contest");
        f.ignore("identities");
        f.ignore("history");
        // Answers about the CALLER rather than the token, and the façade's caller is never the phone.
        f.ignore("caller");
        f.ignore("refusal");
        // A loopback URL with the host's own bearer token in it: never leaves this machine.
        f.ignore("feed");
        f.finish();
    }
    out.cooldown = cooldown;
    if let Some(holder) = map.get("holder") { out.holder = token_party(&format!("{path}.holder"), holder, &mut drift); }
    if let Some(Value::Object(contest)) = map.get("contest") {
        let contest_path = format!("{path}.contest");
        let by;
        {
            let mut f = Fields::new(&contest_path, contest, &mut drift);
            f.ignore("by");
            out.contest = Some(pb::TokenContest {
                by: None, deadline: f.optional_string("deadline"),
                seconds_left: f.optional_integer("secondsLeft").unwrap_or_default().max(0) as u32,
            });
            f.finish();
        }
        by = contest.get("by").and_then(|v| token_party(&format!("{contest_path}.by"), v, &mut drift));
        if let Some(c) = out.contest.as_mut() { c.by = by; }
    }
    for (i, party) in map.get("identities").and_then(Value::as_array).into_iter().flatten().enumerate() {
        if let Some(p) = token_party(&format!("{path}.identities[{i}]"), party, &mut drift) { out.identities.push(p); }
    }
    for (i, event) in map.get("history").and_then(Value::as_array).into_iter().flatten().enumerate() {
        let event_path = format!("{path}.history[{i}]");
        let Some(e) = as_object(&event_path, event, &mut drift) else { continue };
        let by;
        let mut row = pb::TokenEvent::default();
        {
            let mut f = Fields::new(&event_path, e, &mut drift);
            row.sequence = f.integer("sequence").max(0) as u64;
            row.at = f.string("at");
            row.r#type = f.string("type");
            f.ignore("by");
            f.finish();
        }
        by = e.get("by").and_then(|v| token_party(&format!("{event_path}.by"), v, &mut drift));
        row.by = by;
        out.history.push(row);
    }
    (out, drift)
}

/// One feed frame. An unknown `type` is drift: the companion must report a message it cannot read
/// rather than drop it, which is why the contract models the feed as a oneof and not a string.
pub fn feed_event(path: &str, value: &Value) -> (pb::FeedEvent, Vec<Drift>) {
    let mut drift = Vec::new();
    let Some(map) = as_object(path, value, &mut drift) else { return (pb::FeedEvent::default(), drift) };
    let kind = map.get("type").and_then(Value::as_str).unwrap_or_default().to_string();
    let event = match kind.as_str() {
        "hello" => {
            let mut f = Fields::new(path, map, &mut drift);
            f.ignore("type");
            let out = pb::feed_event::Event::Hello(pb::Hello { instance: f.string("instance") });
            f.finish();
            Some(out)
        }
        "session" | "attached" => {
            let mut f = Fields::new(path, map, &mut drift);
            f.ignore("type");
            f.ignore("session");
            f.finish();
            let inner = map.get("session")
                .map(|s| session(&format!("{path}.session"), s, &mut drift))
                .unwrap_or_else(|| { drift.push(Drift { path: format!("{path}.session"), reason: "the event carries no session".into() }); pb::Session::default() });
            Some(if kind == "session" {
                pb::feed_event::Event::Session(pb::SessionChanged { session: Some(inner) })
            } else {
                pb::feed_event::Event::Attached(pb::Attached { session: Some(inner) })
            })
        }
        "output" => {
            let mut f = Fields::new(path, map, &mut drift);
            f.ignore("type");
            let out = pb::feed_event::Event::Output(pb::Output {
                session_id: f.string("id"),
                sequence: f.integer("sequence").max(0) as u64,
                data: f.string("data").into_bytes(),
            });
            f.finish();
            Some(out)
        }
        "error" => {
            let mut f = Fields::new(path, map, &mut drift);
            f.ignore("type");
            let out = pb::feed_event::Event::Error(pb::FeedError { message: f.string("error") });
            f.finish();
            Some(out)
        }
        other => {
            drift.push(Drift { path: format!("{path}.type"), reason: format!("the host sent the feed event {other:?}, which the contract does not carry") });
            None
        }
    };
    (pb::FeedEvent { event }, drift)
}
