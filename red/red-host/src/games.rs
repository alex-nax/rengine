//! Launching a declared game (F155, spec 142): `server/games.mjs`'s decisions in Rust.
//!
//! The preflight — what a declared game needs before it can run — is `red_project::games`'s and
//! already answers `/api/game-config` from this door. What is here is the part that needed the
//! session host's process state: **which launch is this, and may it happen.**
//!
//! Four refusals, and each exists because the alternative is worse than saying no:
//!
//! - **Undeclared, or refused by its own preflight.** A game bound to another machine is never
//!   resolved against this filesystem (spec 082), so the refusal comes from the preflight whole.
//! - **Already running with different arguments.** Not silently attached with the caller's
//!   arguments dropped: a person who asked for `-windowed` and got the running full-screen one
//!   would have no way to tell. The refusal names both argument lists.
//! - **Not ready.** Checked AFTER the already-running test, deliberately: a game that is running is
//!   a game that started, and re-reporting a preflight issue about it would be answering a question
//!   nobody asked.
//! - **Extra arguments that are not literal.** `${…}` in an appended argument is a placeholder the
//!   record's own arguments may use and a caller's may not, because a caller's are not the record's.
//!
//! And one piece of bookkeeping that is not a refusal: an identical concurrent launch **joins** the
//! one in flight rather than starting a second process. The key is the root AND the declared game,
//! so two games in one project launch side by side.

use serde_json::{json, Value};

/// The surfaces that stream into a workspace pane. `red_project::rules` holds the same set for the
/// rule that refuses a pane game bound to another machine; they move together.
const PANE_SURFACES: [&str; 2] = ["embedded", "cooperative"];

pub fn streams_into_pane(surface: &str) -> bool {
    PANE_SURFACES.contains(&surface)
}

/// A refusal, with the status the JS host answered it with.
#[derive(Debug, Clone, PartialEq)]
pub struct Refused {
    pub message: String,
    pub status: u16,
}

fn refuse(message: impl Into<String>, status: u16) -> Refused {
    Refused { message: message.into(), status }
}

/// Literal argv a caller appends to the record's own, held to the record's own rules.
///
/// A placeholder is refused rather than expanded: `${…}` is a thing the DECLARATION may contain and
/// a caller may not, because expanding a caller's placeholder would let it reach whatever the
/// declaration's expansion reaches.
pub fn extra_arguments(args: Option<&Value>) -> Result<Vec<String>, Refused> {
    let Some(args) = args.filter(|value| !value.is_null()) else { return Ok(Vec::new()) };
    let listed = args
        .as_array()
        .filter(|items| items.len() <= 64)
        .ok_or_else(|| refuse("Extra launch arguments must be a list of at most 64 literal arguments.", 400))?;
    let mut extra = Vec::with_capacity(listed.len());
    for value in listed {
        let bad = |value: &Value| {
            refuse(
                format!(
                    "Extra launch argument {} must be a literal argument without ${{…}}.",
                    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
                ),
                400,
            )
        };
        let Some(text) = value.as_str() else { return Err(bad(value)) };
        if text.is_empty() || text.len() > 4096 || text.contains("${") || text.contains('\0') {
            return Err(bad(value));
        }
        extra.push(text.to_string());
    }
    Ok(extra)
}

/// What a launch should do, once the preflight has answered and the running panes are known.
#[derive(Debug, PartialEq)]
pub enum Launch {
    /// This game is already running on exactly these arguments: that pane IS the answer.
    Running(String),
    /// Start it, with these arguments and — when its surface streams into a pane — a reservation.
    Start { argv: Vec<String>, reserve: bool, inject_adapter: bool },
}

/// What rEngine composed for a pane, which the service keeps under `meta`.
fn meta<'a>(pane: &'a Value, key: &str) -> Option<&'a Value> {
    pane.get("meta").and_then(|meta| meta.get(key)).filter(|value| !value.is_null())
}

/// One running game pane, as much of it as this decision needs.
pub struct Pane<'a> {
    pub id: &'a str,
    pub root_id: &'a str,
    pub game: &'a str,
    pub args: Vec<String>,
}

/// The whole of the launch decision, kept apart from the spawning so it can be stated as a table.
///
/// `config` is the preflight's answer; `running` is every game pane the workspace holds. The order
/// of the checks is the JavaScript's and is load-bearing — see the module note on "not ready".
pub fn decide(config: &Value, extra: Vec<String>, running: &[Pane<'_>]) -> Result<Launch, Refused> {
    let text = |key: &str| config.get(key).and_then(Value::as_str).unwrap_or("");
    let issues = || {
        config
            .get("issues")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n"))
            .unwrap_or_default()
    };
    if !config.get("declared").and_then(Value::as_bool).unwrap_or(false) {
        return Err(refuse(issues(), 409));
    }
    /* A direct caller reaches the same refusal the worker issues first. */
    if let Some(refusal) = config.get("refusal").and_then(Value::as_str).filter(|value| !value.is_empty()) {
        return Err(refuse(refusal, 409));
    }
    let mut argv: Vec<String> = config
        .get("args")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    argv.extend(extra);

    let (root_id, game) = (text("rootId"), text("id"));
    if let Some(existing) = running.iter().find(|pane| pane.root_id == root_id && pane.game == game) {
        if existing.args != argv {
            return Err(refuse(
                format!(
                    "{} is already running with different arguments ({}); stop it in Sessions before launching it with {}.",
                    text("title"),
                    existing.args.join(" "),
                    argv.join(" ")
                ),
                409,
            ));
        }
        return Ok(Launch::Running(existing.id.to_string()));
    }
    /* After the already-running test, deliberately: a game that is running is a game that started. */
    if !config.get("ready").and_then(Value::as_bool).unwrap_or(false) {
        return Err(refuse(issues(), 409));
    }
    let surface = text("surface");
    Ok(Launch::Start {
        argv,
        reserve: streams_into_pane(surface),
        /* The one difference between the two pane surfaces, and it is deliberately a difference in
           the environment rather than a flag: a cooperative game connects itself, so injecting the
           adapter as well would put two producers on one token. */
        inject_adapter: surface == "embedded",
    })
}

/// The environment a game with a pane surface is launched in: the record's own, the two variables
/// that name the reservation, and — for an `embedded` surface only — the adapter to inject.
///
/// Composed here rather than inline so it can be stated: on macOS dyld purges `DYLD_*` before a
/// protected interpreter can report its own environment, so the CHILD cannot be asked what it was
/// given and the composition is the only place this claim can be made. A cooperative game
/// connecting itself while an injected adapter also connects would put two producers on one token,
/// and the survivor of that is a restart race.
pub fn surface_environment(
    declared: &Value,
    config: &Value,
    variables: &[(String, String)],
    inject_adapter: bool,
    inherited: Option<&str>,
) -> Value {
    let mut environment = declared.as_object().cloned().unwrap_or_default();
    for (name, value) in variables {
        environment.insert(name.clone(), json!(value));
    }
    if inject_adapter {
        let adapter = config.get("adapter").and_then(Value::as_str).unwrap_or_default();
        /* Ahead of whatever this process already carries, and never replacing it: a workspace
           started under an injection of its own keeps it. */
        let joined = match inherited.filter(|value| !value.is_empty()) {
            Some(existing) => format!("{adapter}:{existing}"),
            None => adapter.to_string(),
        };
        environment.insert("DYLD_INSERT_LIBRARIES".to_string(), json!(joined));
    }
    Value::Object(environment)
}

/// The launch key: the root AND the declared game, so two games in one project launch side by side
/// and two callers asking for the same one join instead of starting two processes.
pub fn flight_key(config: &Value) -> String {
    let text = |key: &str| config.get(key).and_then(Value::as_str).unwrap_or("");
    format!("{}\0{}", text("rootId"), text("id"))
}

/* ---- the route ------------------------------------------------------------------------------ */

use std::sync::Arc;

use crate::routes::{faulted, http_text, refusal};
use crate::{ask, Front};

/// `POST /api/game`: launch a declared game, or answer the pane already running it.
///
/// The preflight is `red_project::games`'s, the verdict is `decide`'s, the spawn is `panes`'s, and
/// the reservation is `surfaces`'s — this function is the order those happen in and the place a
/// refusal stops them. A surface is reserved only after every refusal has passed, so a refused
/// launch leaves no reservation behind.
pub(crate) async fn launch(front: &Arc<Front>, body: &str) -> String {
    let data: Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(error) => return faulted(&format!("400|Invalid JSON body: {error}")),
    };
    let extra = match extra_arguments(data.get("args")) {
        Ok(extra) => extra,
        Err(refused) => return faulted(&format!("{}|{}", refused.status, refused.message)),
    };
    let root = match ask(front, "root", json!([data.get("rootId").and_then(Value::as_str).unwrap_or_default()])).await {
        Ok(root) => root,
        Err(fault) => return faulted(&fault),
    };
    let text = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    let (root_id, root_path, root_name) = (text(&root, "id"), text(&root, "path"), text(&root, "name"));

    /* The preflight, in a scope of its own: its context carries a probe cache and a clock that are
       not `Send`, and this function awaits a spawn further down. */
    let config = {
        let declared = red_project::declaration::read(&root_path, None);
        let environment: Vec<(String, String)> = std::env::vars().collect();
        let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|since| since.as_millis() as i64).unwrap_or(0);
        let context = red_project::devices::Context {
            root_id: &root_id,
            root_path: &root_path,
            environment: &environment,
            probes: &front.probes,
            refresh: false,
            refreshed: Default::default(),
            controls: false,
            now: &now,
        };
        match red_project::games::inspect_game(&context, &declared, data.get("gameId").and_then(Value::as_str)) {
            Ok(config) => config,
            Err(fail) => return faulted(&refusal(fail)),
        }
    };

    /* Every game pane this workspace holds, so the decision can see the one already running. */
    let held: Vec<Value> = front.panes.lock().expect("panes").values().cloned().collect();
    let running: Vec<Pane<'_>> = held
        .iter()
        .filter(|pane| {
            /* The record a pane keeps is the SERVICE's: what rEngine composed lives under `meta`,
               and only the process facts — the id and the state — are the service's own. A filter
               reading `type` from the top level would find no game at all. */
            meta(pane, "type").and_then(Value::as_str) == Some("game")
                && pane.get("state").and_then(Value::as_str) == Some("running")
        })
        .map(|pane| Pane {
            id: pane.get("id").and_then(Value::as_str).unwrap_or_default(),
            root_id: meta(pane, "rootId").and_then(Value::as_str).unwrap_or_default(),
            game: meta(pane, "game").and_then(Value::as_str).unwrap_or_default(),
            args: meta(pane, "args")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default(),
        })
        .collect();

    let decided = match decide(&config, extra, &running) {
        Ok(decided) => decided,
        Err(refused) => return faulted(&format!("{}|{}", refused.status, refused.message)),
    };
    let (argv, reserve, inject_adapter) = match decided {
        Launch::Running(id) => {
            let held = front.panes.lock().expect("panes").get(&id).cloned();
            return match held {
                Some(pane) => http_text(200, "OK", &crate::panes::pane_answer(&pane, false)),
                None => faulted("409|That game's pane is no longer running."),
            };
        }
        Launch::Start { argv, reserve, inject_adapter } => (argv, reserve, inject_adapter),
    };

    let mut environment = config.get("env").cloned().unwrap_or_else(|| json!({}));
    let mut reserved: Option<String> = None;
    if reserve {
        let Some(surfaces) = &front.surfaces else {
            return faulted("500|This workspace has no surface listener, so a game that streams into a pane cannot be launched.");
        };
        let (token, variables) = surfaces.reserve();
        let inherited = std::env::var("DYLD_INSERT_LIBRARIES").ok();
        environment = surface_environment(&environment, &config, &variables, inject_adapter, inherited.as_deref());
        reserved = Some(token);
    }

    let options = json!({
        "rootId": root_id,
        "type": "game",
        "command": config.get("executable").cloned().unwrap_or(Value::Null),
        "args": argv,
        "cwd": config.get("cwd").cloned().unwrap_or(Value::Null),
        "title": format!("{} · {root_name}", text(&config, "title")),
        "surface": config.get("surface").cloned().unwrap_or(Value::Null),
        "game": config.get("id").cloned().unwrap_or(Value::Null),
        "env": environment,
    });
    match crate::panes::spawn_for_game(front, &options).await {
        Ok(session) => {
            /* The reservation is bound to the pane only once there IS a pane: a launch that failed
               must not leave a surface claiming to belong to a session that never started. */
            if let (Some(token), Some(surfaces)) = (&reserved, &front.surfaces) {
                surfaces.claim(token, session.get("id").and_then(Value::as_str).unwrap_or_default());
            }
            http_text(200, "OK", &crate::panes::pane_answer(&session, false))
        }
        Err(fault) => {
            if let (Some(token), Some(surfaces)) = (&reserved, &front.surfaces) {
                surfaces.remove(token);
            }
            faulted(&fault)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(extra: Value) -> Value {
        let mut base = json!({
            "rootId": "root-1", "id": "the-game", "title": "The Game", "declared": true, "ready": true,
            "args": ["--fullscreen"], "surface": "cooperative", "executable": "/games/the-game",
            "issues": [],
        });
        for (key, value) in extra.as_object().expect("an object") {
            base.as_object_mut().expect("an object").insert(key.clone(), value.clone());
        }
        base
    }

    fn pane<'a>(id: &'a str, game: &'a str, args: &[&str]) -> Pane<'a> {
        Pane { id, root_id: "root-1", game, args: args.iter().map(|value| value.to_string()).collect() }
    }

    #[test]
    fn a_declared_ready_game_starts_with_its_own_arguments_and_the_callers() {
        let decided = decide(&config(json!({})), vec!["-windowed".to_string()], &[]).expect("a launch");
        assert_eq!(
            decided,
            Launch::Start {
                argv: vec!["--fullscreen".to_string(), "-windowed".to_string()],
                reserve: true,
                inject_adapter: false,
            }
        );
    }

    /* The one difference between the two pane surfaces: an embedded game is injected into, a
       cooperative one connects itself, and a surface that is neither reserves nothing at all. */
    #[test]
    fn only_an_embedded_game_is_injected_and_only_a_pane_surface_reserves() {
        let embedded = decide(&config(json!({ "surface": "embedded" })), vec![], &[]).expect("a launch");
        assert_eq!(embedded, Launch::Start { argv: vec!["--fullscreen".into()], reserve: true, inject_adapter: true });
        let window = decide(&config(json!({ "surface": "window" })), vec![], &[]).expect("a launch");
        assert_eq!(window, Launch::Start { argv: vec!["--fullscreen".into()], reserve: false, inject_adapter: false });
    }

    #[test]
    fn the_same_game_on_the_same_arguments_is_the_pane_already_running() {
        let running = [pane("pane-7", "the-game", &["--fullscreen"])];
        assert_eq!(decide(&config(json!({})), vec![], &running), Ok(Launch::Running("pane-7".to_string())));
    }

    /* Refused, never silently attached with the caller's arguments dropped: a person who asked for
       -windowed and got the running full-screen one would have no way to tell. */
    #[test]
    fn the_same_game_on_different_arguments_is_refused_naming_both() {
        let running = [pane("pane-7", "the-game", &["--fullscreen"])];
        let refused = decide(&config(json!({})), vec!["-windowed".to_string()], &running).expect_err("refused");
        assert_eq!(refused.status, 409);
        assert!(refused.message.contains("The Game is already running with different arguments (--fullscreen)"), "{}", refused.message);
        assert!(refused.message.contains("launching it with --fullscreen -windowed"), "{}", refused.message);
    }

    /* Another game in the same project, and the same game in another project, are both other
       launches: the key is the pair. */
    #[test]
    fn a_different_game_or_a_different_project_is_a_different_launch() {
        let other_game = [pane("pane-7", "another-game", &["--fullscreen"])];
        assert!(matches!(decide(&config(json!({})), vec![], &other_game), Ok(Launch::Start { .. })));
        let elsewhere = [Pane { id: "pane-7", root_id: "root-2", game: "the-game", args: vec!["--fullscreen".into()] }];
        assert!(matches!(decide(&config(json!({})), vec![], &elsewhere), Ok(Launch::Start { .. })));
        assert_ne!(flight_key(&config(json!({}))), flight_key(&config(json!({ "id": "another-game" }))));
        assert_ne!(flight_key(&config(json!({}))), flight_key(&config(json!({ "rootId": "root-2" }))));
    }

    #[test]
    fn an_undeclared_or_refused_game_says_why_before_anything_is_reserved() {
        let undeclared = config(json!({ "declared": false, "issues": ["No game is declared.", "Declare one."] }));
        let refused = decide(&undeclared, vec![], &[]).expect_err("refused");
        assert_eq!((refused.status, refused.message.as_str()), (409, "No game is declared.\nDeclare one."));

        let bound_elsewhere = config(json!({ "refusal": "The Game runs on the box, which is not this machine." }));
        let refused = decide(&bound_elsewhere, vec![], &[]).expect_err("refused");
        assert_eq!(refused.message, "The Game runs on the box, which is not this machine.");
    }

    /* Not-ready is checked AFTER the already-running test: re-reporting a preflight issue about a
       game that is running answers a question nobody asked. */
    #[test]
    fn a_game_that_is_not_ready_is_refused_unless_it_is_already_running() {
        let unready = config(json!({ "ready": false, "issues": ["Game executable not found."] }));
        let refused = decide(&unready, vec![], &[]).expect_err("refused");
        assert_eq!(refused.message, "Game executable not found.");
        let running = [pane("pane-7", "the-game", &["--fullscreen"])];
        assert_eq!(decide(&unready, vec![], &running), Ok(Launch::Running("pane-7".to_string())),
                   "a running game is not re-judged against its preflight");
    }

    /* THE injection-race claim, where the composition is. It cannot be made from the child: on
       macOS dyld purges DYLD_* before a protected interpreter sees them, so a cooperative game
       reporting "no injection" cannot be told apart from one that was injected and purged. */
    #[test]
    fn a_cooperative_game_is_handed_no_injection_and_an_embedded_one_is() {
        let variables = [
            ("RENGINE_SURFACE_PORT".to_string(), "51000".to_string()),
            ("RENGINE_SURFACE_TOKEN".to_string(), "a".repeat(64)),
        ];
        let declared = json!({ "FIXTURE_FLAVOUR": "violet" });
        let config = json!({ "adapter": "/build/librengine_surface.dylib" });

        let cooperative = surface_environment(&declared, &config, &variables, false, Some("/other.dylib"));
        let keys: Vec<&String> = cooperative.as_object().expect("an object").keys()
            .filter(|key| key.starts_with("DYLD_") || key.starts_with("LD_")).collect();
        assert!(keys.is_empty(), "no injection variable may reach a cooperative game: {keys:?}");
        /* The other half of the same environment, asserted after it so it can never stand in for it. */
        assert_eq!(cooperative["RENGINE_SURFACE_PORT"], json!("51000"));
        assert_eq!(cooperative["RENGINE_SURFACE_TOKEN"], json!("a".repeat(64)));
        assert_eq!(cooperative["FIXTURE_FLAVOUR"], json!("violet"), "the record's own env survives beside them");

        let embedded = surface_environment(&declared, &config, &variables, true, None);
        assert_eq!(embedded["DYLD_INSERT_LIBRARIES"], json!("/build/librengine_surface.dylib"));
        assert_eq!(embedded["RENGINE_SURFACE_TOKEN"], json!("a".repeat(64)), "and it is reserved just the same");

        /* A workspace started under an injection of its own keeps it, ahead of nothing. */
        let beside = surface_environment(&declared, &config, &variables, true, Some("/other.dylib"));
        assert_eq!(beside["DYLD_INSERT_LIBRARIES"], json!("/build/librengine_surface.dylib:/other.dylib"));
    }

    #[test]
    fn extra_arguments_are_literal_or_they_are_refused() {
        assert_eq!(extra_arguments(None), Ok(Vec::new()));
        assert_eq!(extra_arguments(Some(&Value::Null)), Ok(Vec::new()));
        assert_eq!(extra_arguments(Some(&json!(["-windowed"]))), Ok(vec!["-windowed".to_string()]));
        for bad in [
            json!("-windowed"),
            json!([""]),
            json!([123]),
            json!(["${HOME}/save"]),
            json!(["a\0b"]),
            json!([vec!["x"; 1].join("").repeat(4097)]),
            json!(vec!["-x"; 65]),
        ] {
            assert!(extra_arguments(Some(&bad)).is_err(), "{bad} should be refused");
        }
    }
}
