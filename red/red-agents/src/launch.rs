//! The launch plan, ported from `orchestrator/agents/config.mjs` (F173, F149c, spec 129).
//!
//! Owner decision, 2026-09-13: the DECISIONS live here and the environment-dependent inputs are
//! supplied by the caller — the root context, the workspace's session list and the IDE probe's
//! answer arrive as JSON, so nothing here opens a socket or scans for a lockfile. What it does own
//! is every choice the launcher makes: which MCP overlay a CLI takes, what the codex hook layer
//! carries, which conversation this pane claims, and the per-launch files that say so.
//!
//! The "cooked" view `registry.mjs` built — a compiled RegExp, bound parser functions, a resume
//! line — is derived here from the same projection rather than carried across the process boundary,
//! because functions are not something JSON can hold.

use serde_json::{json, Map, Value as Json};

use crate::Value;

/* ---- the cooked view, derived rather than carried ------------------------------------------ */

fn recipe_of<'a>(recipes: &'a [(String, Value)], cli: &str) -> Option<&'a Value> {
    recipes.iter().find(|(name, _)| name == cli).map(|(_, raw)| raw)
}
fn projected(recipes: &[(String, Value)], cli: &str) -> Option<Json> {
    recipe_of(recipes, cli).map(crate::project)
}
fn talk_of(recipes: &[(String, Value)], cli: &str) -> Option<Json> {
    projected(recipes, cli).and_then(|r| r.get("conversation").cloned()).filter(|v| !v.is_null())
}
fn text<'a>(value: &'a Json, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Json::as_str)
}
fn strings(value: Option<&Json>) -> Vec<String> {
    value
        .and_then(Json::as_array)
        .map(|items| items.iter().filter_map(Json::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// `agentCli`: the recipe's name when there is one, else the executable's basename.
pub fn agent_cli(recipes: &[(String, Value)], agent: &str, executable: Option<&str>) -> String {
    if recipe_of(recipes, agent).is_some() {
        return agent.to_string();
    }
    let raw = executable.filter(|value| !value.is_empty()).unwrap_or(agent);
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let trimmed = ["exe", "cmd", "bat"]
        .iter()
        .find_map(|extension| {
            let suffix = format!(".{extension}");
            base.to_ascii_lowercase().ends_with(&suffix).then(|| base[..base.len() - suffix.len()].to_string())
        })
        .unwrap_or_else(|| base.to_string());
    if trimmed.is_empty() { "agent".to_string() } else { trimmed }
}

/// `shortAgentId`: the recipe's short form — a prefix stripped, then the declared length. The
/// prefix matters: every kimi id starts `session_`, which would otherwise be all eight characters.
pub fn short_agent_id(recipes: &[(String, Value)], agent: &str, id: &str) -> String {
    let Some(talk) = talk_of(recipes, agent) else {
        return id.chars().take(8).collect();
    };
    let short = talk.get("short").cloned().unwrap_or(Json::Null);
    let stripped = match short.get("stripPrefix").and_then(Json::as_str) {
        Some(prefix) if !prefix.is_empty() && id.to_ascii_lowercase().starts_with(&prefix.to_ascii_lowercase()) => &id[prefix.len()..],
        _ => id,
    };
    let length = short.get("length").and_then(Json::as_u64).unwrap_or(8) as usize;
    stripped.chars().take(length).collect()
}

pub fn agent_label(recipes: &[(String, Value)], agent: &str, executable: Option<&str>, agent_id: Option<&str>) -> String {
    let cli = agent_cli(recipes, agent, executable);
    match agent_id.filter(|id| !id.is_empty()) {
        Some(id) => format!("{cli} {}", short_agent_id(recipes, agent, id)),
        None => cli,
    }
}

fn resume_line(recipes: &[(String, Value)], provider: &str, id: &str) -> Option<String> {
    talk_of(recipes, provider)
        .and_then(|talk| text(&talk, "resumeLine").map(|line| line.replace("{id}", id)))
}

/// The identity IS the agent's session id, so the launcher can hand back the line that resumes it.
pub fn session_of(recipes: &[(String, Value)], provider: &str, id: &str, source: &str) -> Json {
    json!({
        "provider": provider,
        "id": id,
        "known": source != "unknown",
        "source": source,
        "resume": resume_line(recipes, provider, id).unwrap_or_default(),
    })
}

fn normalize(talk: &Json, id: &str) -> String {
    match text(talk, "normalize") {
        Some("lowercase") => id.to_ascii_lowercase(),
        _ => id.to_string(),
    }
}
fn ids_match(talk: &Json, id: &str) -> bool {
    /* The recipe names the shape by its parser rather than by a regex engine this crate does not
       have: the two shapes the document uses are the ones parsers.rs already recognises. */
    match text(talk, "ids") {
        Some(pattern) if pattern.contains("{26}") => crate::parsers::ulid_shape(id),
        Some(_) => crate::parsers::uuid_shape(id) || id.starts_with("session_") && crate::parsers::uuid_shape(&id[8..]),
        None => false,
    }
}

/// `conversationArgs`: exactly one identifier is ever named, and only when rEngine names it.
pub fn conversation_args(recipes: &[(String, Value)], agent: &str, identity: &Json, resume: bool) -> Vec<String> {
    let Some(talk) = talk_of(recipes, agent) else { return vec![] };
    let Some(session) = identity.get("session").filter(|value| !value.is_null()) else { return vec![] };
    if text(session, "provider") != Some(agent) {
        return vec![];
    }
    let id = text(session, "id").unwrap_or("").to_string();
    let with = |key: &str| {
        let mut args = strings(talk.get(key).and_then(|value| value.get("args")));
        args.push(id.clone());
        args
    };
    match text(session, "source") {
        Some("bound") => with("resume"),
        Some("minted") | Some("workspace") => {
            if resume {
                with("resume")
            } else if talk.get("start").map(|value| !value.is_null()).unwrap_or(false) {
                with("start")
            } else {
                vec![]
            }
        }
        _ => vec![],
    }
}

pub fn describe_session(identity: &Json) -> Json {
    let Some(session) = identity.get("session").filter(|value| !value.is_null()) else { return Json::Null };
    let provider = text(session, "provider").unwrap_or("");
    let id = text(session, "id").unwrap_or("");
    if session.get("known").and_then(Json::as_bool).unwrap_or(false) {
        json!(format!(
            "{provider} session {id}; resume this agent with: {}",
            text(session, "resume").unwrap_or("")
        ))
    } else {
        json!(format!(
            "{provider} session id unknown: this launch continues or forks a conversation the CLI names itself, so the identity {} is rEngine's own and no resume line is offered.",
            text(identity, "agentId").unwrap_or("")
        ))
    }
}

/* ---- the identity ---------------------------------------------------------------------------- */

fn parse_named(talk: &Json, args: &[String]) -> (Option<String>, String) {
    let parsed = match text(talk, "parser") {
        Some("claude-flags") => crate::parsers::claude_flags(args),
        Some("kimi-flags") => crate::parsers::kimi_flags(args),
        Some("codex-resume") => crate::parsers::codex_resume(args),
        _ => (None, "minted"),
    };
    (parsed.0, parsed.1.to_string())
}

/// Where the id comes from, in the order that decides it. The person's own flags win over the
/// workspace's, because the pane reports back what actually launched.
fn recipe_identity(talk: &Json, inputs: &Json) -> Result<(Option<String>, String), String> {
    let args = strings(inputs.get("args"));
    let (named_id, named_source) = parse_named(talk, &args);
    if named_id.is_some() || named_source == "unknown" {
        return Ok((named_id, named_source));
    }
    let bound = inputs
        .get("session")
        .and_then(Json::as_str)
        .or_else(|| inputs.get("handoff").and_then(|h| h.get("sessionId")).and_then(Json::as_str));
    if let Some(bound) = bound.filter(|value| !value.is_empty()) {
        return Ok((Some(bound.to_string()), "bound".to_string()));
    }
    if let Some(conversation) = inputs.get("conversation").filter(|value| !value.is_null()) {
        let Some(conversation) = conversation.as_str().filter(|value| ids_match(talk, value)) else {
            return Err(format!(
                "An agent conversation must be a session id in a shape {} resumes by.",
                text(talk, "provider").unwrap_or("this CLI")
            ));
        };
        let claimable = talk.get("start").map(|value| !value.is_null()).unwrap_or(false)
            || inputs.get("resume").and_then(Json::as_bool).unwrap_or(false);
        return Ok(if claimable {
            (Some(normalize(talk, conversation)), "workspace".to_string())
        } else {
            (None, "minted".to_string())
        });
    }
    Ok((None, "minted".to_string()))
}

/// `agentIdentity`. `mint` and `now` are the caller's so a harness can freeze them, exactly as the
/// store service takes its own.
pub fn agent_identity(
    recipes: &[(String, Value)],
    inputs: &Json,
    mint: &mut dyn FnMut() -> String,
    now: &mut dyn FnMut() -> String,
) -> Result<Json, String> {
    let agent = text(inputs, "agent").unwrap_or("");
    let executable = text(inputs, "executable");
    let talk = talk_of(recipes, agent);
    let resolved = match &talk {
        Some(talk) => Some(recipe_identity(talk, inputs)?),
        None => None,
    };
    let session_input = inputs.get("session").and_then(Json::as_str);
    let agent_id = resolved
        .as_ref()
        .and_then(|(id, _)| id.clone())
        .or_else(|| session_input.map(str::to_string))
        .unwrap_or_else(mint);
    let mut identity = Map::new();
    identity.insert("agentId".into(), json!(agent_id));
    identity.insert("label".into(), json!(agent_label(recipes, agent, executable, Some(&agent_id))));
    identity.insert("pid".into(), inputs.get("pid").cloned().unwrap_or(Json::Null));
    identity.insert("startedAt".into(), json!(now()));
    /* A launch that names nothing claims nothing: a session object here would invent a conversation
       rEngine cannot resume — unless the recipe has a start spelling, because then the minted id is
       told to the CLI at launch. */
    match (&resolved, &talk) {
        (Some((Some(id), source)), _) => {
            identity.insert("session".into(), session_of(recipes, agent, id, source));
        }
        (Some((None, source)), _) if source == "unknown" => {
            identity.insert("session".into(), session_of(recipes, agent, &agent_id, "unknown"));
        }
        (_, Some(talk)) if talk.get("start").map(|value| !value.is_null()).unwrap_or(false) => {
            identity.insert("session".into(), session_of(recipes, agent, &agent_id, "minted"));
        }
        _ => {}
    }
    /* The PTY this launch runs in, when the caller found one. On Windows the JS never looked. */
    if let Some(session_id) = inputs.get("ptySessionId").and_then(Json::as_str) {
        identity.insert("sessionId".into(), json!(session_id));
    }
    Ok(Json::Object(identity))
}

/* ---- the launch plan ------------------------------------------------------------------------- */

fn private_json(path: &std::path::Path, value: &Json) -> Result<String, String> {
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    std::fs::write(path, text).map_err(|error| format!("cannot write {}: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("cannot secure {}: {error}", path.display()))?;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Refuses rather than replaces: an entry already under this name is somebody else's.
fn add(values: Option<&Json>, key: &str, value: Json) -> Result<Json, String> {
    let map = match values {
        None | Some(Json::Null) => Map::new(),
        Some(Json::Object(existing)) => {
            if existing.contains_key(key) {
                return Err(format!("Existing configuration already defines {key}; refusing to replace it."));
            }
            existing.clone()
        }
        Some(_) => return Err("Existing MCP configuration is not an object.".to_string()),
    };
    let mut map = map;
    map.insert(key.to_string(), value);
    Ok(Json::Object(map))
}

pub fn shell_quote(value: &str) -> String {
    let plain = !value.is_empty()
        && value.chars().all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c));
    if plain { value.to_string() } else { format!("'{}'", value.replace('\'', "'\\''")) }
}
/* Claude runs the hook through a shell, and that shell is cmd on Windows, where POSIX single
   quotes are literal characters rather than quoting. */
fn hook_quote(value: &str, windows: bool) -> String {
    if !windows {
        return shell_quote(value);
    }
    let plain = !value.is_empty()
        && value.chars().all(|c| c.is_ascii_alphanumeric() || "_@%+=:,.\\/-".contains(c));
    if plain { value.to_string() } else { format!("\"{}\"", value.replace('"', "\"\"")) }
}

pub fn claude_settings(red_agents: &str, context_file: &str, windows: bool) -> Json {
    let command = [red_agents, "report-session", "--context", context_file]
        .iter()
        .map(|part| hook_quote(part, windows))
        .collect::<Vec<_>>()
        .join(" ");
    json!({ "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": command }] }] } })
}

/// `agentLaunch`. Everything environment-dependent arrives in `inputs`; every decision is made here.
pub fn launch_plan(
    recipes: &[(String, Value)],
    inputs: &Json,
    mint: &mut dyn FnMut() -> String,
    now: &mut dyn FnMut() -> String,
) -> Result<Json, String> {
    let agent = text(inputs, "agent").unwrap_or("");
    let executable = text(inputs, "executable").unwrap_or("");
    let windows = text(inputs, "platform") == Some("win32");
    let root = inputs.get("context").cloned().unwrap_or(Json::Null);
    let root_id = text(&root, "rootId").unwrap_or("");
    if root_id.len() != 36 || !root_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err("Invalid project identity in workspace context.".to_string());
    }
    let name = format!("rengine_{}", root_id.replace('-', "").chars().take(12).collect::<String>());
    let parent = text(inputs, "directory")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| text(inputs, "contextFile").and_then(|file| std::path::Path::new(file).parent().map(std::path::Path::to_path_buf)))
        .ok_or_else(|| "A launch needs a directory or a context file.".to_string())?;
    let home = parent.join(format!("{name}-{}", mint()));
    std::fs::create_dir_all(&home).map_err(|error| format!("cannot make {}: {error}", home.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700));
    }

    let identity = match inputs.get("identity").filter(|value| !value.is_null()) {
        Some(given) => given.clone(),
        None => agent_identity(recipes, inputs, mint, now)?,
    };
    let mut bound_context = root.as_object().cloned().unwrap_or_default();
    bound_context.insert("agent".into(), identity.clone());
    let bound_file = private_json(&home.join("context.json"), &Json::Object(bound_context))?;

    let node = text(inputs, "nodeExecutable").unwrap_or("node");
    let mcp_main = text(inputs, "mcpMain").unwrap_or("");
    let server = json!({ "type": "stdio", "command": node, "args": [mcp_main, "--context", bound_file] });
    let generic = private_json(&home.join("mcp.json"), &json!({ "mcpServers": { name.clone(): server.clone() } }))?;

    let mut plan = Map::new();
    plan.insert("executable".into(), json!(executable));
    plan.insert("name".into(), json!(name));
    plan.insert("generic".into(), json!(generic));
    plan.insert("identity".into(), identity.clone());
    plan.insert("contextFile".into(), json!(bound_file));
    plan.insert("directory".into(), json!(home.to_string_lossy()));

    let declared = projected(recipes, agent).unwrap_or(Json::Null);
    let overlay = declared.get("mcp").and_then(|mcp| mcp.get("kind")).and_then(Json::as_str).unwrap_or("");
    let hooks_kind = declared.get("hooks").and_then(|h| h.get("kind")).and_then(Json::as_str).unwrap_or("");
    let red_agents = text(inputs, "redAgents").unwrap_or("red-agents");
    let env = inputs.get("env").cloned().unwrap_or_else(|| json!({}));
    let resume = inputs.get("resume").and_then(Json::as_bool).unwrap_or(false);
    let mut consume_args: Vec<String> = vec![];
    let mut consume_env = Map::new();

    match overlay {
        "config-args" => {
            consume_args = vec![
                "-c".into(), format!("mcp_servers.{name}.command={}", json!(node)),
                "-c".into(), format!("mcp_servers.{name}.args={}", server["args"]),
                "-c".into(), format!("mcp_servers.{name}.required=true"),
            ];
            /* The SessionStart hook rides the same -c channel as the MCP wiring: codex loads hooks
               from every config layer, so the person's own ~/.codex entries run beside this launch's,
               untouched. Codex runs a non-managed hook only when its exact definition is trusted, so
               the same layer carries this launch's trusted_hash — the launcher trusts what it
               composed, nothing else, and nothing is written to ~/.codex. */
            if hooks_kind == "per-launch-config" {
                let command = [red_agents, "report-session", "--provider", agent, "--context", &bound_file]
                    .iter()
                    .map(|part| hook_quote(part, windows))
                    .collect::<Vec<_>>()
                    .join(" ");
                let platform = if windows { "win32" } else { "unix" };
                consume_args.extend([
                    "-c".into(), "features.hooks=true".into(),
                    "-c".into(), format!(
                        "hooks.SessionStart=[{{matcher=\"startup|resume\",hooks=[{{type=\"command\",command={}}}]}}]",
                        json!(command)
                    ),
                    "-c".into(), format!(
                        "hooks.state={{{}={{trusted_hash={}}}}}",
                        json!(crate::hooks::hook_key(platform, 0, 0)),
                        json!(crate::hooks::hook_trust_hash(&command, "startup|resume"))
                    ),
                ]);
            }
            consume_args.extend(conversation_args(recipes, agent, &identity, resume));
        }
        "flag" => {
            if hooks_kind == "per-launch-settings" {
                let settings = private_json(&home.join("settings.json"), &claude_settings(red_agents, &bound_file, windows))?;
                plan.insert("settings".into(), json!(settings));
            }
            /* The IDE answer is the caller's: probing for a published editor is a scan of the
               filesystem and a port, which stays where it already is (owner, 2026-09-13). */
            if declared.get("ide").map(|value| !value.is_null()).unwrap_or(false) {
                if let Some(ide) = inputs.get("ide").filter(|value| !value.is_null()) {
                    plan.insert("ide".into(), ide.clone());
                }
            }
            consume_args = vec!["--mcp-config".into(), generic.clone()];
            if let Some(settings) = plan.get("settings").and_then(Json::as_str) {
                consume_args.extend(["--settings".into(), settings.to_string()]);
            }
            consume_args.extend(strings(plan.get("ide").and_then(|ide| ide.get("flags"))));
            consume_args.extend(conversation_args(recipes, agent, &identity, resume));
        }
        "env-inline" => {
            let var = declared["mcp"]["envVar"].as_str().unwrap_or("");
            let previous: Json = match env.get(var).and_then(Json::as_str).filter(|text| !text.is_empty()) {
                Some(text) => serde_json::from_str(text)
                    .map_err(|_| format!("Invalid {var} runtime configuration; existing configuration was preserved."))?,
                None => json!({}),
            };
            let mut merged = previous.as_object().cloned().unwrap_or_default();
            merged.insert(
                "mcp".into(),
                add(previous.get("mcp"), &name, json!({ "type": "local", "command": [node, mcp_main, "--context", bound_file], "enabled": true }))?,
            );
            consume_env.insert(var.to_string(), json!(serde_json::to_string(&Json::Object(merged)).map_err(|e| e.to_string())?));
        }
        "env-defaults" => {
            let declared_path = env.get("GEMINI_CLI_SYSTEM_DEFAULTS_PATH").and_then(Json::as_str).map(str::to_string);
            let defaults = declared_path.unwrap_or_else(|| text(inputs, "geminiDefaults").unwrap_or("").to_string());
            let previous: Json = match std::fs::read_to_string(&defaults) {
                Ok(text) => serde_json::from_str(&text).map_err(|_| "Invalid Gemini system defaults; existing configuration was preserved.".to_string())?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({}),
                Err(error) => return Err(format!("cannot read {defaults}: {error}")),
            };
            let mut merged = previous.as_object().cloned().unwrap_or_default();
            merged.insert(
                "mcpServers".into(),
                add(previous.get("mcpServers"), &name, json!({ "command": node, "args": [mcp_main, "--context", bound_file] }))?,
            );
            let written = private_json(&home.join("gemini-defaults.json"), &Json::Object(merged))?;
            consume_env.insert("GEMINI_CLI_SYSTEM_DEFAULTS_PATH".into(), json!(written));
        }
        "project-file" => {
            plan.insert("kimi".into(), inputs.get("kimiFile").cloned().unwrap_or(Json::Null));
            consume_args = conversation_args(recipes, agent, &identity, resume);
        }
        _ => {
            plan.insert("custom".into(), json!(true));
        }
    }

    /* What the host's record should say this pane holds. `null` is the honest answer for a launch
       that continues or forks: the identity is rEngine's own and no record may claim it names the
       conversation. An agent whose recipe declares no conversation is recorded with nothing at all. */
    if talk_of(recipes, agent).is_some() {
        let known = identity.get("session").and_then(|s| s.get("known")).and_then(Json::as_bool).unwrap_or(false);
        plan.insert("conversation".into(), if known { identity["agentId"].clone() } else { Json::Null });
    }
    let mut args = consume_args.clone();
    args.extend(strings(inputs.get("args")));
    plan.insert("consumes".into(), json!({ "args": consume_args, "env": Json::Object(consume_env.clone()) }));
    plan.insert("args".into(), json!(args));
    let mut final_env = env.as_object().cloned().unwrap_or_default();
    final_env.insert("RENGINE_MCP_CONFIG".into(), json!(generic));
    for (key, value) in consume_env {
        final_env.insert(key, value);
    }
    if let Some(ide_env) = plan.get("ide").and_then(|ide| ide.get("env")).and_then(Json::as_object) {
        for (key, value) in ide_env {
            final_env.insert(key.clone(), value.clone());
        }
    }
    plan.insert("env".into(), Json::Object(final_env));
    Ok(Json::Object(plan))
}
