//! One question per run, answered as JSON on stdout (F156c, spec 129).
//!
//!   red-project declaration <rootPath> [declarationFile]
//!   red-project recordings <rootId> <rootPath> [limit]
//!   red-project recording  <rootId> <rootPath> <id> [artifact] [offset] [limit] [maxCharacters]
//!   red-project env-rules                    the env object on stdin, its problems on stdout
//!   red-project tasks <call> <rootId> <rootPath>   one task question, its input on stdin
//!   red-project workspace <rootId> <rootPath> [flags] [probeCache] [declarationFile]
//!     flags: a comma-separated set of `refresh` and `controls`
//!   red-project game <rootId> <rootPath> [gameId] [probeCache] [declarationFile]
//!
//! A refusal is `{"error": …, "status": N}` and exit 1, because the JS client this answers turns it
//! back into the same `fail()` the module it replaced threw. Both of this crate's callers — the
//! Rust host, which links the library, and the JS worker, which runs this — get one implementation.

use std::process::ExitCode;

/// The registry this checkout ships, read the way red-store-serve reads it.
fn recipes() -> serde_json::Value {
    let declared = std::env::var("RENGINE_AGENT_REGISTRY").ok().filter(|path| !path.is_empty());
    let path = declared.map(std::path::PathBuf::from).or_else(|| {
        std::env::current_exe().ok().and_then(|exe| exe.ancestors().nth(4).map(|checkout| checkout.join("orchestrator/agents/registry.toml")))
    });
    path.and_then(|path| std::fs::read_to_string(&path).ok().map(|text| (text, path)))
        .and_then(|(text, path)| red_agents::load_registry(&text, &path.to_string_lossy(), None).ok())
        .map(|recipes| red_agents::projection(&recipes))
        .unwrap_or_else(|| serde_json::json!({}))
}

/// The briefs rEngine ships, beside the registry it ships.
fn shipped_prompts() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.ancestors().nth(4).map(|checkout| checkout.join("orchestrator/templates/prompts")))
        .unwrap_or_default()
}

fn tasks(call: &str, root_id: &str, root_path: &str) -> Result<serde_json::Value, red_project::recordings::Fail> {
    use serde_json::json;
    let mut text = String::new();
    let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut text);
    let input: serde_json::Value = serde_json::from_str(text.trim()).unwrap_or(serde_json::Value::Null);
    let field = |name: &str| input.get(name).cloned().unwrap_or(serde_json::Value::Null);
    let string = |name: &str| input.get(name).and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    match call {
        "writeCommand" => red_project::tasks::write_command(&field("declared")),
        "writeDocument" => red_project::tasks::write_document(&field("data")).map(|(document, json)| json!({ "document": document, "json": json })),
        "renderPrompt" => red_project::tasks::render_prompt(&string("template"), &field("values"), &string("source")).map(|text| json!({ "text": text })),
        "promptValues" => Ok(red_project::tasks::prompt_values(&field("row"))),
        "modelArgs" => red_project::tasks::model_args(&recipes(), &string("cli"), input.get("model").and_then(serde_json::Value::as_str))
            .map(|args| json!({ "args": args })),
        "codexModels" => Ok(json!({ "models": red_project::tasks::codex_models(&string("help")) })),
        "parseInstalled" => Ok(json!({ "installed": red_project::rules::object(
            red_project::tasks::parse_installed(&string("text")).iter().map(|(name, known)| (name.as_str(), json!(known))).collect()) })),
        "knownAgents" => Ok(json!({ "agents": red_project::tasks::known_agents(&recipes()) })),
        /* Two halves, because running a CLI is the caller's business and knowing WHICH to run is
           this module's rule: the answer carries the menu it can build now and the CLIs whose own
           `--help` it still wants. A caller with nothing in `help` asks again with what it found. */
        "agentsMenu" => {
            let recipes = recipes();
            let declared = field("declared");
            let installed = string("installed");
            let help = field("help");
            let mut help_of = |cli: &str| help.get(cli).and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
            let menu = red_project::tasks::agents_menu(root_id, &recipes, &declared, &installed, &mut help_of);
            let wanted: Vec<String> = red_project::tasks::needs_help(&recipes, &declared, &installed)
                .into_iter()
                .filter(|cli| help.get(cli).is_none())
                .collect();
            Ok(json!({ "menu": menu, "needsHelp": wanted }))
        }
        "taskWrite" => {
            let environment: Vec<(String, String)> = std::env::vars().collect();
            red_project::tasks::task_write(root_id, root_path, &field("declared"), &field("data"), &environment)
        }
        "promptFor" => red_project::tasks::prompt_for(root_path, &string("name"), &field("values"), &shipped_prompts()),
        other => Err(red_project::recordings::Fail { message: format!("unknown task call {other}"), status: 400 }),
    }
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let arg = |index: usize| argv.get(index).map(String::as_str).filter(|value| !value.is_empty());
    let answer = match arg(0) {
        /* The one question whose subject is not a path: an env object a caller proposes, judged by
           the same rules a declared action's env is judged by. It arrives on stdin rather than in
           argv because it is arbitrary caller input and argv has a length a caller could reach. */
        Some("env-rules") => {
            let mut text = String::new();
            match std::io::Read::read_to_string(&mut std::io::stdin(), &mut text) {
                Ok(_) => {
                    /* Absence and null are different answers: a request that names no env has no
                       rules to break, and one whose env is null is refused by name. */
                    let named: serde_json::Value = serde_json::from_str(text.trim()).unwrap_or(serde_json::Value::Null);
                    let env = named.get("env");
                    Ok(serde_json::json!({ "problems": red_project::rules::env_rules(env, "env") }))
                }
                Err(error) => Err(red_project::recordings::Fail { message: format!("cannot read the env: {error}"), status: 400 }),
            }
        }
        /* Both listings in one run, because they share a probe cache: the dashboard asks each
           action's device whether it answers, and the devices tab asks the dashboard what is bound
           to each one. Answering them separately would cost a probe per action. */
        Some("workspace") => {
            let (root_id, root_path) = (arg(1).unwrap_or_default(), arg(2).unwrap_or_default());
            let flags: Vec<&str> = arg(3).unwrap_or_default().split(',').collect();
            let environment: Vec<(String, String)> = std::env::vars().collect();
            let probes = match arg(4) {
                Some(file) => red_project::devices::Probes::kept_at(std::path::Path::new(file)),
                None => red_project::devices::Probes::default(),
            };
            let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|since| since.as_millis() as i64).unwrap_or(0);
            let context = red_project::devices::Context {
                root_id,
                root_path,
                environment: &environment,
                probes: &probes,
                refresh: flags.contains(&"refresh"),
                controls: flags.contains(&"controls"),
                now: &now,
            };
            let declared = red_project::declaration::read(root_path, arg(5));
            let answer = serde_json::json!({
                "devices": red_project::dashboard::project_devices(&context, &declared),
                "dashboard": red_project::dashboard::dashboard_actions(&context, &declared),
            });
            probes.keep(now());
            Ok(answer)
        }
        /* One game's preflight, which is what a launch asks before it spawns anything and what the
           game-config route answers. It shares the same probe cache, so asking about a game on an
           unreachable box does not wait out that box's timeout a second time. */
        Some("game") => {
            let (root_id, root_path) = (arg(1).unwrap_or_default(), arg(2).unwrap_or_default());
            let environment: Vec<(String, String)> = std::env::vars().collect();
            let probes = match arg(4) {
                Some(file) => red_project::devices::Probes::kept_at(std::path::Path::new(file)),
                None => red_project::devices::Probes::default(),
            };
            let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|since| since.as_millis() as i64).unwrap_or(0);
            let context = red_project::devices::Context {
                root_id, root_path, environment: &environment, probes: &probes, refresh: false, controls: false, now: &now,
            };
            let declared = red_project::declaration::read(root_path, arg(5));
            let answer = red_project::games::inspect_game(&context, &declared, arg(3));
            probes.keep(now());
            answer
        }
        /* The task questions, each answered from a JSON document on stdin so a row, a template or
           a CLI's own --help can be any size a caller sends. One call per run; none of them is a
           hot path — they are what a person or an agent does once, deliberately. */
        Some("tasks") => tasks(arg(1).unwrap_or_default(), arg(2).unwrap_or_default(), arg(3).unwrap_or_default()),
        Some("recordings") => red_project::recordings::list(arg(1).unwrap_or_default(), arg(2).unwrap_or_default(), arg(3)),
        Some("declaration") => Ok(red_project::declaration::read(arg(1).unwrap_or_default(), arg(2))),
        Some("recording") => red_project::recordings::read(
            arg(1).unwrap_or_default(),
            arg(2).unwrap_or_default(),
            arg(3).unwrap_or_default(),
            arg(4),
            arg(5),
            arg(6),
            arg(7),
        ),
        other => {
            eprintln!("red-project: unknown question {}", other.unwrap_or("(none)"));
            return ExitCode::from(2);
        }
    };
    match answer {
        Ok(value) => {
            println!("{value}");
            ExitCode::SUCCESS
        }
        Err(fail) => {
            println!("{}", serde_json::json!({ "error": fail.message, "status": fail.status }));
            ExitCode::FAILURE
        }
    }
}
