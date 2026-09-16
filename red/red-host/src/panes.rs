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

use red_agents::handoff::{check_resume, read_handoff};
use crate::routes::{faulted, http_text};
use crate::{ask, ask_pty, Front};

/// `shortAgentId`, which is the CLI's own rule: a prefix to strip and a length, declared in the
/// agent registry. The registry is red-agents' — this crate reads it rather than restating it,
/// because a title that shortened a kimi id by eight characters would show `session_` every time.
fn recipes() -> Vec<(String, red_agents::Value)> {
    let path = registry();
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    /* Including the extra document: a recipe added as DATA is the registry's central promise, and a
       host that read only the shipped file would answer about a CLI it had been told about as
       though it did not exist (F216, spec 141). */
    let extra = std::env::var("RENGINE_AGENT_REGISTRY_EXTRA")
        .ok()
        .filter(|path| !path.is_empty())
        .and_then(|path| std::fs::read_to_string(&path).ok().map(|text| (text, path)));
    red_agents::load_registry(&text, &path, extra.as_ref().map(|(text, path)| (text.as_str(), path.as_str())))
        .unwrap_or_default()
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
        .map(|checkout| checkout.join("agents/registry.toml").to_string_lossy().into_owned())
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
        Err(error) => return faulted(&format!("400|Invalid JSON body: {error}")),
    };
    let id = payload.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let Some(pane) = front.panes.lock().expect("panes lock").get(&id).cloned() else {
        return faulted("404|Unknown session.");
    };
    let held = |name: &str| pane.get("meta").and_then(|record| record.get(name)).filter(|value| !value.is_null()).cloned();
    if held("type").and_then(|value| value.as_str().map(str::to_string)).as_deref() != Some("agent") {
        return faulted("400|Only an agent session holds a conversation.");
    }
    let root_id = held("rootId").and_then(|value| value.as_str().map(str::to_string)).unwrap_or_default();
    let named = payload.get("agent").and_then(Value::as_str).unwrap_or_default().to_string();
    let known = held("agent").and_then(|value| value.as_str().map(str::to_string)).unwrap_or_default();
    /* The pane may be the first to know which agent it is: a launch that offered a choice starts
       with none, and the pane says so when it has one. An agent it already has is not replaced. */
    let agent = if !named.is_empty() && known.is_empty() { named.clone() } else { known.clone() };
    let root = match ask(front, "root", json!([root_id])).await {
        Ok(root) => root,
        Err(fault) => return faulted(&fault),
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
        /* The task is carried ONLY when the caller sent one. A conversation is reported more than
           once — the workspace names it when it spawns a pane ON a task, and then the pane itself
           reports what it actually launched, which knows nothing about tasks — and the store reads
           an explicit `null` as "forget the task". Sending one for an absent field would wipe the
           task on every pane's own report, which is how this was found. */
        let mut asked = serde_json::Map::new();
        asked.insert("conversation".to_string(), conversation.clone());
        asked.insert("agent".to_string(), if agent.is_empty() { Value::Null } else { json!(agent) });
        if let Some(task) = payload.get("task") {
            asked.insert("task".to_string(), task.clone());
        }
        let entry = match ask(front, "recordConversation", json!([root_id, Value::Object(asked)])).await {
            Ok(entry) => entry,
            Err(fault) => return faulted(&fault),
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
        Ok(session) => http_text(200, "OK", &pane_answer(&session, false)),
        Err(fault) => faulted(&fault),
    }
}

/* ---- making a pane ---------------------------------------------------------------------------- */

/// `/api/terminal`: the route that starts a pane. Everything here is `spawnTerminal`'s order, and
/// the order is the behaviour — the title is judged before the root is looked up, the working
/// directory before the type, and the handoff before anything is written down — because a caller
/// that sent two wrong things sees the JS host's answer for the first of them.
///
/// What this does NOT re-implement is the composition itself: which conversation a pane claims,
/// what it is offered, and what it launches are `red_agents`' (F168), one implementation that both
/// hosts call. What is here is the plumbing around it: the paths, the environment, the handoff read,
/// and the record the pane is known by.
pub(crate) async fn terminal(front: &Arc<Front>, body: &str) -> String {
    let options: Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(error) => return faulted(&format!("400|Invalid JSON body: {error}")),
    };
    if !options.is_object() {
        return faulted("400|Expected an object.");
    }
    /* A game is not launched here. `/api/game` composes one from the project's declaration and the
       surface it reserves; this route refuses the word before anything is composed, because a pane
       that called itself a game would be a game session with no game behind it. */
    if options.get("type").and_then(Value::as_str).is_some_and(|kind| !["terminal", "agent"].contains(&kind)) {
        return faulted("400|Use the game adapter to launch a game.");
    }
    match spawn_pane(front, &options).await {
        Ok(session) => http_text(200, "OK", &pane_answer(&session, false)),
        Err(fault) => faulted(&fault),
    }
}

/// Pressing a dashboard action that becomes a terminal (F156).
///
/// `None` is this door declining: a GAME action reserves a workspace surface and joins an in-flight
/// launch, which is the session host's state and not the door's, so it falls through to the
/// forwarder exactly as a remote tracker does. Everything else is `red_project::dashboard`'s payload
/// and this crate's own pane spawn.
pub(crate) async fn dashboard_run(front: &Arc<Front>, body: &str) -> Option<String> {
    let data: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let root = match ask(front, "root", json!([data.get("rootId").and_then(Value::as_str).unwrap_or_default()])).await {
        Ok(root) => root,
        Err(fault) => return Some(faulted(&fault)),
    };
    let id = root.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let root_path = root.get("path").and_then(Value::as_str).unwrap_or_default().to_string();
    let declaration_file = root.get("declarationFile").and_then(Value::as_str).map(str::to_string);
    let action_id = data.get("actionId").and_then(Value::as_str).map(str::to_string);
    let bash = bash_path();
    let front_for_board = front.clone();
    /* The board probes every device an action is bound to, so it is read off the async threads. */
    let composed = tokio::task::spawn_blocking(move || {
        let environment: Vec<(String, String)> = std::env::vars().collect();
        let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|since| since.as_millis() as i64).unwrap_or(0);
        let context = red_project::devices::Context {
            root_id: &id,
            root_path: &root_path,
            environment: &environment,
            probes: &front_for_board.probes,
            refresh: false,
            refreshed: Default::default(),
            controls: false,
            now: &now,
        };
        let declared = red_project::declaration::read(&root_path, declaration_file.as_deref());
        let action = red_project::dashboard::dashboard_action(&context, &declared, action_id.as_deref())?;
        /* A GAME action is a launch, and launching is this door's now (F155, spec 142): the action
           names the game and the arguments, and `games::launch` does the rest. It used to be
           declined here because the surface it reserves was the JS host's state. */
        if action.get("kind").and_then(Value::as_str) == Some("game") {
            return Ok(Err(json!({
                "rootId": id,
                "gameId": action.get("game").cloned().unwrap_or(Value::Null),
                "args": action.get("args").cloned().unwrap_or(Value::Null),
            })));
        }
        red_project::dashboard::run_payload(&id, &root_path, &bash, &action).map(Ok)
    })
    .await;
    let payload = match composed {
        Ok(Ok(Ok(payload))) => payload,
        /* The action was a game: the launch route answers it, refusals and all. */
        Ok(Ok(Err(launch))) => return Some(crate::games::launch(front, &launch.to_string()).await),
        Ok(Err(fail)) => return Some(faulted(&crate::routes::refusal(fail))),
        Err(error) => return Some(faulted(&format!("500|{error}"))),
    };
    match spawn_pane(front, &payload).await {
        Ok(session) => {
            /* `{ ...session, title: payload.title }`: a retained host older than the title option
               labels its sessions generically, so the title this composed is the one answered. */
            let mut answer = pane_snapshot(&session).as_object().cloned().unwrap_or_default();
            answer.insert("title".into(), payload.get("title").cloned().unwrap_or(Value::Null));
            Some(http_text(200, "OK", &Value::Object(answer).to_string()))
        }
        Err(fault) => Some(faulted(&fault)),
    }
}

/// A game's pane, composed by  once every refusal has passed. The same spawn as a
/// terminal's, reached past the route's refusal of the word  — that refusal is about a caller
/// naming a type, not about this door being unable to start one.
pub(crate) async fn spawn_for_game(front: &Arc<Front>, options: &Value) -> Result<Value, String> {
    spawn_pane(front, options).await
}

async fn spawn_pane(front: &Arc<Front>, options: &Value) -> Result<Value, String> {
    let text = |name: &str| options.get(name).and_then(Value::as_str).map(str::to_string);
    let title = options.get("title").filter(|value| !value.is_null());
    if let Some(title) = title {
        let sane = title.as_str().is_some_and(|value| !value.trim().is_empty() && value.encode_utf16().count() <= 200);
        if !sane {
            return Err("400|Session title must be a short string.".to_string());
        }
    }
    let kind = text("type").unwrap_or_else(|| "terminal".to_string());
    let root = ask(front, "root", json!([text("rootId").unwrap_or_default()])).await?;
    let root_id = root.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let root_path = std::path::PathBuf::from(root.get("path").and_then(Value::as_str).unwrap_or_default());
    let root_name = root.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
    let working = match text("cwd") {
        Some(cwd) => {
            let named = std::path::PathBuf::from(&cwd);
            if named.is_absolute() { named } else { std::env::current_dir().unwrap_or_default().join(named) }
        }
        None => root_path.clone(),
    };
    /* By path components, not by prefix: `/a/bcd` is not inside `/a/bc`, and a string comparison
       says it is. */
    if working != root_path && !working.starts_with(&root_path) {
        return Err("400|The working directory must be inside the project root.".to_string());
    }
    let id = crate::uuid_v4();
    let state = std::path::PathBuf::from(&front.state);
    let agent_home = state.join("agents");

    /* What this launch composes for itself and must never inherit — cleared in BOTH compositions
       below, because a pane that inherited another pane's identity would report as it (KI-068). */
    let cleared = ["RENGINE_HANDOFF_GATE", "RENGINE_HANDOFF_FILE", "RENGINE_ORCHESTRATOR_SESSION",
        "RENGINE_AGENT_CONVERSATION", "RENGINE_AGENT_RESUME", "RENGINE_AGENT_CONVERSATIONS"];
    let mut overrides = serde_json::Map::new();
    if let Some(given) = options.get("env").and_then(Value::as_object) {
        for (name, value) in given {
            overrides.insert(name.clone(), value.clone());
        }
    }
    overrides.insert("RENGINE_AGENT_HOME".to_string(), json!(agent_home.to_string_lossy()));
    for name in cleared {
        overrides.insert(name.to_string(), Value::Null);
    }
    /* The environment as it stands BEFORE this launch adds its own: what the handoff read and the
       resume check see, which is the env the JS host passes them at exactly this point. */
    let env = compose_env(&overrides);

    let mut handoff: Option<Value> = None;
    let mut gate: Option<String> = None;
    if let Some(manifest) = text("handoffFile") {
        /* Which CLIs can be handed a paused conversation is the recipes' to say, not a name to
           compare (F216, spec 141): a CLI declares `conversation.handoff` or it cannot be handed
           one. Everything else about the shape of this launch is unchanged. */
        let cli = text("agent").unwrap_or_default();
        let known = recipes();
        let declared = red_agents::launch::conversation_handoff(&known[..], &cli);
        let Some(declared) = declared.filter(|_| kind == "agent") else {
            return Err("400|Handoff requires a workspace launcher for a CLI that can be handed a conversation.".to_string());
        };
        if text("action").unwrap_or_else(|| "launch".into()) != "launch"
            || options.get("args").and_then(Value::as_array).is_some_and(|args| !args.is_empty())
        {
            return Err("400|Handoff requires a workspace launcher for a CLI that can be handed a conversation.".to_string());
        }
        let ids = red_agents::launch::conversation_ids(&known[..], &cli);
        /* A pane is always IN a root, so the host always cross-checks; the launcher is the caller
           that may have no project to compare against. */
        let read = read_handoff(&manifest, Some(&root_path), &env, &declared, ids.as_deref())?;
        /* A pane already running this conversation is the answer, not a second one: the launcher is
           allowed to ask twice and a person must not end up with two CLIs on one session. */
        let running = front.panes.lock().expect("panes lock").values().find(|session| {
            let record = |name: &str| session.get("meta").and_then(|meta| meta.get(name)).cloned();
            session.get("state").and_then(Value::as_str) == Some("running")
                && record("rootId").and_then(|value| value.as_str().map(str::to_string)) == Some(root_id.clone())
                && record("handoff").and_then(|value| value.get("sessionId").cloned())
                    == read.get("sessionId").cloned()
        }).cloned();
        if let Some(session) = running {
            return Ok(session);
        }
        check_resume(&bash_path(), &cli, &root_path, &env)?;
        let path = state.join("integrations").join(format!("{id}.ready"));
        gate = Some(path.to_string_lossy().into_owned());
        overrides.insert("RENGINE_HANDOFF_GATE".to_string(), json!(gate));
        overrides.insert("RENGINE_HANDOFF_FILE".to_string(), read.get("filename").cloned().unwrap_or(Value::Null));
        overrides.insert("RENGINE_ORCHESTRATOR_SESSION".to_string(), json!(id));
        handoff = Some(read);
    }
    if !["terminal", "agent", "game"].contains(&kind.as_str()) {
        return Err("400|Unsupported terminal type.".to_string());
    }
    let cols = options.get("cols").and_then(Value::as_i64).unwrap_or(100);
    let rows = options.get("rows").and_then(Value::as_i64).unwrap_or(30);
    if !(2..=500).contains(&cols) || !(1..=300).contains(&rows) {
        return Err("400|Invalid terminal dimensions.".to_string());
    }
    let mut file = text("command").unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()));
    let mut argv: Vec<String> = match options.get("args").and_then(Value::as_array) {
        Some(items) => items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect(),
        None => vec!["-l".to_string()],
    };
    let mut conversation = text("conversation");
    if kind == "agent" {
        file = bash_path();
        let integrations = state.join("integrations");
        std::fs::create_dir_all(&integrations).map_err(|error| format!("500|cannot prepare {}: {error}", integrations.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&integrations, std::fs::Permissions::from_mode(0o700));
        }
        if let Some(read) = handoff.as_ref() {
            /* The manifest this launch will read is a SNAPSHOT of the one it was given: the file on
               disk may be edited afterwards, and a pane must not be retargeted underneath it. */
            let snapshot = integrations.join(format!("{id}.handoff.json"));
            let document = json!({
                "version": 1, "project": root_path.to_string_lossy(),
                "sessionId": read.get("sessionId").cloned().unwrap_or(Value::Null),
                "checkpoint": read.get("checkpoint").cloned().unwrap_or(Value::Null),
            });
            write_private(&snapshot, document.to_string().as_bytes())?;
            overrides.insert("RENGINE_HANDOFF_FILE".to_string(), json!(snapshot.to_string_lossy()));
        }
        let context = integrations.join(format!("{root_id}.json"));
        write_private(&context, agent_context(&front.url, &front.token, &front.instance, &root_id).to_string().as_bytes())?;

        let decided = conversation.is_some() || options.get("args").and_then(Value::as_array).is_some_and(|args| !args.is_empty());
        let remembered = if decided {
            json!([])
        } else {
            ask(front, "listConversations", json!([root_id])).await?
        };
        let agent = text("agent").unwrap_or_default();
        let known = recipes();
        let plan = red_agents::spawn::agent_pane_composition(
            &json!({
                "id": id,
                "agent": if agent.is_empty() { Value::Null } else { json!(agent) },
                "conversation": conversation.clone().map(Value::from).unwrap_or(Value::Null),
                "resume": options.get("resume").and_then(Value::as_bool).unwrap_or(false),
                "action": text("action").unwrap_or_else(|| "launch".to_string()),
                "args": options.get("args").cloned().unwrap_or(Value::Null),
                "workspace": true,
                "remembered": remembered,
                "paths": {
                    "agentScript": checkout().join("actions/pane/posix/agent.sh").to_string_lossy(),
                    "rootPath": root_path.to_string_lossy(),
                    "workspaceContextFile": context.to_string_lossy(),
                    "listingFile": integrations.join(format!("{id}.conversations.tsv")).to_string_lossy(),
                    "node": node_path(),
                    "bash": file,
                },
                "mint": crate::uuid_v4(),
                "now": now_ms(),
            }),
            red_agents::spawn::conversation_start_capability(&known[..], &agent),
        );
        if let Some(refusal) = plan.get("refuse").and_then(Value::as_str) {
            return Err(format!("400|{refusal}"));
        }
        if let Some(record) = plan.get("record").filter(|value| !value.is_null()) {
            ask(front, "recordConversation", json!([root_id, record])).await?;
        }
        if let Some(listing) = plan.get("listing").filter(|value| !value.is_null()) {
            let file = listing.get("file").and_then(Value::as_str).unwrap_or_default();
            let content = listing.get("content").and_then(Value::as_str).unwrap_or_default();
            write_private(std::path::Path::new(file), content.as_bytes())?;
        }
        argv = plan.get("argv").and_then(Value::as_array)
            .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        conversation = plan.get("conversation").and_then(Value::as_str).map(str::to_string);
        if let Some(sets) = plan.get("sets").and_then(Value::as_object) {
            for (name, value) in sets {
                overrides.insert(name.clone(), value.clone());
            }
        }
    } else {
        conversation = None;
    }

    let mut record = serde_json::Map::new();
    record.insert("rootId".to_string(), json!(root_id));
    record.insert("type".to_string(), json!(kind));
    if kind == "agent" {
        record.insert("agent".to_string(), json!(text("agent").unwrap_or_default()));
        record.insert("conversation".to_string(), conversation.clone().map(Value::from).unwrap_or(Value::Null));
    }
    if kind == "game" {
        record.insert("surface".to_string(), options.get("surface").cloned().unwrap_or(Value::Null));
        record.insert("game".to_string(), options.get("game").cloned().unwrap_or(Value::Null));
        record.insert("args".to_string(), json!(argv));
    }
    if let Some(read) = handoff.as_ref() {
        record.insert("handoff".to_string(), read.clone());
    }
    if let Some(path) = gate.as_ref() {
        record.insert("gate".to_string(), json!(path));
    }
    record.insert("released".to_string(), json!(gate.is_none()));
    record.insert("titleAuto".to_string(), json!(title.is_none()));
    record.insert("title".to_string(), json!(match title.and_then(Value::as_str) {
        Some(given) => given.to_string(),
        None if kind == "agent" => agent_title(&text("agent").unwrap_or_default(), conversation.as_deref(), &root_name),
        None => format!("{} · {root_name}", if kind == "game" { "Game" } else { "Terminal" }),
    }));
    record.insert("createdAt".to_string(), json!(now_ms()));
    /* `cleared` first, so this launch's own values win and only what it left out stays deleted. */
    let mut final_overrides = serde_json::Map::new();
    for name in cleared {
        final_overrides.insert(name.to_string(), Value::Null);
    }
    for (name, value) in &overrides {
        final_overrides.insert(name.clone(), value.clone());
    }
    final_overrides.insert("RENGINE_AGENT_HOME".to_string(), json!(agent_home.to_string_lossy()));
    let env = compose_env(&final_overrides);

    let started = ask_pty(front, "spawn", json!([{
        "id": id, "meta": Value::Object(record), "command": file, "args": argv,
        "cols": cols, "rows": rows, "cwd": working.to_string_lossy(), "env": env,
    }])).await?;
    /* Known here, now. The service announces every session it holds and that announcement is how
       this door learns of panes OTHER hosts start — but for a pane this door just started, waiting
       for the announcement to come back is a race a caller can beat: the worker's next call is
       `agent-conversation` on the pane it was just handed, and a door that had not caught up would
       answer `Unknown session.` about a pane it started itself. */
    if let Some(fields) = started.as_object() {
        if let Some(known) = fields.get("id").and_then(Value::as_str) {
            let mut lean = started.clone();
            if let Some(object) = lean.as_object_mut() {
                object.remove("output");
            }
            front.panes.lock().expect("panes lock").insert(known.to_string(), lean);
        }
    }
    Ok(started)
}

/// `/api/agent-restart`: the same conversation, a new child, a freshly composed environment. The
/// pane's id changes — it is a different process — and everything that made it what it is comes
/// from the record the old pane left behind, which is why this can be answered by a host that did
/// not start it (D62).
pub(crate) async fn restart(front: &Arc<Front>, body: &str) -> String {
    let payload: Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(error) => return faulted(&format!("400|Invalid JSON body: {error}")),
    };
    let id = payload.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let Some(pane) = front.panes.lock().expect("panes lock").get(&id).cloned() else {
        return faulted("404|Unknown session.");
    };
    let held = |name: &str| pane.get("meta").and_then(|record| record.get(name)).filter(|value| !value.is_null()).cloned();
    let string = |name: &str| held(name).and_then(|value| value.as_str().map(str::to_string));
    if string("type").as_deref() != Some("agent") {
        return faulted("400|Only an agent session can be restarted into its conversation.");
    }
    let agent = string("agent").unwrap_or_default();
    let Some(conversation) = string("conversation") else {
        /* Named in the person's own terms: a pane with no conversation to resume is not a pane this
           can restart, and the answer says what to do instead. */
        return faulted(&format!(
            "400|This {} pane has no conversation rEngine can resume; stop it and start a new one.",
            if agent.is_empty() { "agent" } else { &agent }
        ));
    };
    if let Err(fault) = ask_pty(front, "stop", json!([id])).await {
        return faulted(&fault);
    }
    let options = json!({
        "rootId": string("rootId").unwrap_or_default(),
        "type": "agent",
        "agent": agent,
        "conversation": conversation,
        "resume": true,
        "cols": pane.get("cols").cloned().unwrap_or(Value::Null),
        "rows": pane.get("rows").cloned().unwrap_or(Value::Null),
    });
    match spawn_pane(front, &options).await {
        Ok(session) => http_text(200, "OK", &pane_answer(&session, false)),
        Err(fault) => faulted(&fault),
    }
}

/// `shellEnvironment`, from red-agents, over this process's own environment — the same function the
/// JS host calls, so a pane's environment is composed once in the workspace rather than twice.
fn compose_env(overrides: &serde_json::Map<String, Value>) -> Value {
    let inherited: serde_json::Map<String, Value> =
        std::env::vars().map(|(name, value)| (name, json!(value))).collect();
    let known = recipes();
    let composed = red_agents::spawn::shell_environment(
        overrides,
        &inherited,
        std::env::consts::OS,
        &std::env::var("HOME").unwrap_or_default(),
        &red_agents::launch::process_identity(&known[..]),
        &red_agents::launch::install_paths(&known[..]),
    );
    json!(composed)
}

/// One implementation, in `red_project::command`, because the worker names the same interpreter
/// when it opens a project script as a tab and the two must not disagree.
fn bash_path() -> String {
    red_project::command::bash_path()
}

/// The node a pane's launcher runs. The JS host passed the exact interpreter running it; this door
/// has none of its own, so it resolves one — and it must be an absolute path, because `RENGINE_NODE`
/// is EXPORTED into every pane and a script that asks `[ -x "$RENGINE_NODE" ]` gets a no from a
/// bare name. Shared with the launcher's build, which bakes the same value into the desktop.
fn node_path() -> String {
    red_project::command::node_path()
}

/// The binding an agent pane's CLI reads, and the one its connector routes by (spec 095).
///
/// `runtimeDirectory` is the writer arm of KI-110: the reader computes this same default when the
/// field is absent, and a door that left it out made that reader the only thing standing.
fn agent_context(url: &str, token: &str, instance: &str, root_id: &str) -> Value {
    json!({
        "url": url, "token": token, "instance": instance, "rootId": root_id,
        "runtimeDirectory": checkout().join(".cache/runtime").join(instance).to_string_lossy(),
    })
}

fn checkout() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .map(std::path::Path::to_path_buf)
        .unwrap_or_default()
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

/// 0600, and through a temporary name where the reader might already be looking: a pane's context
/// file is read by the CLI this launch is about to start.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("tmp.{}", crate::uuid_v4()));
    std::fs::write(&temporary, bytes).map_err(|error| format!("500|cannot write {}: {error}", temporary.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&temporary, path).map_err(|error| format!("500|cannot publish {}: {error}", path.display()))
}
/// The pane as the JS host says it: the service's own fields, the host's record, and the two
/// shapes a caller reads — `waitingForView` for a handoff pane, and the scrollback on request.
///
/// Absence is meaningful here. `exitCode`, `signal` and `endedAt` are *missing* while a pane runs
/// rather than null, because the JS host leaves them undefined until it has an ending to report,
/// and a native client that asked `has exitCode` would read a null as an answer.
pub(crate) fn pane_snapshot(session: &serde_json::Value) -> serde_json::Value {
    let empty = serde_json::Map::new();
    let record = session.get("meta").and_then(|value| value.as_object()).unwrap_or(&empty);
    let held = |name: &str| record.get(name).filter(|value| !value.is_null()).cloned();
    let own = |name: &str| session.get(name).filter(|value| !value.is_null()).cloned();
    let kind = held("type").and_then(|value| value.as_str().map(str::to_string)).unwrap_or_default();
    let ended = session.get("state").and_then(serde_json::Value::as_str) == Some("exited");
    let mut out = serde_json::Map::new();
    /* A field the JS host leaves undefined is a field its answer does not carry, so `None` here
       means "say nothing" rather than "say null". */
    fn put(out: &mut serde_json::Map<String, serde_json::Value>, name: &str, value: Option<serde_json::Value>) {
        if let Some(value) = value {
            out.insert(name.to_string(), value);
        }
    }
    put(&mut out, "id", own("id"));
    put(&mut out, "rootId", held("rootId"));
    put(&mut out, "type", held("type"));
    put(&mut out, "agent", held("agent"));
    put(&mut out, "title", held("title"));
    put(&mut out, "pid", own("pid"));
    put(&mut out, "state", own("state"));
    /* An ending the JS host has not seen is an ending it does not mention; one it has seen it
       mentions even when the service could not say how (`exitCode: null`). */
    if ended {
        out.insert("exitCode".to_string(), session.get("exitCode").cloned().unwrap_or(serde_json::Value::Null));
        out.insert("signal".to_string(), session.get("signal").cloned().unwrap_or(serde_json::Value::Null));
    }
    put(&mut out, "createdAt", held("createdAt"));
    if ended {
        put(&mut out, "endedAt", own("endedAt"));
    }
    put(&mut out, "cols", own("cols"));
    put(&mut out, "rows", own("rows"));
    put(&mut out, "sequence", own("sequence"));
    put(&mut out, "conversation", held("conversation"));
    put(&mut out, "task", held("task"));
    if kind == "game" {
        put(&mut out, "surface", held("surface"));
        put(&mut out, "game", held("game"));
        out.insert("args".to_string(), held("args").unwrap_or_else(|| serde_json::json!([])));
    }
    if let Some(handoff) = held("handoff") {
        out.insert("handoff".to_string(), serde_json::json!({
            "sessionId": handoff.get("sessionId").cloned().unwrap_or(serde_json::Value::Null),
            "checkpoint": handoff.get("checkpoint").cloned().unwrap_or(serde_json::Value::Null),
        }));
        out.insert("waitingForView".to_string(), serde_json::json!(!held("released").and_then(|value| value.as_bool()).unwrap_or(false)));
    }
    serde_json::Value::Object(out)
}

/// The snapshot as JSON TEXT, because its scrollback cannot travel through a Rust `String` — and
/// that is not a detail to route around. Spec 060 counts the history in JS string characters and
/// the service ships UTF-16 for exactly that reason: a chunk boundary can leave a LONE SURROGATE in
/// it, which is a legal JS string and not a legal Rust one. So `output` is written straight into the
/// answer from the UTF-16 units, every non-ASCII unit as its own `\uXXXX` escape, which `JSON.parse`
/// turns back into the same JS string with its unpaired halves intact. It goes last, where the JS
/// host puts it.
pub(crate) fn pane_answer(session: &serde_json::Value, with_output: bool) -> String {
    let text = pane_snapshot(session).to_string();
    if !with_output {
        return text;
    }
    let units = utf16_from_base64(session.get("output").and_then(serde_json::Value::as_str).unwrap_or_default());
    format!("{},\"output\":{}}}", &text[..text.len() - 1], json_from_utf16(&units))
}

pub(crate) fn json_from_utf16(units: &[u16]) -> String {
    let mut out = String::with_capacity(units.len() + 2);
    out.push('"');
    for unit in units {
        match *unit {
            0x22 => out.push_str("\\\""),
            0x5c => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x0c => out.push_str("\\f"),
            0x0a => out.push_str("\\n"),
            0x0d => out.push_str("\\r"),
            0x09 => out.push_str("\\t"),
            unit if (0x20..0x7f).contains(&unit) => out.push(unit as u8 as char),
            unit => out.push_str(&format!("\\u{unit:04x}")),
        }
    }
    out.push('"');
    out
}

/// Base64 (the wire form the service sends) back to the UTF-16 units it encodes.
pub(crate) fn utf16_from_base64(text: &str) -> Vec<u16> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bytes: Vec<u8> = Vec::with_capacity(text.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for byte in text.bytes() {
        let Some(value) = ALPHABET.iter().position(|entry| *entry == byte) else { continue };
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((buffer >> bits) as u8);
        }
    }
    bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect()
}

/// Typing into a pane, from the route or from the socket — one set of rules, in the JS host's own
/// order: an unknown session is named before the data is judged, and a pane that is not accepting
/// input is named before either.
pub(crate) async fn deliver_input(front: &Arc<Front>, message: &serde_json::Value) -> Result<(), String> {
    let id = message.get("id").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let Some(pane) = front.panes.lock().expect("panes lock").get(&id).cloned() else {
        return Err("404|Unknown session.".to_string());
    };
    if pane.get("state").and_then(serde_json::Value::as_str) != Some("running") {
        return Err("409|Session is not running.".to_string());
    }
    /* The handoff gate, which is the whole reason this record had to become the service's: a pane
       waiting for its native view refuses input, and until D62 only the host that launched it could
       know that. */
    let record = |name: &str| pane.get("meta").and_then(|record| record.get(name)).filter(|value| !value.is_null()).cloned();
    let gated = record("gate").is_some();
    let released = record("released").and_then(|value| value.as_bool()).unwrap_or(false);
    if gated && !released {
        return Err("409|Handoff is waiting for its native view.".to_string());
    }
    let data = message.get("data").and_then(serde_json::Value::as_str);
    if !data.is_some_and(|text| text.encode_utf16().count() <= 1024 * 1024) {
        return Err("400|Invalid terminal input.".to_string());
    }
    /* The delivery is not awaited, because the JS host does not await it either: its route answers
       `{ok: true}` the moment the refusals pass, and a failure after that reaches the pane's own
       event stream rather than this caller. */
    let _ = ask_pty(front, "input", serde_json::json!([id, data.unwrap_or_default()])).await;
    Ok(())
}

/// And resizing one. The dimensions are judged BEFORE the session is looked up, because that is the
/// order the JS host judges them in and a caller sees a different status if they swap.
pub(crate) async fn deliver_resize(front: &Arc<Front>, message: &serde_json::Value) -> Result<(), String> {
    let cols = message.get("cols").and_then(serde_json::Value::as_i64).unwrap_or(-1);
    let rows = message.get("rows").and_then(serde_json::Value::as_i64).unwrap_or(-1);
    if !(2..=500).contains(&cols) || !(1..=300).contains(&rows) {
        return Err("400|Invalid terminal dimensions.".to_string());
    }
    let id = message.get("id").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let Some(pane) = front.panes.lock().expect("panes lock").get(&id).cloned() else {
        return Err("404|Unknown session.".to_string());
    };
    /* A pane that is not running is not resized, and not refused either: the JS host returns from
       `resize` without a word, and the route still answers `{ok: true}`. */
    if pane.get("state").and_then(serde_json::Value::as_str) == Some("running") {
        let _ = ask_pty(front, "resize", serde_json::json!([id, cols, rows])).await;
    }
    Ok(())
}

/// A pane is on a person's screen: the gate it was waiting on is opened, and the record says so for
/// every host (D62). Doing nothing is the answer for a pane that has no gate, was already released,
/// or is no longer running — exactly as the JS host's `presented` does nothing in those cases.
pub(crate) async fn present(front: &Arc<Front>, id: &str) -> Result<(), String> {
    let Some(pane) = front.panes.lock().expect("panes lock").get(id).cloned() else {
        return Err("Unknown session.".to_string());
    };
    let record = |name: &str| pane.get("meta").and_then(|record| record.get(name)).filter(|value| !value.is_null()).cloned();
    let Some(gate) = record("gate").and_then(|value| value.as_str().map(str::to_string)) else { return Ok(()) };
    if record("released").and_then(|value| value.as_bool()).unwrap_or(false)
        || pane.get("state").and_then(serde_json::Value::as_str) != Some("running")
    {
        return Ok(());
    }
    /* The file first, then the record: the pane is watching for the file, and a record that said
       "released" before the gate existed would be a promise this host had not kept yet. */
    let path = std::path::PathBuf::from(&gate);
    let written = tokio::task::spawn_blocking(move || {
        std::fs::write(&path, b"")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok::<(), std::io::Error>(())
    })
    .await;
    match written {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return Err(error.to_string()),
        Err(error) => return Err(error.to_string()),
    }
    ask_pty(front, "describe", serde_json::json!([id, { "released": true }])).await.map(|_| ()).map_err(crate::plain)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// KI-110: the door is the live writer of a pane's context — the JS host is reached only by
    /// `/api/dashboard-run` and the suite — so a field only the reader computed was a fix with one
    /// arm. The value is the path `runtimeDirectory(host)` names in `runtime/discovery.mjs` and the
    /// one `red-mcp`'s `default_runtime_directory` computes: `<checkout>/.cache/runtime/<instance>`.
    #[test]
    fn the_context_a_pane_is_given_names_the_runtime_directory_its_connector_would_compute() {
        let document = agent_context("http://127.0.0.1:1", &"a".repeat(64), "i", "r");
        let named = document.get("runtimeDirectory").and_then(Value::as_str).expect("a runtime directory");
        assert_eq!(named, checkout().join(".cache/runtime/i").to_string_lossy(), "keyed on the instance the context itself carries");
        /* The checkout is this crate's, which is the one the JS resolves from its own module URL:
           `red/red-host` is two levels down from it. */
        assert_eq!(checkout().join("red/red-host"), std::path::Path::new(env!("CARGO_MANIFEST_DIR")));
        let mut keys: Vec<&str> = document.as_object().expect("an object").keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["instance", "rootId", "runtimeDirectory", "token", "url"],
                   "the shape runtime/supervisor.mjs writes for a pane of its own");
    }
}
