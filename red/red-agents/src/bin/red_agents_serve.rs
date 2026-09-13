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

fn load() -> Result<Vec<(String, Value)>, String> {
    let path = registry_path()?;
    let text = std::fs::read_to_string(&path).map_err(|error| format!("cannot read {path}: {error}"))?;
    let extra = match std::env::var("RENGINE_AGENT_REGISTRY_EXTRA") {
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
        "codexHookKey" => {
            let platform = if cfg!(windows) { "win32" } else { "unix" };
            let group = args.get(0).and_then(Json::as_u64).unwrap_or(0) as u32;
            let handler = args.get(1).and_then(Json::as_u64).unwrap_or(0) as u32;
            Ok(json!(red_agents::hooks::hook_key(platform, group, handler)))
        }
        "codexHookTrustHash" => {
            let Some(command) = text_arg(args, 0) else { return Err("codexHookTrustHash takes a command.".into()) };
            let matcher = text_arg(args, 1).unwrap_or("startup|resume");
            Ok(json!(red_agents::hooks::hook_trust_hash(command, matcher)))
        }
        "claudeFlags" | "kimiFlags" | "codexResume" => {
            let rest: Vec<String> = args
                .get(0)
                .and_then(Json::as_array)
                .map(|values| values.iter().filter_map(Json::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            let parsed = match method {
                "claudeFlags" => red_agents::parsers::claude_flags(&rest),
                "kimiFlags" => red_agents::parsers::kimi_flags(&rest),
                _ => red_agents::parsers::codex_resume(&rest),
            };
            Ok(json!({ "id": parsed.0, "source": parsed.1 }))
        }
        _ => Err(format!("Unknown agents method {method}.")),
    }
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
        let answer = match dispatch(method, &args) {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(message) => json!({ "id": id, "error": { "message": message } }),
        };
        let _ = writeln!(stdout.lock(), "{answer}");
    }
    ExitCode::SUCCESS
}
