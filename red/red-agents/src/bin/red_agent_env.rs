//! Answers spawn-environment fixtures the way the ported composition computes them.
//!
//! The JS suite owns the fixtures and the deep-equal (agent-spawn-env.test.mjs); this binary owns
//! the only question Rust can answer — whether the ported composition computes the same bytes.
//! Three questions, three subcommands:
//!
//!   red-agent-env shell <fixture.json>                 the shellEnvironment envelope
//!   red-agent-env pane  <registry.toml> <fixture.json> the pane-identity composition
//!   red-agent-env spawn <registry.toml> <fixture.json> the full two-stage spawn environment
//!
//! Exit 0 with the answer on stdout; exit 2 on a usage, read or shape error.

use std::process::ExitCode;

use red_agents::spawn::{agent_pane_composition, conversation_start_capability, shell_environment, CLEARED};

fn read(path: &str) -> Result<String, ExitCode> {
    std::fs::read_to_string(path).map_err(|error| {
        eprintln!("red-agent-env: cannot read {path}: {error}");
        ExitCode::from(2)
    })
}

fn json(path: &str) -> Result<serde_json::Value, ExitCode> {
    serde_json::from_str(&read(path)?).map_err(|error| {
        eprintln!("red-agent-env: {path} is not JSON: {error}");
        ExitCode::from(2)
    })
}

fn object<'a>(value: &'a serde_json::Value, what: &str) -> Result<&'a serde_json::Map<String, serde_json::Value>, ExitCode> {
    value.as_object().ok_or_else(|| {
        eprintln!("red-agent-env: fixture needs {what}");
        ExitCode::from(2)
    })
}

fn load_recipes(registry: &str) -> Result<Vec<(String, red_agents::Value)>, ExitCode> {
    let text = read(registry)?;
    red_agents::load_registry(&text, registry, None).map_err(|error| {
        eprintln!("red-agent-env: {error}");
        ExitCode::from(2)
    })
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(mode) = args.next() else {
        eprintln!("usage: red-agent-env shell <fixture.json> | pane <registry.toml> <fixture.json> | spawn <registry.toml> <fixture.json>");
        return ExitCode::from(2);
    };
    let answer = match mode.as_str() {
        "shell" => {
            let Some(fixture) = args.next() else {
                eprintln!("usage: red-agent-env shell <fixture.json>");
                return ExitCode::from(2);
            };
            let fixture = match json(&fixture) {
                Ok(value) => value,
                Err(code) => return code,
            };
            let run = || -> Result<serde_json::Value, ExitCode> {
                let env = shell_environment(
                    object(&fixture["overrides"], "overrides")?,
                    object(&fixture["inherited"], "inherited")?,
                    fixture["platform"].as_str().unwrap_or(""),
                    fixture["userDirectory"].as_str().unwrap_or(""),
                );
                Ok(serde_json::to_value(env).expect("a string map serializes"))
            };
            run()
        }
        "pane" | "spawn" => {
            let (Some(registry), Some(fixture_path)) = (args.next(), args.next()) else {
                eprintln!("usage: red-agent-env {mode} <registry.toml> <fixture.json>");
                return ExitCode::from(2);
            };
            let run = || -> Result<serde_json::Value, ExitCode> {
                let recipes = load_recipes(&registry)?;
                let fixture = json(&fixture_path)?;
                let pane_input = if mode == "spawn" { &fixture["pane"] } else { &fixture };
                let capability = pane_input["agent"].as_str().and_then(|agent| conversation_start_capability(&recipes, agent));
                let plan = agent_pane_composition(pane_input, capability);
                if mode == "pane" {
                    return Ok(plan);
                }
                // The two stages sessions.mjs applies (its lines 133 and 205): each clears the
                // identity family first, so this launch's own values win and stale ones stay gone.
                let shell = &fixture["shell"];
                let inherited = object(&shell["inherited"], "shell.inherited")?;
                let platform = shell["platform"].as_str().unwrap_or("");
                let user_directory = shell["userDirectory"].as_str().unwrap_or("");
                let agent_home = shell["agentHome"].as_str().unwrap_or("");
                let cleared = || -> serde_json::Map<String, serde_json::Value> {
                    CLEARED.iter().map(|key| (key.to_string(), serde_json::Value::Null)).collect()
                };
                let mut first = object(&shell["env"], "shell.env")?.clone();
                first.insert("RENGINE_AGENT_HOME".to_string(), serde_json::json!(agent_home));
                first.extend(cleared());
                let stage_one = shell_environment(&first, inherited, platform, user_directory);
                let mut merged: serde_json::Map<String, serde_json::Value> =
                    stage_one.into_iter().map(|(key, value)| (key, serde_json::Value::String(value))).collect();
                if let serde_json::Value::Object(sets) = &plan["sets"] {
                    merged.extend(sets.clone());
                }
                merged.insert("RENGINE_AGENT_HOME".to_string(), serde_json::json!(agent_home));
                let mut second = cleared();
                second.extend(merged);
                let stage_two = shell_environment(&second, inherited, platform, user_directory);
                Ok(serde_json::to_value(stage_two).expect("a string map serializes"))
            };
            run()
        }
        _ => {
            eprintln!("usage: red-agent-env shell <fixture.json> | pane <registry.toml> <fixture.json> | spawn <registry.toml> <fixture.json>");
            Err(ExitCode::from(2))
        }
    };
    match answer {
        Ok(value) => {
            println!("{}", serde_json::to_string_pretty(&value).expect("the answer serializes"));
            ExitCode::SUCCESS
        }
        Err(code) => code,
    }
}
