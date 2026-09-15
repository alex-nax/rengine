//! `red-agents bind` (F173, F149c, spec 129), ported from `orchestrator/agents/bind.mjs`.
//!
//! Binds an agent this workspace never spawned: finds the live instance already serving a project,
//! gives the agent an identity and writes the MCP configuration to start it with. Nothing is
//! spawned here, so the pid the identity records is the terminal that will run the CLI.
//!
//! Discovery is filesystem plus one GET, both of them here rather than handed in: unlike the launch
//! plan — whose environment-dependent inputs stay with the caller by the owner's 2026-09-13
//! decision — `bind` IS the caller. It is a command a person runs, with nothing above it to gather
//! anything on its behalf.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{json, Value as Json};

use crate::Value;

/// `path` is the whole path, `/health` or `/api/state`. HTTP/1.0 on purpose: a 1.1 server may answer
/// chunked, and a body read as JSON straight off the socket would then start with its chunk length —
/// which is exactly how this first failed, as "trailing characters at line 1 column 4".
fn http_get(url: &str, token: &str, path: &str) -> Result<Json, String> {
    let after = url.strip_prefix("http://").ok_or("Invalid local workspace connection.")?;
    let addr = after.split('/').next().unwrap_or(after);
    let mut stream = std::net::TcpStream::connect(addr).map_err(|error| error.to_string())?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(10))).map_err(|error| error.to_string())?;
    use std::io::Write;
    let request = format!("GET {path} HTTP/1.0\r\nHost: {addr}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream.read_to_string(&mut response).map_err(|error| error.to_string())?;
    let status: u16 = response.split_whitespace().nth(1).and_then(|code| code.parse().ok()).unwrap_or(0);
    let body = response.split("\r\n\r\n").nth(1).unwrap_or("");
    if !(200..300).contains(&status) {
        return Err(format!("workspace returned {status}"));
    }
    serde_json::from_str(body).map_err(|error| error.to_string())
}

fn is_dir(path: &Path) -> bool {
    std::fs::metadata(path).map(|meta| meta.is_dir()).unwrap_or(false)
}
fn children(parent: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(parent) else { return vec![] };
    let mut found: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| is_dir(path))
        .collect();
    found.sort();
    found
}
fn describes_instance(directory: &Path) -> bool {
    directory.join("sidecar.json").is_file()
}

/// Which directory a launcher chose is the launcher's business. Beyond the base, the DESCRIPTOR is
/// what identifies a state directory, at the two depths a launcher plausibly uses; directories
/// without one are never opened.
pub fn state_directories(explicit: Option<&str>, home: &str) -> Vec<PathBuf> {
    if let Some(explicit) = explicit.filter(|value| !value.is_empty()) {
        return vec![PathBuf::from(explicit)];
    }
    let home = Path::new(home);
    let base = home.join("rengine");
    let mut found = vec![base.clone()];
    found.extend(children(&base));
    let mut seen: std::collections::BTreeSet<PathBuf> = found.iter().cloned().collect();
    for directory in children(home) {
        if seen.contains(&directory) {
            continue;
        }
        let candidates = if describes_instance(&directory) { vec![directory] } else { children(&directory) };
        for candidate in candidates {
            if !seen.contains(&candidate) && describes_instance(&candidate) {
                seen.insert(candidate.clone());
                found.push(candidate);
            }
        }
    }
    found
}

fn alive(pid: i64) -> bool {
    if pid <= 1 {
        return false;
    }
    #[cfg(unix)]
    unsafe {
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        kill(pid as i32, 0) == 0
    }
    #[cfg(not(unix))]
    true
}

/// The descriptor, checked the way the JS discovery checked it: a loopback URL, a 64-hex token, a
/// live pid, and a health answer whose identity is the descriptor's.
fn discover(directory: &Path) -> Result<Option<Json>, String> {
    let descriptor = directory.join("sidecar.json");
    let text = match std::fs::read_to_string(&descriptor) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let instance: Json = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let url = instance.get("url").and_then(Json::as_str).unwrap_or("");
    let token = instance.get("token").and_then(Json::as_str).unwrap_or("");
    let loopback = url.starts_with("http://127.0.0.1");
    let token_shaped = token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
    if !loopback || !token_shaped {
        return Err("Invalid sidecar descriptor.".to_string());
    }
    let pid = instance.get("pid").and_then(Json::as_i64).unwrap_or(0);
    if !alive(pid) {
        return Ok(None);
    }
    let health = http_get(url, token, "/health")
        .map_err(|error| format!("Existing sidecar PID {pid} is alive but unavailable: {error}. No second sidecar was started."))?;
    let _ = health;
    Ok(Some(instance))
}

fn real(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

struct Found {
    directory: PathBuf,
    instance: Json,
    root: Json,
    scanned: Vec<PathBuf>,
}

fn find_instance(project: &str, state: Option<&str>, home: &str) -> Result<Found, String> {
    let scanned = state_directories(state, home);
    let target = real(project);
    let mut claims: Vec<Found> = vec![];
    let mut problems: Vec<String> = vec![];
    for directory in &scanned {
        let instance = match discover(directory) {
            Ok(Some(instance)) => instance,
            Ok(None) => continue,
            Err(message) => {
                problems.push(format!("{}: {message}", directory.display()));
                continue;
            }
        };
        let url = instance.get("url").and_then(Json::as_str).unwrap_or("").to_string();
        let token = instance.get("token").and_then(Json::as_str).unwrap_or("").to_string();
        let state_json = match http_get(&url, &token, "/api/state") {
            Ok(value) => value,
            Err(message) => {
                problems.push(format!("{}: {message}", directory.display()));
                continue;
            }
        };
        for root in state_json.get("roots").and_then(Json::as_array).cloned().unwrap_or_default() {
            if real(root.get("path").and_then(Json::as_str).unwrap_or("")) == target {
                claims.push(Found { directory: directory.clone(), instance: instance.clone(), root, scanned: vec![] });
            }
        }
    }
    if claims.len() > 1 {
        let lines: Vec<String> = claims
            .iter()
            .map(|claim| {
                format!(
                    "  {} — instance {} at {}, root {}",
                    claim.directory.join("sidecar.json").display(),
                    claim.instance.get("instance").and_then(Json::as_str).unwrap_or(""),
                    claim.instance.get("url").and_then(Json::as_str).unwrap_or(""),
                    claim.root.get("id").and_then(Json::as_str).unwrap_or("")
                )
            })
            .collect();
        return Err(format!(
            "Two workspace instances claim {}:\n{}\nClose one, or name the one you mean with --state DIR.",
            target.display(),
            lines.join("\n")
        ));
    }
    let Some(mut claim) = claims.pop() else {
        let scanned_lines: Vec<String> = scanned.iter().map(|d| format!("  {}", d.display())).collect();
        let unavailable = if problems.is_empty() {
            String::new()
        } else {
            format!("\nUnavailable:\n{}", problems.iter().map(|p| format!("  {p}")).collect::<Vec<_>>().join("\n"))
        };
        return Err(format!(
            "No live workspace instance serves {}. Scanned:\n{}{}\nOpen the project in rEngine first (its editor.sh), or name its state directory with --state DIR.",
            target.display(),
            scanned_lines.join("\n"),
            unavailable
        ));
    };
    claim.scanned = scanned;
    Ok(claim)
}

/* `--session` here is rEngine's OWN identifier for a bound session, not any CLI's conversation id:
   the workspace mints it as a UUID, so the shape is this command's and not a recipe's. Named for
   what it checks rather than borrowed from an agent's parser. */
fn session_uuid_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

const USAGE: &str = "red-agents bind --project DIR [--agent NAME|EXECUTABLE] [--session UUID] [--state DIR]
Binds an agent this workspace never spawned: finds the live instance that already serves DIR,
gives this agent an identity, and writes the MCP configuration to start the agent with.
The identity IS the agent's own session id: pass --session with the id the CLI resumes by
to bind the session that already exists, or omit it to have one minted.
Without --state it scans the sidecar descriptors under ${XDG_STATE_HOME:-$HOME/.local/state}/rengine.
No RENGINE_* environment variable is read; the workspace is found by discovery.";

/// The command. Returns what to print; a refusal is an Err a person reads and acts on.
pub fn bind(
    argv: &[String],
    recipes: &[(String, Value)],
    home: &str,
    inputs: &Json,
    mint: &mut dyn FnMut() -> String,
    now: &mut dyn FnMut() -> String,
) -> Result<Json, String> {
    let mut options: std::collections::BTreeMap<String, String> = Default::default();
    let mut index = 0;
    while index < argv.len() {
        let flag = argv[index].as_str();
        match flag {
            "--project" | "--agent" | "--state" | "--session" => {
                let Some(value) = argv.get(index + 1) else { return Err(format!("Missing value for {flag}")) };
                options.insert(flag[2..].to_string(), value.clone());
                index += 2;
            }
            "--help" | "-h" => return Ok(json!({ "usage": USAGE })),
            _ => return Err(format!("Unknown option: {flag}\n{USAGE}")),
        }
    }
    let Some(project) = options.get("project") else { return Err(format!("--project DIR is required.\n{USAGE}")) };
    if let Some(session) = options.get("session") {
        if !session_uuid_shape(session) {
            return Err(format!("--session takes the agent session's UUID, not {session}."));
        }
    }
    let session = options.get("session").map(|value| value.to_ascii_lowercase());
    let found = find_instance(project, options.get("state").map(String::as_str), home)?;
    let instance = &found.instance;
    let root = &found.root;
    let context = json!({
        "url": instance.get("url"), "token": instance.get("token"),
        "instance": instance.get("instance"), "rootId": root.get("id"),
    });
    let bindings = found.directory.join("bindings");
    std::fs::create_dir_all(&bindings).map_err(|error| error.to_string())?;
    let agent = options.get("agent").cloned().unwrap_or_default();
    let executable = if agent.is_empty() { "custom".to_string() } else { agent.clone() };

    let mut identity_inputs = inputs.as_object().cloned().unwrap_or_default();
    identity_inputs.insert("agent".into(), json!(agent));
    identity_inputs.insert("executable".into(), json!(executable));
    if let Some(session) = &session {
        identity_inputs.insert("session".into(), json!(session));
    }
    let identity = crate::launch::agent_identity(recipes, &Json::Object(identity_inputs.clone()), mint, now)?;

    let mut plan_inputs = identity_inputs;
    plan_inputs.insert("context".into(), context);
    plan_inputs.insert("directory".into(), json!(bindings.to_string_lossy()));
    plan_inputs.insert("identity".into(), identity.clone());
    /* A CLI whose MCP overlay is written INTO the project needs the bound root as its working
       directory, or the overlay lands wherever this command was run from. Which CLIs those are is
       the recipes' to say: `project-file` is the declared capability, not a name (F214, spec 141). */
    if crate::launch::mcp_kind(recipes, &agent).as_deref() == Some("project-file") {
        plan_inputs.insert("cwd".into(), root.get("path").cloned().unwrap_or(Json::Null));
    }
    let plan = crate::launch::launch_plan(recipes, &Json::Object(plan_inputs), mint, now)?;

    let text = |value: &Json, key: &str| value.get(key).and_then(Json::as_str).unwrap_or("").to_string();
    let mut lines = vec![
        format!("Bound to {} ({})", text(root, "name"), text(root, "path")),
        format!(
            "  instance {} at {}, discovered through {}",
            text(instance, "instance"),
            text(instance, "url"),
            found.directory.join("sidecar.json").display()
        ),
        format!("  identity {} — {} (pid {})", text(&identity, "label"), text(&identity, "agentId"),
            identity.get("pid").map(|v| v.to_string()).unwrap_or_default()),
    ];
    if let Some(described) = crate::launch::describe_session(&identity).as_str() {
        lines.push(format!("  {described}"));
    }
    lines.push(format!("  context  {}", text(&plan, "contextFile")));
    lines.push(format!("  MCP configuration {}", text(&plan, "generic")));
    if let Some(written) = plan.get("projectFile").and_then(Json::as_str) {
        lines.push(format!("  project MCP {written} (rEngine owns only the {} entry)", text(&plan, "name")));
    }
    if plan.get("custom").and_then(Json::as_bool).unwrap_or(false) {
        /* claude and codex consume this configuration as it stands; gemini, opencode and kimi need
           an overlay written for them, which bind writes only for the CLI the caller names. The
           claude line carries --settings too, so a session started outside the workspace reports its
           own conversation back the way a pane does: the identity here is the launch's guess until
           the CLI confirms or corrects it. */
        let generic = text(&plan, "generic");
        let name = text(&plan, "name");
        let context_file = text(&plan, "contextFile");
        let settings = crate::launch::per_launch_settings(
            inputs.get("redAgents").and_then(Json::as_str).unwrap_or("red-agents"), &context_file, cfg!(windows));
        let settings_file = crate::launch::write_private(
            &std::path::Path::new(text(&plan, "directory").as_str()).join("settings.json"), &settings)?;
        let node = inputs.get("nodeExecutable").and_then(Json::as_str).unwrap_or("node");
        let mcp_main = inputs.get("mcpMain").and_then(Json::as_str).unwrap_or("");
        let agent_id = text(&identity, "agentId");
        let quote = crate::launch::shell_quote;
        lines.push(format!("Start the agent from {} with the flag its CLI consumes:", text(root, "path")));
        lines.push(format!(
            "  claude --mcp-config {} --settings {} {} {agent_id}",
            quote(&generic), quote(&settings_file), if session.is_some() { "--resume" } else { "--session-id" }
        ));
        lines.push(format!(
            "  codex {}",
            [
                "-c".to_string(), format!("mcp_servers.{name}.command={}", json!(node)),
                "-c".to_string(), format!("mcp_servers.{name}.args={}", json!([mcp_main, "--context", context_file])),
                "-c".to_string(), format!("mcp_servers.{name}.required=true"),
            ].iter().map(|part| quote(part)).collect::<Vec<_>>().join(" ")
        ));
        lines.push("  gemini, opencode: re-run with --agent gemini or --agent opencode, which writes the overlay those CLIs read.".into());
        lines.push("  kimi: re-run with --agent kimi, which writes the project .kimi-code/mcp.json the CLI reads.".into());
    } else {
        lines.push(format!("Start the agent from {} with:", text(root, "path")));
        let args: Vec<String> = plan
            .get("args")
            .and_then(Json::as_array)
            .map(|values| values.iter().filter_map(Json::as_str).map(crate::launch::shell_quote).collect())
            .unwrap_or_default();
        lines.push(format!("  {} {}", text(&plan, "executable"), args.join(" ")));
    }
    Ok(json!({
        "instance": instance, "root": root, "identity": identity, "plan": plan,
        "report": lines.join("\n"),
    }))
}
