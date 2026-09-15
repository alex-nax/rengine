//! Which route the door answers itself, and how it answers (F189, spec 129).
//!
//! A route is here when this process can answer it from something it owns — the state directory's
//! store (D61), the PTY service and the pane records it holds (D60/D62), the socket and the
//! desktops on it. Everything else is forwarded to the JS backend, and the two tables at the top of
//! this file are the whole of that decision.
//!
//! The answers are the JS host's, down to the status of a refusal and the shape of a body, because
//! a client cannot tell which host it reached and must not have to.

use std::sync::Arc;

use red_core::head::Head;
use crate::panes::{deliver_input, deliver_resize, pane_answer, pane_snapshot};
use crate::{ask, ask_pty, Front};

/// The store routes this door answers itself, and the method each one is on the store service.
/// Everything about the answer is the store's: the shapes are the ones `store.mjs` wrote and
/// red-store replays byte for byte (F169), so a client cannot tell which host asked.
pub(crate) fn store_route(method: &str, path: &str) -> Option<&'static str> {
    Some(match (method, path) {
        ("GET", "/api/tree") => "list",
        ("GET", "/api/file") => "readText",
        ("POST", "/api/roots") => "addRoot",
        ("POST", "/api/save") => "saveText",
        ("POST", "/api/draft") => "putDraft",
        ("POST", "/api/discard") => "discardDraft",
        ("POST", "/api/layout") => "saveLayout",
        ("POST", "/api/preferences") => "preferences",
        _ => return None,
    })
}

/// What a project declares about itself and what it leaves behind (F153, F155, F156): the
/// declaration and its formats, the recordings the desktop's recorder committed, the devices it
/// declares and whether each answers, which of its dashboard actions may be pressed, a game's
/// preflight, and its own task inventory.
///
/// These read a project ROOT rather than the workspace's own state, and the answer is
/// `red_project::serve`'s — the one implementation, which the WORKER also calls, because the host
/// beneath a worker may predate these routes and a worker that forwarded them would answer from a
/// host that never had them (spec 065, spec 143). What is here is only how this door finds the root
/// and where it keeps its probe cache.
///
/// `/api/tracker` is the exception, and it says so by forwarding: only the LOCAL backend is Rust,
/// because the remote providers need a network client and F154 owns that decision.
/// `None` means "not this door's after all" — the caller falls through to the forwarder.
pub(crate) async fn answer_about_project(front: &Arc<Front>, path: &str, head: &Head, body: &str) -> Option<String> {
    /* A POST's body, parsed before anything else: `/api/format-preview` and
       `/api/dashboard-capture` are asked with a JSON document, and the root is named IN it rather
       than in a query string — which is where `main.mjs` read it from too. */
    let data: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let root_id = head
        .query("rootId")
        .or_else(|| data.get("rootId").and_then(serde_json::Value::as_str).map(str::to_string))
        .unwrap_or_default();
    let root = match ask(front, "root", serde_json::json!([root_id])).await {
        Ok(root) => root,
        Err(fault) => return Some(faulted(&fault)),
    };
    let root_path = root.get("path").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let id = root.get("id").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let declaration_file = root.get("declarationFile").and_then(serde_json::Value::as_str).map(str::to_string);
    /* A remote tracker is answered here too (F154): the credential lives beside THIS door's state
       directory, which is the one thing about it the project itself cannot know. Read before the
       blocking half starts, because it decides which answer this is. */
    let remote = path == "/api/tracker" && !red_project::serve::local_tracker(&root_path, declaration_file.as_deref());
    /* Everything the blocking half needs, taken before it starts: a task that outlives this call
       cannot borrow the request it came from. */
    let path = path.to_string();
    let asked: std::collections::HashMap<String, String> =
        ["limit", "id", "artifact", "offset", "maxCharacters", "refresh", "gameId", "path", "length"]
            .into_iter()
            .filter_map(|name| head.query(name).map(|value| (name.to_string(), value)))
            .collect();
    /* `/api/bytes` alone read its query as an OBJECT, where a repeated key keeps its last value. */
    let last: std::collections::HashMap<String, String> = ["offset", "length", "path"]
        .into_iter()
        .filter_map(|name| head.query_last(name).map(|value| (name.to_string(), value)))
        .collect();
    let front = front.clone();
    let state = front.state.clone();
    let answer = tokio::task::spawn_blocking(move || {
        /* This process's own environment, which is what every one of these is answered against —
           including the `tools` half of an availability check. A route that RUNS a project's command
           gets the shell environment composed at the spawn, in `red_project::command`, so the board
           and the run read one PATH. */
        let environment: Vec<(String, String)> = std::env::vars().collect();
        if remote {
            return Ok(remote_tracker(&front, &state, &id, &root_path, declaration_file.as_deref(), asked.contains_key("refresh")));
        }
        red_project::serve::route(&red_project::serve::Asked {
            root_id: &id,
            root_path: &root_path,
            declaration_file: declaration_file.as_deref(),
            path: &path,
            data: &data,
            query: &|name: &str| asked.get(name).cloned(),
            query_last: &|name: &str| last.get(name).cloned(),
            environment: &environment,
            /* The door is the longer-lived of the two servers that answer these, so the probe cache
               it keeps is the same optimisation with a longer life: one listing costs one probe per
               device, not one per action. */
            probes: &front.probes,
        })
    })
    .await;
    Some(match answer {
        Ok(Ok(value)) => http_json(200, "OK", &value),
        Ok(Err(fail)) => faulted(&refusal(fail)),
        Err(error) => faulted(&format!("500|{error}")),
    })
}
/// The session routes this door answers itself. They are here rather than forwarded because the
/// pane's record is the service's now (charter D62): the refusals below are the JS host's, applied
/// to the same record the JS host applies them to, so the two cannot disagree about whether a pane
/// accepts input.
pub(crate) fn session_route(method: &str, path: &str) -> Option<&'static str> {
    Some(match (method, path) {
        ("GET", "/api/session") => "snapshot",
        ("POST", "/api/input") => "input",
        ("POST", "/api/resize") => "resize",
        ("POST", "/api/stop") => "stop",
        _ => return None,
    })
}

/// One store route, answered from the state directory's own store.
///
/// The arguments are the JS host's: `/api/tree` takes its root, path and hidden flag from the query
/// string, and every POST hands the store the body it was given. Nothing is reshaped on the way in
/// or out — the store's answers are the ones `store.mjs` wrote, so a client cannot tell which host
/// asked.
pub(crate) fn answer_from_store(front: &Front, method: &str, head: &Head, body: &str) -> String {
    let Some(client) = front.store.as_ref() else {
        return http_json(503, "Service Unavailable", &serde_json::json!({ "error": "This workspace's store is not attached." }));
    };
    let payload: serde_json::Value = if body.is_empty() {
        serde_json::Value::Null
    } else {
        match serde_json::from_str(body) {
            Ok(value) => value,
            Err(error) => return http_json(400, "Bad Request", &serde_json::json!({ "error": format!("Invalid JSON body: {error}") })),
        }
    };
    let args = match method {
        "list" => serde_json::json!([
            head.query("rootId").unwrap_or_default(),
            head.query("path").unwrap_or_default(),
            head.query("hidden").as_deref() == Some("true"),
        ]),
        "readText" => serde_json::json!([head.query("rootId").unwrap_or_default(), head.query("path").unwrap_or_default()]),
        "addRoot" => serde_json::json!([
            payload.get("path").cloned().unwrap_or(serde_json::Value::Null),
            payload.get("declarationFile").cloned().unwrap_or(serde_json::Value::Null),
        ]),
        "discardDraft" => serde_json::json!([
            payload.get("rootId").cloned().unwrap_or(serde_json::Value::Null),
            payload.get("path").cloned().unwrap_or(serde_json::Value::Null),
        ]),
        "saveLayout" => serde_json::json!([payload.get("layout").cloned().unwrap_or(serde_json::Value::Null)]),
        _ => serde_json::json!([payload]),
    };
    match client.call(method, args) {
        Ok(result) => {
            /* Two routes answer `{ok: true}` rather than what the store returned, because that is
               what the JS host answers and a caller checks. */
            let value = match method {
                "discardDraft" | "saveLayout" => serde_json::json!({ "ok": true }),
                _ => result,
            };
            http_json(200, "OK", &value)
        }
        Err(fault) => {
            /* The store's refusals carry their own status, and a client acts on it: 404 for a root
               that is not there, 409 for a save against a version that moved. */
            let (status, message) = fault.split_once('|').unwrap_or(("500", fault.as_str()));
            let code: u16 = status.parse().unwrap_or(500);
            http_json(code, reason(code), &serde_json::json!({ "error": message }))
        }
    }
}

/// `/api/input` and `/api/resize`, in the JS host's own order of refusals — the order matters,
/// because `input` names an unknown session before it judges the data and `resize` judges the
/// dimensions before it looks the session up, and a caller sees a different status if they swap.
pub(crate) async fn answer_about_pane(front: &Arc<Front>, method: &str, head: &Head, body: &str) -> String {
    let refusal = |status: u16, message: &str| http_json(status, reason(status), &serde_json::json!({ "error": message }));
    if front.pty.is_none() {
        return refusal(503, "This workspace's sessions are not attached.");
    }
    /* The two routes that ASK rather than decide. The record cache answers the refusals below
       because they have to be decided before anything is delivered; a snapshot is a different
       thing — its scrollback is current as of the question, and the only current copy is the
       service's. */
    if method == "snapshot" || method == "stop" {
        let id = if method == "snapshot" {
            head.query("id").unwrap_or_default()
        } else {
            match serde_json::from_str::<serde_json::Value>(body) {
                Ok(payload) => payload.get("id").and_then(|value| value.as_str()).unwrap_or_default().to_string(),
                Err(error) => return refusal(400, &format!("Invalid JSON body: {error}")),
            }
        };
        return match ask_pty(front, method, serde_json::json!([id])).await {
            /* `/api/session` carries the scrollback and `/api/stop` does not, because the JS host's
               `snapshot(id, true)` and its `stop`'s plain `snapshot(id)` differ in exactly that. */
            Ok(session) => http_text(200, "OK", &pane_answer(&session, method == "snapshot")),
            Err(fault) => faulted(&fault),
        };
    }
    let payload: serde_json::Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(error) => return refusal(400, &format!("Invalid JSON body: {error}")),
    };
    if !payload.is_object() {
        return refusal(400, "Expected an object.");
    }
    let outcome = match method {
        "input" => deliver_input(front, &payload).await,
        _ => deliver_resize(front, &payload).await,
    };
    match outcome {
        /* Both routes answer `{ok: true}`, which is the JS host's answer and not the service's. */
        Ok(()) => http_json(200, "OK", &serde_json::json!({ "ok": true })),
        Err(fault) => faulted(&fault),
    }
}

/// `/api/state` — the route the desktop polls, and the one that names this host. Everything in it
/// is something this process now has: the store's own state (D61), the panes the service is holding
/// (D60/D62), and this door's identity.
///
/// `stateDir` and `pid` are said out loud for a worker above this host, so it can find a credential
/// and name the process a pane descends from without the process table (specs 101/102). They are
/// THIS process's now, which is the honest answer: the door is the host a client is talking to.
pub(crate) fn answer_state(front: &Arc<Front>) -> String {
    let store = front.store.as_ref().and_then(|client| client.state()).unwrap_or_else(|| serde_json::json!({}));
    let field = |name: &str| store.get(name).cloned();
    /* A draft's TEXT is not in this answer — it never was. The list says which files have one and
       when, and the text arrives with the file it belongs to. */
    let drafts: Vec<serde_json::Value> = field("drafts")
        .and_then(|value| value.as_object().cloned())
        .map(|held| {
            held.values()
                .map(|draft| serde_json::json!({
                    "rootId": draft.get("rootId").cloned().unwrap_or(serde_json::Value::Null),
                    "path": draft.get("path").cloned().unwrap_or(serde_json::Value::Null),
                    "updatedAt": draft.get("updatedAt").cloned().unwrap_or(serde_json::Value::Null),
                }))
                .collect()
        })
        .unwrap_or_default();
    let mut held: Vec<serde_json::Value> = front.panes.lock().expect("panes lock").values().cloned().collect();
    /* Oldest first. The JS host answers in the order it learned about its panes, which for a host
       that started them is creation order; a door that adopted them from the service has no such
       history, and the pane's own `createdAt` is the one order both can agree on. */
    held.sort_by_key(|session| {
        (
            session.get("meta").and_then(|record| record.get("createdAt")).and_then(serde_json::Value::as_i64).unwrap_or(0),
            /* Two panes started in the same millisecond need SOME order, and it has to be the same
               order every time this is asked: the id is the only thing left that is theirs. */
            session.get("id").and_then(serde_json::Value::as_str).unwrap_or_default().to_string(),
        )
    });
    let sessions: Vec<serde_json::Value> = held.iter().map(pane_snapshot).collect();
    http_json(200, "OK", &serde_json::json!({
        "instance": front.instance,
        "stateDir": front.state,
        "pid": std::process::id(),
        /* The same list the JS host publishes, because a client reads it to decide what it may ask
           for; a door that claimed less would turn features off in a desktop that has them. */
        "capabilities": {
            "taskConversations": 1, "handoff": 1, "desktopActions": 1, "formatRegistry": 1,
            "dashboard": 1, "projectGame": 1, "projectGameLaunch": 1, "recordings": 1,
            "projectDevices": 1, "externalDeclarations": 1, "agentConversations": 1, "tracker": 1,
        },
        "roots": field("roots").unwrap_or_else(|| serde_json::json!([])),
        "layout": field("layout").unwrap_or(serde_json::Value::Null),
        "preferences": field("preferences").unwrap_or_else(|| serde_json::json!({})),
        "conversations": field("conversations").unwrap_or_else(|| serde_json::json!({})),
        "drafts": drafts,
        "sessions": sessions,
    }))
}

/// `/api/desktop-action`: the only action the JS host takes here is a reload, and an unknown one is
/// refused by name rather than passed to a desktop that would not understand it.
pub(crate) async fn answer_desktop_action(front: &Arc<Front>, body: &str) -> String {
    let payload: serde_json::Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(error) => return faulted(&format!("400|Invalid JSON body: {error}")),
    };
    if payload.get("action").and_then(serde_json::Value::as_str) != Some("reload") {
        return faulted("400|Unknown desktop action.");
    }
    let root = payload.get("rootId").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let desktop = payload.get("desktopId").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    if let Err(fault) = ask(front, "root", serde_json::json!([root])).await {
        return faulted(&fault);
    }
    /* Blocking: the answer comes from the socket's reader, so a door on an async runtime hands it
       to a thread rather than parking a worker for as long as a desktop takes to answer. */
    let acting = front.clone();
    let asked = tokio::task::spawn_blocking(move || {
        acting.desktops.act(&root, &desktop, "reload", serde_json::Value::Null, &crate::uuid_v4)
    })
    .await;
    match asked.unwrap_or_else(|error| Err(format!("500|{error}"))) {
        Ok(value) => http_json(200, "OK", &value),
        Err(fault) => faulted(&fault),
    }
}

/// `POST /api/session-view`: show a retained pane in a named desktop's own tab.
///
/// The registry is the door's because a desktop says it exists on the door's socket, and this is
/// the route that follows from that: the caller names a session and a desktop, and what travels to
/// the desktop is the pane RECORD, so it can draw a tab without asking anything back.
///
/// **Accepted does not mean drawn**, the same way a reload's is: the answer says the desktop took
/// the request. A caller that got a refusal is told the pane is running and retained — nothing here
/// ever starts one, so there is never anything to retry.
pub(crate) async fn answer_session_view(front: &Arc<Front>, body: &str) -> String {
    let payload: serde_json::Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(error) => return faulted(&format!("400|Invalid JSON body: {error}")),
    };
    let field = |name: &str| payload.get(name).and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let (root, desktop, id) = (field("rootId"), field("desktopId"), field("id"));
    let session = match pane_snapshot_of(front, &id).await {
        Ok(session) => session,
        Err(fault) => return faulted(&fault),
    };
    /* The pane's own root, not the caller's claim about it: a desktop bound to one project must
       never be handed another's pane, and only the record knows which it is. */
    if session.get("rootId").and_then(serde_json::Value::as_str) != Some(root.as_str()) {
        return faulted("403|Session belongs to another root.");
    }
    let acting = front.clone();
    let asked = tokio::task::spawn_blocking(move || {
        acting.desktops.act(&root, &desktop, "attach-session", serde_json::json!({ "session": session }), &crate::uuid_v4)
    })
    .await;
    match asked.unwrap_or_else(|error| Err(format!("500|{error}"))) {
        Ok(value) => http_json(200, "OK", &value),
        Err(fault) => faulted(&fault),
    }
}

/// A tracker somebody else's server holds (F154, spec 083).
///
/// The credential lives beside the WORKSPACE state and never in the committed declaration, keyed by
/// the declared project NAME — so a person can create it by name, and a checkout that moved or was
/// re-added keeps its tracker.
fn remote_tracker(
    front: &Arc<Front>,
    state_directory: &str,
    root_id: &str,
    root_path: &str,
    declaration_file: Option<&str>,
    refresh: bool,
) -> serde_json::Value {
    let declared = red_project::declaration::read(root_path, declaration_file);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0);
    let identity = declared
        .get("project")
        .and_then(serde_json::Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or(root_id)
        .to_string();
    /* A signed-in grant is refreshed before it lapses; a pasted personal key never expires and is
       handed back untouched. */
    let grant = red_project::tracker_auth::stored(state_directory, &identity).map(|grant| {
        if red_project::tracker_auth::expiring(&grant, now) {
            red_project::tracker_auth::refresh(state_directory, &identity, &grant, now)
        } else {
            grant
        }
    });
    let token = grant.as_ref().and_then(|grant| grant.get("accessToken").and_then(serde_json::Value::as_str).map(str::to_string));
    red_project::tracker::remote_tracker(
        root_id,
        root_path,
        &declared,
        token.as_deref(),
        &red_project::tracker_remote::Network,
        &front.trackers,
        refresh,
        now,
    )
}

/// One retained pane as a caller reads it, or the service's refusal.
async fn pane_snapshot_of(front: &Arc<Front>, id: &str) -> Result<serde_json::Value, String> {
    let session = crate::ask_pty(front, "snapshot", serde_json::json!([id])).await?;
    Ok(pane_snapshot(&session))
}

/* A refusal's HTTP status, and 500 where it carries none.
   `main.mjs` read `error.status ?? (error.code === 'ENOENT' ? 404 : 500)` — but a store refusal
   reaching a route had already crossed the store service, and `store-client` rebuilds the error from
   `{ message, status }` alone, so `code` was gone and the 404 arm never fired for one. A module-level
   refusal keeps the absent status the JS module raised; turning it into a number is the ROUTE's rule,
   and it belongs here rather than in the answer. */
pub(crate) fn refusal(fail: red_project::recordings::Fail) -> String {
    format!("{}|{}", fail.status.unwrap_or(500), fail.message)
}

/// A service's refusal, or one of this door's own, as the HTTP answer a client acts on.
pub(crate) fn faulted(fault: &str) -> String {
    let (status, message) = fault.split_once('|').unwrap_or(("500", fault));
    let code: u16 = status.parse().unwrap_or(500);
    http_json(code, reason(code), &serde_json::json!({ "error": message }))
}

pub(crate) fn reason(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    }
}

pub(crate) fn http_json(status: u16, reason: &str, value: &serde_json::Value) -> String {
    http_text(status, reason, &value.to_string())
}

pub(crate) fn http_text(status: u16, reason: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}