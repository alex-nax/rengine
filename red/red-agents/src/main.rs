//! red-agents: the agent registry's shell surface (F171, spec 129, KI-093).
//!
//!   red-agents list [--names]              the recipes, as `name<TAB>package` or bare names
//!   red-agents show <agent> [field]        the shell record (CLI/PACKAGE/UPDATE_KIND/
//!                                          UPDATE_COMMAND/STRIP_PREFIX), one field or all
//!   red-agents parse <cli> -- <args...>    what the CLI's argv says about its conversation
//!   red-agents can <cli> <capability>      does this CLI declare it? the declaration on stdout,
//!                                          exit 2 when it does not — so a shell caller asks what
//!                                          a CLI CAN do rather than comparing its name
//!   red-agents hook-key [--platform P] [group handler]
//!   red-agents trust-hash <command> [matcher]
//!
//! list/show are byte-exact with the registry.mjs CLI agent.sh used to shell out to, error
//! paths included; agent.sh now dispatches these reads to this binary. The registry document
//! resolves as $RENGINE_AGENT_REGISTRY, else the shipped registry.toml relative to the binary.

use std::process::ExitCode;

use red_agents::{hooks, parsers, Value};

const USAGE: &str = "Usage: red-agents list [--names] | show <agent> [field] | parse <cli> -- <args...> | can <cli> <capability> | hook-key [--platform win32|unix] [group handler] | trust-hash <command> [matcher]";

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
        /* What a CLI CAN do, for a caller that would otherwise compare its name — agent.sh's resume
           check being the one that did (F216, spec 141). The declaration is the answer: its atoms
           on stdout, one `key=value` per line, and exit 2 when this CLI declares nothing. */
        "can" => {
            let (Some(cli), Some(capability)) = (args.get(1), args.get(2)) else {
                return fail(USAGE);
            };
            let recipes = match load() {
                Ok(recipes) => recipes,
                Err(error) => return fail(error),
            };
            if !recipes.iter().any(|(name, _)| name == cli) {
                return fail(format!("No agent named {cli} is registered."));
            }
            let declared = match capability.as_str() {
                "handoff" => red_agents::launch::conversation_handoff(&recipes, cli),
                other => return fail(format!("rEngine has no capability named {other}.")),
            };
            let Some(declared) = declared else {
                return fail(format!("{cli} does not declare {capability}."));
            };
            for (key, value) in declared.as_object().into_iter().flatten() {
                match value {
                    serde_json::Value::Null => {}
                    serde_json::Value::Array(items) => {
                        for item in items {
                            println!("{key}={}", item.as_str().unwrap_or_default());
                        }
                    }
                    other => println!("{key}={}", other.as_str().map(str::to_string).unwrap_or_else(|| other.to_string())),
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
            /* The roster is data: the recipe is looked up and its declared spelling read. An arm
               per agent here was the dispatch that made adding one an edit to shared code. */
            let recipes = match load() {
                Ok(recipes) => recipes,
                Err(error) => return fail(error),
            };
            /* The same projection launch.rs reads a recipe through, so `parse` and a real launch
               agree about what the recipe says. */
            let Some(talk) = red_agents::launch::conversation_of(&recipes, cli) else {
                return fail(format!("No conversation parser for {cli}."));
            };
            let Some(parsed) = parsers::read(&talk, &rest) else {
                return fail(format!("No conversation parser for {cli}."));
            };
            println!("{}", serde_json::json!({ "id": parsed.0, "source": parsed.1 }));
            ExitCode::SUCCESS
        }
        "bind" => {
            let recipes = match load() {
                Ok(recipes) => recipes,
                Err(error) => return fail(error),
            };
            let home = std::env::var("XDG_STATE_HOME").ok().filter(|value| !value.is_empty()).unwrap_or_else(|| {
                let home = std::env::var("HOME").unwrap_or_default();
                format!("{home}/.local/state")
            });
            /* Nothing is spawned here, so the pid the identity records is the terminal that will run
               the CLI: the process that is actually alive while this agent works. */
            let owner = std::os::unix::process::parent_id() as i64;
            let inputs = serde_json::json!({ "pid": if owner > 1 { owner } else { std::process::id() as i64 },
                                             "platform": if cfg!(windows) { "win32" } else { "unix" } });
            let mut mint = || red_agents::mint::uuid_v4();
            let mut now = || red_agents::mint::now_iso();
            let wants_json = args.iter().any(|arg| arg == "--json");
            let argv: Vec<String> = args[1..].iter().filter(|arg| *arg != "--json").cloned().collect();
            match red_agents::bind::bind(&argv, &recipes, &home, &inputs, &mut mint, &mut now) {
                Ok(answer) => {
                    if wants_json {
                        println!("{answer}");
                    } else {
                        println!("{}", answer.get("report").or_else(|| answer.get("usage")).and_then(|v| v.as_str()).unwrap_or(""));
                    }
                    ExitCode::SUCCESS
                }
                Err(message) => { eprintln!("{message}"); ExitCode::from(2) }
            }
        }
        "report-session" => {
            let recipes = match load() {
                Ok(recipes) => recipes,
                Err(error) => return fail(error),
            };
            ExitCode::from(red_agents::report::report_session(&args[1..], &recipes) as u8)
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
