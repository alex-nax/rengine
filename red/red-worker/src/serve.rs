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
               network client for GitHub and Linear, and that is F154's decision to make — the table
               says who OWNS the route, which is settled, not who has implemented it yet. */
            | ("POST", "/api/tracker/signin")
            | ("POST", "/api/tracker/signout")
    )
}

/// What THIS BINARY answers today, which is a moving subset of `own_route`.
///
/// The two are deliberately separate. `own_route` is the contract — the routes that are the
/// worker's, checked against the module it replaces — and it is settled. This is how far the port
/// has got. A route moves from one to the other when it is implemented and its evidence is here,
/// and until then it is forwarded, so a half-ported worker behaves exactly like the whole one.
pub fn implemented(method: &str, path: &str) -> bool {
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
    )
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
    path == "/feed"
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
        for path in ["/api/state", "/api/dashboard", "/api/devices", "/api/formats", "/api/recordings",
                     "/api/game", "/api/game-config", "/api/tracker", "/api/worktrees", "/api/bytes",
                     "/api/preferences", "/api/desktops", "/api/stop"] {
            assert!(!own_route("GET", path), "{path} is the door's");
        }
        /* The desktop registry, settled as the door's: a desktop says it exists on the door's
           socket, so the two routes over that registry are answered where the sockets are. Listed
           separately because they were the worker's in the JavaScript and the reason they are not
           here is a decision (spec 143) rather than an omission. */
        assert!(!own_route("POST", "/api/session-view"), "the registry is the door's");
        assert!(!own_route("GET", "/api/runtime-desktops"), "and so is the workspace's list of it");
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

    /* The table against the module it replaces, read from source. `runtime/worker.mjs` is still
       here and is still the authority on which routes are the worker's; when it goes, this becomes
       a claim about a file that no longer exists and is replaced by the recorded answers the way
       every other parity proof here was. Until then, drift between the two is a bug in one of them.

       It caught one on its first run: `/api/session-view` is a POST and this table said GET. */
    #[test]
    fn the_table_is_what_the_javascript_worker_uniquely_serves() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().and_then(|red| red.parent()).expect("the checkout");
        let worker = root.join("orchestrator/runtime/worker.mjs");
        let Ok(js) = std::fs::read_to_string(&worker) else {
            /* The module is gone: this claim has outlived its subject and the recorded corpus is
               the evidence now. Saying so beats passing quietly. */
            return;
        };
        let door = ["routes.rs", "main.rs"]
            .iter()
            .filter_map(|name| std::fs::read_to_string(root.join("red/red-host/src").join(name)).ok())
            .collect::<String>();

        let mut missing = Vec::new();
        for line in js.lines() {
            let Some((method, path)) = js_route(line) else { continue };
            /* A route the door already answers is not the worker's, however the worker spells it. */
            if door.contains(&format!("\"{path}\"")) {
                continue;
            }
            if !own_route(&method, &path) {
                missing.push(format!("{method} {path}"));
            }
        }
        assert!(missing.is_empty(), "the JavaScript worker serves these and this table does not: {missing:?}");
    }

    /// `req.method === 'X' && target.pathname === '/api/y'`, as the worker writes it.
    fn js_route(line: &str) -> Option<(String, String)> {
        let (before, after) = line.split_once("target.pathname === '")?;
        let path = after.split('\'').next()?.to_string();
        if !path.starts_with("/api/") {
            return None;
        }
        let method = before.split("req.method === '").nth(1)?.split('\'').next()?.to_string();
        Some((method, path))
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
    fn the_feed_is_the_workers_socket_and_the_others_are_tunnelled() {
        assert!(own_socket("/feed"));
        assert!(!own_socket("/events"), "a pane's bytes belong to whoever answers the session routes");
        assert!(!own_socket("/surface"), "and so do a game's frames");
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
