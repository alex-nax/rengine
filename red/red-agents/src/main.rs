//! red-agents: the agent registry's shell surface (F171, spec 129, KI-093).
//!
//!   red-agents list [--names]              the recipes, as `name<TAB>package` or bare names
//!   red-agents show <agent> [field]        the shell record (CLI/PACKAGE/UPDATE_KIND/
//!                                          UPDATE_COMMAND/STRIP_PREFIX), one field or all
//!   red-agents parse <cli> -- <args...>    what the CLI's argv says about its conversation
//!   red-agents hook-key [--platform P] [group handler]
//!   red-agents trust-hash <command> [matcher]
//!
//! list/show are byte-exact with the registry.mjs CLI agent.sh used to shell out to, error
//! paths included; agent.sh now dispatches these reads to this binary. The registry document
//! resolves as $RENGINE_AGENT_REGISTRY, else the shipped registry.toml relative to the binary.

use std::process::ExitCode;

use red_agents::{hooks, parsers, Value};

const USAGE: &str = "Usage: red-agents list [--names] | show <agent> [field] | parse <cli> -- <args...> | hook-key [--platform win32|unix] [group handler] | trust-hash <command> [matcher]";

fn registry_path() -> Result<String, String> {
    if let Ok(declared) = std::env::var("RENGINE_AGENT_REGISTRY") {
        return Ok(declared);
    }
    let exe = std::env::current_exe().map_err(|error| format!("the registry document needs RENGINE_AGENT_REGISTRY: {error}"))?;
    // red/target/debug/red-agents -> debug/ .. target/ .. red/ .. the repository root.
    let path = exe
        .parent()
        .and_then(|directory| directory.ancestors().nth(3))
        .map(|root| root.join("orchestrator/agents/registry.toml"))
        .ok_or_else(|| "the registry document needs RENGINE_AGENT_REGISTRY".to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn load() -> Result<Vec<(String, Value)>, String> {
    let path = registry_path()?;
    let text = std::fs::read_to_string(&path).map_err(|error| format!("cannot read {path}: {error}"))?;
    // The extra file is read through the environment at call time, as the JS side reads it:
    // a recipe added as data needs no process restart (and no edit of the shipped document).
    let extra = match std::env::var("RENGINE_AGENT_REGISTRY_EXTRA") {
        Ok(extra_path) if !extra_path.is_empty() => {
            let extra_text = std::fs::read_to_string(&extra_path).map_err(|error| format!("cannot read {extra_path}: {error}"))?;
            Some((extra_text, extra_path))
        }
        _ => None,
    };
    red_agents::load_registry(&text, &path, extra.as_ref().map(|(text, path)| (text.as_str(), path.as_str())))
}

fn show_record(cli: &str, raw: &Value) -> Vec<(&'static str, String)> {
    let get = |key: &str| raw.get(key);
    let update_command = get("update").and_then(|u| u.get("command")).and_then(Value::string).unwrap_or("");
    let strip_prefix = get("conversation")
        .and_then(|c| c.get("short"))
        .and_then(|s| s.get("stripPrefix"))
        .and_then(Value::string)
        .unwrap_or("");
    vec![
        ("CLI", cli.to_string()),
        ("PACKAGE", get("package").and_then(Value::string).unwrap_or("").to_string()),
        ("UPDATE_KIND", get("update").and_then(|u| u.get("kind")).and_then(Value::string).unwrap_or("").to_string()),
        ("UPDATE_COMMAND", update_command.to_string()),
        ("STRIP_PREFIX", strip_prefix.to_string()),
    ]
}

fn fail(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("{message}");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(action) = args.first() else {
        return fail(USAGE);
    };
    match action.as_str() {
        "list" => {
            let recipes = match load() {
                Ok(recipes) => recipes,
                Err(error) => return fail(error),
            };
            let names_only = args.get(1).map(String::as_str) == Some("--names");
            for (cli, raw) in &recipes {
                if names_only {
                    println!("{cli}");
                } else {
                    println!("{cli}\t{}", raw.get("package").and_then(Value::string).unwrap_or(""));
                }
            }
            ExitCode::SUCCESS
        }
        "show" => {
            let Some(cli) = args.get(1) else {
                return fail(USAGE);
            };
            let recipes = match load() {
                Ok(recipes) => recipes,
                Err(error) => return fail(error),
            };
            let Some((_, raw)) = recipes.iter().find(|(name, _)| name == cli) else {
                return fail(format!("No agent named {cli} is registered."));
            };
            let record = show_record(cli, raw);
            match args.get(2) {
                Some(field) => {
                    let upper = field.to_uppercase();
                    match record.iter().find(|(key, _)| *key == upper) {
                        Some((_, value)) => {
                            println!("{value}");
                            ExitCode::SUCCESS
                        }
                        None => fail(format!("The registry has no {upper} for {cli}.")),
                    }
                }
                None => {
                    for (key, value) in &record {
                        println!("{key}={value}");
                    }
                    ExitCode::SUCCESS
                }
            }
        }
        "parse" => {
            let Some(cli) = args.get(1) else {
                return fail(USAGE);
            };
            let rest: Vec<String> = match args.get(2).map(String::as_str) {
                Some("--") => args[3..].to_vec(),
                _ => return fail(USAGE),
            };
            let parsed = match cli.as_str() {
                "claude" => parsers::claude_flags(&rest),
                "kimi" => parsers::kimi_flags(&rest),
                "codex" => parsers::codex_resume(&rest),
                _ => return fail(format!("No conversation parser for {cli}.")),
            };
            println!("{}", serde_json::json!({ "id": parsed.0, "source": parsed.1 }));
            ExitCode::SUCCESS
        }
        "hook-key" => {
            let mut platform = if cfg!(windows) { "win32" } else { "unix" };
            let mut numbers = vec![];
            for arg in &args[1..] {
                if arg == "--platform" {
                    continue;
                }
                if let Ok(number) = arg.parse::<u32>() {
                    numbers.push(number);
                } else if ["win32", "unix", "darwin", "linux"].contains(&arg.as_str()) {
                    platform = if arg == "win32" { "win32" } else { "unix" };
                } else {
                    return fail(USAGE);
                }
            }
            println!("{}", hooks::hook_key(platform, *numbers.first().unwrap_or(&0), *numbers.get(1).unwrap_or(&0)));
            ExitCode::SUCCESS
        }
        "trust-hash" => {
            let Some(command) = args.get(1) else {
                return fail(USAGE);
            };
            let matcher = args.get(2).map(String::as_str).unwrap_or("startup|resume");
            println!("{}", hooks::hook_trust_hash(command, matcher));
            ExitCode::SUCCESS
        }
        _ => fail(USAGE),
    }
}
