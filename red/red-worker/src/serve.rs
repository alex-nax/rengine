//! The worker's front: what it answers, and what it hands on (F158, spec 129).
//!
//! The same shape the door has, one layer up. `red-host` owns a state directory's port and forwards
//! what it does not own to the JS backend; this owns a ROOT's worker port and forwards what it does
//! not own to the host. A pane's MCP reaches the worker when one is alive and the host otherwise
//! (`red-mcp`'s `runtime()`), so the two must answer alike for everything the worker does not own.
//!
//! **The forwarder is the default, not the exception.** Nineteen of the thirty-two routes
//! `runtime/worker.mjs` serves are already the door's, and they reach it by being passed along
//! unchanged — twenty-one since the desktop registry was settled as the door's (spec 143). What
//! stays here is the pair the worker owns — the ledger and the feed — and the thin routes over
//! crates that already exist.

use red_core::head::Head;

/// The routes this worker answers itself. Everything else is the host's and is forwarded.
///
/// Stated as a table rather than as a chain of `if`s because it IS the decision: a route that
/// belongs to the host and is answered here would answer from a worker's view of a workspace
/// instead of the workspace's own.
pub fn own_route(method: &str, path: &str) -> bool {
    /* The project's own routes. The door answers them too — it is a workspace's front — but they are
       the WORKER's as well, and for a reason the two-way split misses: the host beneath a worker may
       predate them, and one that forwarded would answer from a host that never had them. One
       implementation, `red_project::serve`, called by both. */
    if red_project::serve::owns(method, path) {
        return true;
    }
    matches!(
        (method, path),
        ("GET", "/api/feed")
            | ("GET", "/api/token")
            | ("POST", "/api/token-action")
            | ("GET", "/api/agents-menu")
            | ("POST", "/api/agent-spawn")
            | ("GET", "/api/diagnostics")
            | ("POST", "/api/ide-mention")
            | ("POST", "/api/ide-selection")
            | ("POST", "/api/script-open")
            | ("POST", "/api/update-workspace")
            | ("POST", "/api/task")
            /* The tracker's sign-in, which is the worker's because the grant it writes lives beside
               the workspace state and never in the committed declaration. Answering them needs a
               network client, and the trust roots that client uses are the MACHINE's rather than a
               bundled CA set (F154, `red_core::tls`). */
            | ("POST", "/api/tracker/signin")
            | ("POST", "/api/tracker/signout")
            /* Three the DOOR also answers, and that this worker must compose rather than forward:
               the capabilities and the token window it adds to a state read, the half of a
               preferences write that belongs beside the ledger rather than in the host's store, and
               the desktop's recording frame, which is a feed frame and so is the feed owner's. The
               parity table below skips these as the door's; they are listed here deliberately. */
            | ("GET", "/api/state")
            | ("POST", "/api/preferences")
            | ("POST", "/api/recording")
            /* The desktop registry's own routes. They are the worker's for the same reason every
               route it answers rather than forwards is: the host beneath may have none of them. */
            | ("GET", "/api/desktops")
            | ("POST", "/api/desktop-action")
            | ("GET", "/api/runtime-desktops")
            | ("POST", "/api/session-view")
            /* And the two the door performs and this worker composes AROUND. The launch: the host
               announces the new session before the call returns, so who asked has to be queued
               before the call is made. The board's button: an action is a launch, a device-bound
               pane that bounds a pair on the feed, or an ordinary pane, and none of the three is a
               forward. Both are gated and composed together, which is why neither is in `gated`. */
            | ("POST", "/api/game")
            | ("POST", "/api/dashboard-run")
    )
}

/// What THIS BINARY answers today, which is a moving subset of `own_route`.
///
/// The two are deliberately separate. `own_route` is the contract — the routes that are the
/// worker's, checked against the module it replaces — and it is settled. This is how far the port
/// has got. A route moves from one to the other when it is implemented and its evidence is here,
/// and until then it is forwarded, so a half-ported worker behaves exactly like the whole one.
pub fn implemented(method: &str, path: &str) -> bool {
    /* Everything a PROJECT declares about itself, which the worker answers rather than forwards
       because the host beneath it may predate these routes (spec 065, KI-043). */
    if red_project::serve::owns(method, path) {
        return true;
    }
    matches!(
        (method, path),
        ("GET", "/api/feed")
            | ("GET", "/api/token")
            | ("POST", "/api/token-action")
            | ("GET", "/api/agents-menu")
            | ("POST", "/api/task")
            | ("POST", "/api/agent-spawn")
            | ("POST", "/api/script-open")
            | ("POST", "/api/update-workspace")
            | ("GET", "/api/diagnostics")
            | ("POST", "/api/ide-mention")
            | ("POST", "/api/ide-selection")
            /* Composed rather than owned: the door answers these and this worker adds to the
               answer, so they are answered HERE and the door is asked inside. */
            | ("GET", "/api/state")
            | ("POST", "/api/preferences")
            | ("POST", "/api/recording")
            | ("POST", "/api/game")
            | ("POST", "/api/dashboard-run")
            | ("POST", "/api/tracker/signin")
            | ("POST", "/api/tracker/signout")
            | ("GET", "/api/desktops")
            | ("POST", "/api/desktop-action")
            | ("GET", "/api/runtime-desktops")
            | ("POST", "/api/session-view")
    )
}

/// How a gated route names the project it is about.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Names {
    /// A `rootId` in the body: the caller names the project.
    Root,
    /// An `id` in the body naming a PANE, whose own record says which project it is in. Stopping or
    /// restarting one is about the project it runs in, and only the pane knows which that is — a
    /// caller's claim about it would let an agent gate itself against a project it is not in.
    Session,
}

/// The routes this worker does not own but must not simply hand on: the token GATE.
///
/// A third category, and the one a table of "ours" and "theirs" misses by construction. These are
/// answered by the door — stopping a pane, launching a game, reloading a desktop — and the JS worker
/// intercepts each to ask the ledger first, because the door has no gate of its own and must not
/// grow one (spec 065). A worker that forwarded them unchanged would be a workspace with no
/// arbitration at all, and nothing would look broken.
///
/// The tool name is what a refusal says back, so it is the ledger's vocabulary and not this table's.
pub fn gated(method: &str, path: &str) -> Option<(&'static str, Names)> {
    Some(match (method, path) {
        ("POST", "/api/stop") => ("stop_session", Names::Session),
        ("POST", "/api/agent-restart") => ("restart_agent", Names::Session),
        _ => return None,
    })
}

/// What this worker adds to the host's own capability list.
///
/// A capability is a promise a caller reads before it calls: `red-mcp` refuses a tool by NAME when
/// the workspace does not advertise it, rather than calling a worker that would pass every gate
/// because it has none (spec 078's asymmetry). So the list is composed here — the host says what a
/// HOST can do, and these are what having a worker in front of it adds.
///
/// **The ledger's three ride together.** `agentToken`, `taskWrites` and `agentSpawn` are all
/// token-gated and all announce themselves on the feed, so a worker that serves no ledger can serve
/// none of them and says so by naming none.
///
/// `projectGameLaunch` is the one that is the HOST's to promise and is stripped first: launching a
/// game needs the retained host's PTY and its embedded surface, so a worker may only repeat it when
/// the host underneath actually declared the game half.
pub fn capabilities(from_host: &serde_json::Value, serves_ledger: bool) -> serde_json::Value {
    let held = from_host.as_object().cloned().unwrap_or_default();
    let host_game = held.get("projectGame").and_then(serde_json::Value::as_i64) == Some(1);
    /* Rebuilt without it rather than removed from it. This map preserves insertion order, and a
       remove on one of those SWAPS the last entry into the hole — so taking `projectGameLaunch` out
       moved `tracker` to where it had been, and a caller comparing the answer byte for byte saw a
       different workspace. `{ projectGameLaunch, ...rest }` keeps the rest in order, and this is
       that. */
    let mut out: serde_json::Map<String, serde_json::Value> =
        held.into_iter().filter(|(name, _)| name != "projectGameLaunch").collect();
    for name in ["desktopActions", "layeredUpdates", "scriptActions", "formatRegistry", "dashboard",
                 "projectGame", "recordings", "projectDevices", "tracker", "ide", "agentsMenu"] {
        out.insert(name.to_string(), serde_json::json!(1));
    }
    if serves_ledger {
        for name in ["agentToken", "taskWrites", "agentSpawn"] {
            out.insert(name.to_string(), serde_json::json!(1));
        }
    }
    if host_game {
        out.insert("projectGameLaunch".to_string(), serde_json::json!(1));
    }
    serde_json::Value::Object(out)
}

/// The routes whose gate is INSIDE the route rather than on the way past.
///
/// A third place a gate can live, and the one a table of "gated, then forwarded" misses. These are
/// answered here, so the forwarder never sees them — and each has a reason it cannot be gated
/// generically: a launch has to queue its asker before it calls, a board's button has to know which
/// of three things the action is, and a capture is answered from the project itself.
///
/// It exists so that `own_route` alone never EXCUSES a gate. Adding a route to `own_route` without
/// one is otherwise invisible: the parity test below would see it as the worker's and stop asking.
pub fn gates_internally(method: &str, path: &str) -> Option<&'static str> {
    Some(match (method, path) {
        ("POST", "/api/script-open") => "open_script",
        ("POST", "/api/update-workspace") => "update_workspace",
        ("POST", "/api/task") => "task_",
        ("POST", "/api/agent-spawn") => "spawn_agent",
        ("POST", "/api/game") => "launch_game",
        ("POST", "/api/dashboard-run") => "dashboard_run",
        ("POST", "/api/dashboard-capture") => "dashboard_capture",
        ("POST", "/api/desktop-action") => "reload_desktop",
        _ => return None,
    })
}

/// Why a token action cannot go ahead, in the order the question is asked. `None` means it can.
///
/// The ORDER is the JavaScript's and is load-bearing. A worker with no ledger says so whoever is
/// asking — the fault is the workspace's, not the caller's — and only once there IS a ledger does
/// it matter who is acting on it. Reversing the two would tell a person at a desktop that they had
/// not identified themselves when the real answer is that this worker serves no ledger at all.
pub fn token_refusal(
    has_ledger: bool,
    root: Option<&str>,
    who: Option<&serde_json::Value>,
    desktop: Option<&str>,
    action: Option<&str>,
) -> Option<(u16, &'static str)> {
    if root.is_none_or(str::is_empty) {
        return Some((400, "A project root is required to act on its token."));
    }
    if !has_ledger {
        return Some((409, "This workspace worker does not serve the project token ledger."));
    }
    if who.is_none() && desktop.is_none() {
        return Some((403, "Only an identified agent can act on the token; this request carried no X-Rengine-Agent header."));
    }
    /* A desktop's action is the ledger's to judge — it has more of them than an agent does — so only
       an AGENT's is narrowed here to the three it may take. */
    if desktop.is_none() && !matches!(action, Some("contest" | "reject" | "release")) {
        return Some((400, "Choose contest, reject or release."));
    }
    None
}

/// The sockets a worker serves itself, and the ones it tunnels to the host.
///
/// `/feed` is the worker's own — it is the one thing nothing else can serve. `/events` and
/// `/surface` belong to whoever answers the session routes, so they are tunnelled through: a client
/// that reached the worker for a pane's bytes gets the host's, and never a second opinion.
pub fn own_socket(path: &str) -> bool {
    /* `/events` is TERMINATED here rather than tunnelled, because four of its frames are this
       worker's: a desktop registering, a desktop answering an action, a person acting on the token,
       and a capture the desktop recorded. The host beneath may predate all four (spec 065), and a
       worker that passed them through would answer from a host that never had them. Everything else
       on the socket is forwarded unchanged, which is what "a pane's bytes are never a second
       opinion" actually protects.

       `/surface` carries ONE game's frames and has nothing this worker decides, so it is tunnelled. */
    matches!(path, "/feed" | "/events")
}

/// Is this request for us at all? A worker answers `/api/*`, its own socket, and `/health`; nothing
/// else is a route it has an opinion about, and a path it does not recognise is not forwarded —
/// forwarding an unknown path would make this a proxy for the whole host rather than a worker.
pub fn known(head: &Head) -> bool {
    let path = head.path();
    path.starts_with("/api/") || path == "/health" || (head.upgrade && matches!(path.as_str(), "/feed" | "/events" | "/surface"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_worker_owns_the_ledger_and_the_feed_and_hands_the_rest_on() {
        /* The pair it exists for. */
        assert!(own_route("GET", "/api/feed"));
        assert!(own_route("GET", "/api/token"));
        assert!(own_route("POST", "/api/token-action"));

        /* And the routes the door already answers, which it must NOT: answering them here would
           answer from a worker's view of a workspace rather than the workspace's own. */
        for path in ["/api/stop", "/api/state-not-a-route"] {
            assert!(!own_route("GET", path), "{path} is the door's");
        }
        /* And a project's own, which the door answers AND the worker answers — because the host
           beneath a worker may predate them. Listed here because a reader of the table above would
           otherwise take them for the door's alone. */
        for path in ["/api/dashboard", "/api/devices", "/api/formats", "/api/recordings",
                     "/api/game-config", "/api/tracker", "/api/worktrees", "/api/bytes"] {
            assert!(own_route("GET", path), "{path} is a project's");
            assert!(implemented("GET", path), "and is answered here");
        }
        /* And the three the door answers that this worker COMPOSES: a state read carries what the
           worker adds, a preferences write is split, and the desktop's recording frame is a feed
           frame. Forwarding any of them unchanged loses the half that is the worker's. */
        assert!(own_route("GET", "/api/state"));
        assert!(own_route("POST", "/api/preferences"));
        assert!(own_route("POST", "/api/recording"));
        assert!(own_route("POST", "/api/game"));
        /* `GET /api/recording` reads a recording out of a PROJECT and `POST /api/recording` is the
           desktop's frame, which is the feed's. Both are the worker's and for different reasons,
           which is the whole point of a route being a method and a path together. */
        assert!(red_project::serve::owns("GET", "/api/recording"), "reading one back is the project's");
        assert!(!red_project::serve::owns("POST", "/api/recording"), "and the frame is not");
        /* The desktop registry, settled as the door's: a desktop says it exists on the door's
           socket, so the two routes over that registry are answered where the sockets are. Listed
           separately because they were the worker's in the JavaScript and the reason they are not
           here is a decision (spec 143) rather than an omission. */
        /* The desktop registry, which is the worker's — and was briefly the door's, until deleting
           `worker.mjs` showed what that cost above a host with no desktop routes (spec 143). The
           door keeps its own for a workspace with no worker in front, and the two are one
           implementation (`red_core::desktops`) over two sockets. */
        for path in ["/api/desktops", "/api/runtime-desktops"] {
            assert!(own_route("GET", path), "{path} is the registry's");
        }
        assert!(own_route("POST", "/api/session-view"));
        assert!(own_route("POST", "/api/desktop-action"));
    }

    /* A method is half of a route. `GET /api/recording` reads a recording out of a project and is
       nobody's ledger; `POST /api/recording` is the desktop's frame and mints one — the JS worker
       kept that distinction in its own table and it is kept here. */
    #[test]
    fn a_route_is_a_method_and_a_path_together() {
        assert!(own_route("POST", "/api/token-action"));
        assert!(!own_route("GET", "/api/token-action"), "the action is a POST");
        assert!(own_route("GET", "/api/token"));
        assert!(!own_route("POST", "/api/token"), "the status is a GET");
    }

    /* A capability is a promise a caller reads BEFORE it calls, so what is advertised and what can
       actually be done have to be the same list. The three that ride with the ledger are the case
       that matters: a worker with no ledger that still said `agentToken` would have every tool call
       it and every gate pass, because there is nothing to refuse them. */
    #[test]
    fn the_ledgers_three_are_advertised_together_or_not_at_all() {
        let host = serde_json::json!({ "handoff": 1, "taskConversations": 1 });
        let with = capabilities(&host, true);
        for name in ["agentToken", "taskWrites", "agentSpawn"] {
            assert_eq!(with[name], serde_json::json!(1), "{name}");
        }
        let without = capabilities(&host, false);
        for name in ["agentToken", "taskWrites", "agentSpawn"] {
            assert_eq!(without.get(name), None, "{name} is not promised by a worker that serves no ledger");
        }
        /* And what the worker adds regardless, plus what the host said about itself. */
        assert_eq!(without["agentsMenu"], serde_json::json!(1));
        assert_eq!(without["handoff"], serde_json::json!(1), "the host's own answer is kept");

        /* And in the host's own ORDER. A caller compares this answer byte for byte, and this map
           preserves insertion order — so removing a key rather than rebuilding without it swapped
           the last entry into the hole and quietly described a different workspace. */
        let ordered = capabilities(
            &serde_json::json!({ "a": 1, "projectGameLaunch": 1, "b": 1, "tracker": 1 }),
            false,
        );
        let names: Vec<&String> = ordered.as_object().expect("an object").keys().take(3).collect();
        assert_eq!(names, vec!["a", "b", "tracker"], "the host's keys keep their order, minus the one taken out");
    }

    /* Launching a game needs the retained host's PTY and its embedded surface, so it is the HOST's
       to promise. A worker may repeat it and may never invent it. */
    #[test]
    fn the_game_launch_is_the_hosts_promise_and_is_never_the_workers() {
        let old = capabilities(&serde_json::json!({ "projectGameLaunch": 1 }), true);
        assert_eq!(old.get("projectGameLaunch"), None, "a host that declared no game half launches none");
        let current = capabilities(&serde_json::json!({ "projectGame": 1 }), true);
        assert_eq!(current["projectGameLaunch"], serde_json::json!(1));
        /* `projectGame` itself the worker DOES promise: the preflight is its own, read from the
           declaration, and it answers whether or not the host beneath it can launch anything. */
        assert_eq!(old["projectGame"], serde_json::json!(1));
    }

    /* The gates, against the module they replace. This is the test that finds the blind spot the
       table above has by construction: a route the DOOR answers is skipped there as "not the
       worker's", and six of them are still the worker's to GATE. Forwarding one unchanged is a
       workspace with no arbitration, and nothing about it looks broken. */
    #[test]
    fn every_gate_the_javascript_worker_asked_for_is_asked_for_here() {
        let record = recorded();
        let mut missing = Vec::new();
        for asked in record["gates"].as_array().expect("gates") {
            let (method, path) = (asked["method"].as_str().expect("a method"), asked["path"].as_str().expect("a path"));
            let tool = asked["tool"].as_str().expect("a tool");
            /* A tool spelled with a template literal is the action's, and the tables say so by
               naming the family rather than one action. */
            let names = if asked["namedBy"] == serde_json::json!("session") { Names::Session } else { Names::Root };
            /* A route this worker ANSWERS carries its gate inside itself, and `gates_internally` is
               where that is written down — `own_route` alone must never excuse a gate, or adding a
               route to it would silently stop this test asking about one. */
            if let Some(named) = gates_internally(method, path) {
                assert!(tool.starts_with(named.trim_end_matches('_')), "{method} {path} is gated on {tool} and this table says {named}");
                continue;
            }
            match gated(method, path) {
                Some((named, wanted)) if tool.starts_with(named.trim_end_matches('_')) && wanted == names => {}
                _ => missing.push(format!("{method} {path} is gated on {tool} and this table does not say so")),
            }
        }
        assert!(missing.is_empty(), "{missing:#?}");
        assert_eq!(record["gates"].as_array().expect("gates").len(), 10, "every gate the JavaScript asked for");
    }

    /* Stopping a pane is about the project the PANE is in, and only the pane's record says which —
       a caller's claim about it would let an agent gate itself against a project it is not in. */
    #[test]
    fn a_pane_route_is_gated_on_the_panes_own_project() {
        assert_eq!(gated("POST", "/api/stop"), Some(("stop_session", Names::Session)));
        assert_eq!(gated("POST", "/api/agent-restart"), Some(("restart_agent", Names::Session)));
        /* The launch is gated too, but INSIDE the route: it also has to queue the asker before it
           calls, so it is answered here rather than gated on the way past. `implemented` is what
           keeps the two from both firing. */
        assert_eq!(gated("POST", "/api/game"), None);
        assert!(implemented("POST", "/api/game"));
        assert_eq!(gated("POST", "/api/dashboard-run"), None, "and a board's button, for the same reason");
        assert!(implemented("POST", "/api/dashboard-run"));
        /* Both say where their gate went, so removing one is a visible edit rather than a silence. */
        assert_eq!(gates_internally("POST", "/api/game"), Some("launch_game"));
        assert_eq!(gates_internally("POST", "/api/dashboard-run"), Some("dashboard_run"));
        /* The one project route that WRITES is gated too, and it is the case that found this table:
           answering it here rather than forwarding it dropped its gate, and `own_route` hid that. */
        assert_eq!(gates_internally("POST", "/api/dashboard-capture"), Some("dashboard_capture"));
        assert_eq!(gates_internally("GET", "/api/dashboard"), None, "a read is not gated");

        /* The two tables must not OVERLAP, and the overlap is not harmless: `implemented` is checked
           first, so a route in both has its `gated` entry dead — and a reader fixing the gate would
           edit the half that never runs. `/api/dashboard-capture` was in both, which is how this
           assertion came to exist. */
        for (method, path) in [("POST", "/api/game"), ("POST", "/api/dashboard-run"), ("POST", "/api/dashboard-capture"),
                               ("POST", "/api/stop"), ("POST", "/api/agent-restart"), ("POST", "/api/desktop-action")] {
            let both = gated(method, path).is_some() && gates_internally(method, path).is_some();
            assert!(!both, "{method} {path} is in both gate tables, so one of them is dead");
            assert!(gated(method, path).is_some() || gates_internally(method, path).is_some(), "{method} {path} is gated somewhere");
        }
        /* A read is not gated: the token arbitrates what a caller may CHANGE. */
        assert_eq!(gated("GET", "/api/state"), None);
        assert_eq!(gated("GET", "/api/desktops"), None, "a read is not gated");
        assert_eq!(gated("GET", "/api/stop"), None, "the stop is a POST");
    }

    /// The answers `runtime/worker.mjs` gave on the day it was replaced.
    ///
    /// **Recorded, not read live.** A parity proof cannot outlive the side it compares against
    /// (F173): the module is gone, so what it said is the evidence now, and it is frozen — a record
    /// that moved with the implementation would prove nothing.
    fn recorded() -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|red| red.parent())
            .expect("the checkout")
            .join("orchestrator/tests/worker-routes-fixtures.json");
        serde_json::from_str(&std::fs::read_to_string(&path).expect("the recorded answers")).expect("a record")
    }

    /* The table against the module it replaced. It caught one on its first run: `/api/session-view`
       is a POST and this table said GET. */
    #[test]
    fn the_table_is_what_the_javascript_worker_uniquely_served() {
        let record = recorded();
        let mut missing = Vec::new();
        for route in record["routes"].as_array().expect("routes") {
            let (method, path) = (route["method"].as_str().expect("a method"), route["path"].as_str().expect("a path"));
            /* A route the door already answers is not the worker's, however the worker spelled it —
               except for the handful this worker COMPOSES, which `own_route` lists deliberately. */
            if route["alsoTheDoors"] == serde_json::json!(true) && !own_route(method, path) {
                continue;
            }
            if !own_route(method, path) {
                missing.push(format!("{method} {path}"));
            }
        }
        assert!(missing.is_empty(), "the JavaScript worker served these and this table does not: {missing:?}");
        assert!(record["routes"].as_array().expect("routes").len() >= 30, "the record is the whole dispatcher, not a sample");
    }

    /* The refusal order, which is the JavaScript's and is load-bearing: reversing the ledger and
       the identity would tell a person at a desktop they had not identified themselves when the
       real answer is that this worker serves no ledger at all. */
    #[test]
    fn a_token_action_is_refused_in_the_order_the_question_is_asked() {
        let who = serde_json::json!({ "agentId": "12345678-1234-1234-1234-123456789abc" });

        /* A root first: everything below is about a root's token. */
        assert_eq!(token_refusal(true, None, Some(&who), None, Some("contest")).map(|(code, _)| code), Some(400));
        assert_eq!(token_refusal(true, Some(""), Some(&who), None, Some("contest")).map(|(code, _)| code), Some(400));

        /* Then the ledger, WHOEVER is asking — including nobody, which is the ordering itself. */
        assert_eq!(token_refusal(false, Some("r"), Some(&who), None, Some("contest")).map(|(code, _)| code), Some(409));
        assert_eq!(token_refusal(false, Some("r"), None, None, None).map(|(code, _)| code), Some(409),
                   "a worker with no ledger says so before it asks who is calling");

        /* Then who: an unidentified caller is told which header names it. */
        let (code, message) = token_refusal(true, Some("r"), None, None, Some("contest")).expect("refused");
        assert_eq!(code, 403);
        assert!(message.contains("X-Rengine-Agent"), "{message}");

        /* Then what: an agent may take three actions and is told which. */
        assert_eq!(token_refusal(true, Some("r"), Some(&who), None, Some("abscond")), Some((400, "Choose contest, reject or release.")));
        assert_eq!(token_refusal(true, Some("r"), Some(&who), None, None).map(|(code, _)| code), Some(400));
        for action in ["contest", "reject", "release"] {
            assert_eq!(token_refusal(true, Some("r"), Some(&who), None, Some(action)), None, "{action} is one an agent may take");
        }

        /* A DESKTOP's action is the ledger's to judge — it has more of them than an agent does — so
           it is not narrowed here, and a desktop needs no agent header. */
        assert_eq!(token_refusal(true, Some("r"), None, Some("desk-1"), Some("settle")), None);
    }

    #[test]
    fn the_sockets_with_something_on_them_are_served_and_the_rest_are_tunnelled() {
        assert!(own_socket("/feed"), "the one thing nothing else can serve");
        /* Four of `/events`' frames are this worker's, and the host beneath may predate all four. */
        assert!(own_socket("/events"));
        assert!(!own_socket("/surface"), "a game's frames are whoever answers the session routes'");
    }

    /* The port's own progress, and the property that makes it safe to be half-done: everything
       implemented is owned, so a route can never be answered here that the worker does not own. */
    #[test]
    fn everything_implemented_is_owned() {
        for (method, path) in [("GET", "/api/feed"), ("GET", "/api/token"), ("POST", "/api/token-action"),
                               ("POST", "/api/task"), ("GET", "/api/state"), ("POST", "/api/tracker/signin")] {
            if implemented(method, path) {
                assert!(own_route(method, path), "{method} {path} is answered here but is not the worker's");
            }
        }
        assert!(implemented("GET", "/api/feed"), "the feed is the one it exists for, so it is first");
    }

    #[test]
    fn a_path_this_worker_has_no_opinion_about_is_not_forwarded() {
        let head = |method: &str, target: &str, upgrade: bool| Head {
            raw: format!("{method} {target} HTTP/1.1"),
            method: method.to_string(),
            target: target.to_string(),
            headers: Vec::new(),
            upgrade,
        };
        assert!(known(&head("GET", "/api/state", false)));
        assert!(known(&head("GET", "/health", false)));
        assert!(known(&head("GET", "/feed?rootId=x", true)));
        assert!(known(&head("GET", "/events", true)));
        /* Not a proxy for the whole host: a path that is not a route is refused here. */
        assert!(!known(&head("GET", "/", false)));
        assert!(!known(&head("GET", "/index.html", false)));
        assert!(!known(&head("GET", "/feed", false)), "the feed is a socket, not a page");
    }
}
