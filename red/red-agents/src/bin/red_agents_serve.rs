//! The red-agents stdio service (F173, F149c, spec 129, KI-093): the recipe registry as a
//! process, speaking newline-delimited JSON-RPC over stdin/stdout — the same channel shape
//! red-store-serve established (F174) and the same one the thin client in
//! `orchestrator/agents/agents-client.mjs` presents the old JS surface over.
//!
//!   red-agents-serve
//!
//! One request per line: `{"id": N, "method": "recipe", "args": ["claude"]}`. One answer per
//! line: `{"id": N, "result": ...}` or `{"id": N, "error": {"message": ...}}`. stdin closing
//! ends the process, so a dead host leaves no service behind.
//!
//! The registry is re-read per request rather than cached: the JS module it replaces read
//! RENGINE_AGENT_REGISTRY_EXTRA at call time so a recipe added as data needed no restart, and a
//! service that cached would quietly take that away.

use std::io::{BufRead, Write};
use std::process::ExitCode;

use red_agents::mint::{now_iso, uuid_v4};
use red_agents::Value;
use serde_json::{json, Value as Json};

fn registry_path() -> Result<String, String> {
    if let Ok(declared) = std::env::var("RENGINE_AGENT_REGISTRY") {
        if !declared.is_empty() {
            return Ok(declared);
        }
    }
    let checkout = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .ok_or_else(|| "cannot locate the checkout".to_string())?;
    Ok(checkout.join("orchestrator/agents/registry.toml").to_string_lossy().into_owned())
}

thread_local! {
    /* Which documents THIS request names. A service outlives the environment it was spawned in: the
       JS module read RENGINE_AGENT_REGISTRY_EXTRA at call time, and a process that read it once
       went on answering from a file the caller had since replaced or removed. So the client names
       the documents per request and this is where they land. */
    static DOCUMENTS: std::cell::RefCell<(Option<String>, Option<String>)> = const { std::cell::RefCell::new((None, None)) };
}

fn load() -> Result<Vec<(String, Value)>, String> {
    let (named_registry, named_extra) = DOCUMENTS.with(|cell| cell.borrow().clone());
    let path = match named_registry {
        Some(path) if !path.is_empty() => path,
        _ => registry_path()?,
    };
    let text = std::fs::read_to_string(&path).map_err(|error| format!("cannot read {path}: {error}"))?;
    let extra = match named_extra.ok_or(std::env::VarError::NotPresent).or_else(|_| std::env::var("RENGINE_AGENT_REGISTRY_EXTRA")) {
        Ok(extra_path) if !extra_path.is_empty() => {
            let extra_text = std::fs::read_to_string(&extra_path)
                .map_err(|error| format!("cannot read {extra_path}: {error}"))?;
            Some((extra_text, extra_path))
        }
        _ => None,
    };
    red_agents::load_registry(&text, &path, extra.as_ref().map(|(text, path)| (text.as_str(), path.as_str())))
}

fn text_arg(args: &Json, index: usize) -> Option<&str> {
    args.get(index).and_then(Json::as_str)
}

fn dispatch(method: &str, args: &Json) -> Result<Json, String> {
    match method {
        /* The registry, projected exactly as `red-agents-dump` projects it for the parity test:
           one shape, so the service and the dump cannot drift into two answers. */
        "resolvedRecipes" => Ok(red_agents::projection(&load()?)),
        "agentNames" => Ok(Json::Array(load()?.iter().map(|(cli, _)| json!(cli)).collect())),
        "recipe" => {
            let Some(cli) = text_arg(args, 0) else { return Err("recipe takes a CLI name.".into()) };
            let recipes = load()?;
            Ok(recipes
                .iter()
                .find(|(name, _)| name == cli)
                .map(|(_, raw)| red_agents::project(raw))
                .unwrap_or(Json::Null))
        }
        /* The codex hook layer's two numbers. The platform is the service's own, which is the
           launcher's — the key is what codex looks its trust entry up under. */
        "hookKey" => {
            let platform = if cfg!(windows) { "win32" } else { "unix" };
            let group = args.get(0).and_then(Json::as_u64).unwrap_or(0) as u32;
            let handler = args.get(1).and_then(Json::as_u64).unwrap_or(0) as u32;
            Ok(json!(red_agents::hooks::hook_key(platform, group, handler)))
        }
        "hookTrustHash" => {
            let Some(command) = text_arg(args, 0) else { return Err("hookTrustHash takes a command.".into()) };
            let matcher = text_arg(args, 1).unwrap_or("startup|resume");
            Ok(json!(red_agents::hooks::hook_trust_hash(command, matcher)))
        }
        /* One method, not one per agent (spec 141). It takes the CLI's name and reads that
           recipe's declared spelling; the three agent-named methods it replaces had no caller
           outside this file, which is what a wire surface shaped around identities tends to
           become. */
        /* What a CLI declares it can be HANDED (F216, spec 141). It is not an atom of
           `resolvedRecipes`, because that projection is frozen to the shape registry.mjs emitted —
           so the capability gets a method, the way the read spelling did. */
        "conversationHandoff" => {
            let cli = args.get(0).and_then(Json::as_str).unwrap_or_default();
            let recipes = load()?;
            Ok(red_agents::launch::conversation_handoff(&recipes, cli).unwrap_or(Json::Null))
        }
        /* Unions over every declared recipe (F220, spec 141): what the CLIs stamp on their
           children, and where they install themselves. Neither is about one CLI, which is why they
           are whole-registry answers rather than a field on a recipe's projection. */
        "processIdentity" => Ok(json!(red_agents::launch::process_identity(&load()?))),
        "installPaths" => Ok(json!(red_agents::launch::install_paths(&load()?))),
        "conversationRead" => {
            let cli = args.get(0).and_then(Json::as_str).unwrap_or_default();
            let rest: Vec<String> = args
                .get(1)
                .and_then(Json::as_array)
                .map(|values| values.iter().filter_map(Json::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            let recipes = load()?;
            let Some(talk) = red_agents::launch::conversation_of(&recipes, cli) else {
                return Err(format!("No conversation parser for {cli}."));
            };
            let Some(parsed) = red_agents::parsers::read(&talk, &rest) else {
                return Err(format!("No conversation parser for {cli}."));
            };
            Ok(json!({ "id": parsed.0, "source": parsed.1 }))
        }
        /* The launch half (F173). Everything environment-dependent is in `args[0]`; every decision
           is the crate's. The harness freezes the mint and the clock the way red-store-serve does. */
        "agentLaunch" | "agentIdentity" => {
            let inputs = args.get(0).cloned().unwrap_or_else(|| json!({}));
            let mut mint = mint_sequence();
            let mut now = now_sequence();
            let recipes = load()?;
            if method == "agentIdentity" {
                red_agents::launch::agent_identity(&recipes, &inputs, &mut mint, &mut now)
            } else {
                red_agents::launch::launch_plan(&recipes, &inputs, &mut mint, &mut now)
            }
        }
        /* The pane-identity composition the JS host used to keep beside pty.spawn (F178): the
           decision moves here, the mint and the clock arrive as data so nothing depends on a draw. */
        "paneComposition" => {
            let input = args.get(0).cloned().unwrap_or(Json::Null);
            let capability = match input.get("agent").and_then(Json::as_str) {
                Some(agent) => red_agents::spawn::conversation_start_capability(&load()?, agent),
                None => None,
            };
            Ok(red_agents::spawn::agent_pane_composition(&input, capability))
        }
        "describeSession" => Ok(red_agents::launch::describe_session(&args.get(0).cloned().unwrap_or(Json::Null))),
        "conversationArgs" => {
            let Some(agent) = text_arg(args, 0) else { return Err("conversationArgs takes a CLI name.".into()) };
            let identity = args.get(1).cloned().unwrap_or(Json::Null);
            let resume = args.get(2).and_then(Json::as_bool).unwrap_or(false);
            Ok(json!(red_agents::launch::conversation_args(&load()?, agent, &identity, resume)))
        }
        "agentCli" => Ok(json!(red_agents::launch::agent_cli(&load()?, text_arg(args, 0).unwrap_or(""), text_arg(args, 1)))),
        "shortAgentId" => Ok(json!(red_agents::launch::short_agent_id(&load()?, text_arg(args, 0).unwrap_or(""), text_arg(args, 1).unwrap_or("")))),
        "agentLabel" => Ok(json!(red_agents::launch::agent_label(
            &load()?, text_arg(args, 0).unwrap_or(""), text_arg(args, 1), text_arg(args, 2)
        ))),
        "shellQuote" => Ok(json!(red_agents::launch::shell_quote(text_arg(args, 0).unwrap_or("")))),
        "perLaunchSettings" => {
            let windows = cfg!(windows);
            Ok(red_agents::launch::per_launch_settings(text_arg(args, 0).unwrap_or(""), text_arg(args, 1).unwrap_or(""), windows))
        }
        /* bind's own two: a command a person runs, and the scan it does to find a workspace. Home
           is passed in rather than read here, because a caller may be probing another one. */
        "stateDirectories" => Ok(json!(red_agents::bind::state_directories(text_arg(args, 0), text_arg(args, 1).unwrap_or(""))
            .iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>())),
        "bind" => {
            let argv: Vec<String> = args.get(0).and_then(Json::as_array)
                .map(|values| values.iter().filter_map(Json::as_str).map(str::to_string).collect()).unwrap_or_default();
            let home = text_arg(args, 1).unwrap_or("");
            let inputs = args.get(2).cloned().unwrap_or_else(|| json!({}));
            let mut mint = mint_sequence();
            let mut now = now_sequence();
            red_agents::bind::bind(&argv, &load()?, home, &inputs, &mut mint, &mut now)
        }
        _ => Err(format!("Unknown agents method {method}.")),
    }
}

/* Harness-only, exactly as red-store-serve takes them: a frozen sequence makes a launch plan
   byte-comparable against the JS module's, which is what the parity test needs. */
fn mint_sequence() -> impl FnMut() -> String {
    let mut queued: Vec<String> = std::env::var("RED_AGENTS_MINT_SEQUENCE")
        .map(|text| text.split(',').filter(|v| !v.is_empty()).map(str::to_string).collect())
        .unwrap_or_default();
    queued.reverse();
    move || queued.pop().unwrap_or_else(uuid_v4)
}
fn now_sequence() -> impl FnMut() -> String {
    let mut queued: Vec<String> = std::env::var("RED_AGENTS_NOW_SEQUENCE")
        .map(|text| text.split(',').filter(|v| !v.is_empty()).map(str::to_string).collect())
        .unwrap_or_default();
    queued.reverse();
    move || queued.pop().unwrap_or_else(now_iso)
}

fn main() -> ExitCode {
    let stdout = std::io::stdout();
    // The first line is the startup outcome, which is what the client's open() awaits: a registry
    // that will not parse fails the client's open rather than the first read that happens to need it.
    let started = match load() {
        Ok(recipes) => json!({ "started": true, "recipes": recipes.len() }),
        Err(error) => {
            let answer = json!({ "started": false, "error": { "message": error } });
            let _ = writeln!(stdout.lock(), "{answer}");
            return ExitCode::from(1);
        }
    };
    let _ = writeln!(stdout.lock(), "{started}");
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Json = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                let answer = json!({ "id": Json::Null, "error": { "message": format!("not JSON: {error}") } });
                let _ = writeln!(stdout.lock(), "{answer}");
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Json::Null);
        let method = request.get("method").and_then(Json::as_str).unwrap_or("");
        let args = request.get("args").cloned().unwrap_or_else(|| json!([]));
        DOCUMENTS.with(|cell| {
            *cell.borrow_mut() = (
                request.get("registry").and_then(Json::as_str).map(str::to_string),
                request.get("extra").and_then(Json::as_str).map(str::to_string),
            );
        });
        let answer = match dispatch(method, &args) {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(message) => json!({ "id": id, "error": { "message": message } }),
        };
        let _ = writeln!(stdout.lock(), "{answer}");
    }
    ExitCode::SUCCESS
}
