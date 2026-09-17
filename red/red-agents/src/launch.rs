//! The launch plan, ported from `agents/config.mjs` (F173, F149c, spec 129).
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
    recipe_of(recipes, cli).map(crate::view)
}
/// A recipe's whole conversation view. Public because `parse` on the CLI must read a recipe
/// exactly as a launch does, or the two could disagree about the same declaration.
pub fn conversation_of(recipes: &[(String, Value)], cli: &str) -> Option<Json> {
    talk_of(recipes, cli)
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

/// The environment variables every declared CLI stamps on its children, as a union in declaration
/// order. A pane must inherit NONE of them: it is a fresh top-level session, nobody's child
/// (KI-113, F220). Which variables those are is each CLI's to declare.
pub fn process_identity(recipes: &[(String, Value)]) -> Vec<String> {
    let mut named: Vec<String> = Vec::new();
    for (cli, _) in recipes {
        let Some(view) = projected(recipes, cli) else { continue };
        for value in view.get("identity").and_then(|block| block.get("vars")).and_then(Json::as_array).into_iter().flatten() {
            if let Some(name) = value.as_str() {
                if !named.iter().any(|seen| seen == name) {
                    named.push(name.to_string());
                }
            }
        }
    }
    named
}

/// Where the declared CLIs install themselves, relative to a person's home directory, in
/// declaration order. A launch puts these on PATH so a CLI its own installer placed is found.
pub fn install_paths(recipes: &[(String, Value)]) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for (cli, _) in recipes {
        let Some(view) = projected(recipes, cli) else { continue };
        if let Some(path) = view.get("install").and_then(|block| block.get("path")).and_then(Json::as_str) {
            if !paths.iter().any(|seen| seen == path) {
                paths.push(path.to_string());
            }
        }
    }
    paths
}

/// How to start this CLI BY HAND against a binding rEngine has already written — the line `bind`
/// prints when the caller named an agent rEngine has no recipe for (F218, spec 141).
///
/// `None` when this CLI's overlay must be WRITTEN for it rather than handed to it: there is no line
/// to print, because the binding does not exist until a launch writes it, and the honest answer is
/// "re-run naming this CLI". Every spelling in the line is the recipe's — bind used to write these
/// out per agent, which meant a recipe could change its flag and the printed hint would go on
/// confidently telling a person the old one.
pub fn start_hint(recipes: &[(String, Value)], cli: &str, paths: &Json) -> Option<String> {
    let declared = projected(recipes, cli)?;
    let mcp = declared.get("mcp")?;
    let kind = mcp.get("kind").and_then(Json::as_str)?;
    let flag = mcp.get("flag").and_then(Json::as_str)?;
    let at = |key: &str| text(paths, key).unwrap_or("").to_string();
    let quote = shell_quote;
    let mut parts: Vec<String> = vec![cli.to_string()];
    match kind {
        "flag" => {
            parts.extend([flag.to_string(), quote(&at("generic"))]);
            /* A CLI handed per-launch settings is handed the flag its recipe spells them with, so a
               session started outside the workspace reports its own conversation back the way a pane
               does — the identity here is the launch's guess until the CLI confirms it. */
            if let Some(hook_flag) = declared.get("hooks").and_then(|hooks| hooks.get("flag")).and_then(Json::as_str) {
                parts.extend([hook_flag.to_string(), quote(&at("settings"))]);
            }
        }
        "config-args" => {
            let name = at("name");
            for entry in [
                format!("mcp_servers.{name}.command={}", json!(at("node"))),
                format!("mcp_servers.{name}.args={}", json!([at("mcpMain"), "--context", at("contextFile")])),
                format!("mcp_servers.{name}.required=true"),
            ] {
                parts.extend([flag.to_string(), quote(&entry)]);
            }
        }
        _ => return None,
    }
    /* Which conversation, spelled the way this recipe spells it: the resume flag when one was named,
       the start flag when rEngine is naming a fresh one, and neither when it declares no start. */
    let talk = talk_of(recipes, cli);
    let resuming = paths.get("resume").and_then(Json::as_bool).unwrap_or(false);
    if let Some(talk) = &talk {
        let side = if resuming { "resume" } else { "start" };
        let spelling = talk.get(side).and_then(|value| value.get("args")).and_then(Json::as_array);
        if let Some(first) = spelling.and_then(|args| args.first()).and_then(Json::as_str) {
            parts.extend([first.to_string(), at("agentId")]);
        }
    }
    Some(parts.join(" "))
}

/// How this CLI is handed the brief a spawn carries — the KIND, so a caller asks what a CLI takes
/// rather than who it is (F221, spec 149).
///
/// `Err` when the recipe declares none, and the refusal is the point: a brief is not a neutral thing
/// to append to a command line. A CLI with subcommands reads the first bare word as the subcommand,
/// so an undeclared CLI handed one does not ignore it — it exits on it, about two seconds after a
/// person watched the pane open. Refusing by name is the same treatment `model_args` gives a CLI
/// whose model flag rEngine does not know.
pub fn prompt_delivery(recipes: &[(String, Value)], cli: &str) -> Result<String, String> {
    projected(recipes, cli)
        .and_then(|recipe| recipe.get("prompt").and_then(|prompt| prompt.get("kind")).and_then(Json::as_str).map(str::to_string))
        .ok_or_else(|| format!(
            "rEngine does not know how {cli} is handed the brief for a task, so it will not append it to the command line: a CLI that reads a bare word as a subcommand exits on it. Declare how {cli} takes an initial prompt, or spawn a CLI that has. Nothing was started."
        ))
}

/// Which MCP overlay this recipe declares — the capability, so callers ask what a CLI needs rather
/// than who it is.
pub fn mcp_kind(recipes: &[(String, Value)], cli: &str) -> Option<String> {
    projected(recipes, cli)
        .and_then(|recipe| recipe.get("mcp").and_then(|mcp| mcp.get("kind")).and_then(Json::as_str).map(str::to_string))
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
    text(talk, "ids").is_some_and(|pattern| crate::id_matches(pattern, id))
}

/// What this CLI can be handed, as its recipe declares it: `{ kind, ready }`, or `None` when it
/// declares nothing — which is an honest "this CLI has not said it can be handed a conversation",
/// not a judgement about who it is (F216, spec 141).
pub fn conversation_handoff(recipes: &[(String, Value)], cli: &str) -> Option<Json> {
    talk_of(recipes, cli)
        .and_then(|talk| talk.get("handoff").cloned())
        .filter(|value| !value.is_null())
}

/// The shape this CLI's conversation ids take, as its recipe declares it. Public so a component
/// that persists conversations can be handed the rule instead of containing it (F215, spec 141).
pub fn conversation_ids(recipes: &[(String, Value)], cli: &str) -> Option<String> {
    talk_of(recipes, cli).and_then(|talk| text(&talk, "ids").map(str::to_string))
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
    /* The recipe's own `conversation.read` block decides this — a spelling, not a name. The arms
       here used to be one per parser name, which is one per agent wearing a different hat. */
    let parsed = crate::parsers::read(talk, args).unwrap_or((None, "minted"));
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

pub fn write_private(path: &std::path::Path, value: &Json) -> Result<String, String> { private_json(path, value) }
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

/// The JSON a person's own configuration is written in, which is JSONC: the JS this replaces read
/// these two overlays with a comment-and-trailing-comma-tolerant parser, and a strict one would
/// refuse a file that has always been accepted — "existing configuration was preserved" is a
/// refusal to launch, so the tolerance is load-bearing rather than a nicety.
fn parse_jsonc(text: &str) -> Result<Json, String> {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let (mut in_string, mut escaped) = (false, false);
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escaped { escaped = false; } else if c == '\\' { escaped = true; } else if c == '"' { in_string = false; }
            continue;
        }
        match c {
            '"' => { in_string = true; out.push(c); }
            '/' if chars.peek() == Some(&'/') => { for n in chars.by_ref() { if n == '\n' { out.push('\n'); break; } } }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut previous = '\0';
                for n in chars.by_ref() {
                    if previous == '*' && n == '/' { break; }
                    previous = n;
                }
                out.push(' ');
            }
            _ => out.push(c),
        }
    }
    /* A comma before a closing brace or bracket, outside a string. */
    let bytes: Vec<char> = out.chars().collect();
    let mut cleaned = String::with_capacity(out.len());
    let (mut in_string, mut escaped) = (false, false);
    for (index, c) in bytes.iter().enumerate() {
        if in_string {
            cleaned.push(*c);
            if escaped { escaped = false; } else if *c == '\\' { escaped = true; } else if *c == '"' { in_string = false; }
            continue;
        }
        if *c == '"' { in_string = true; cleaned.push(*c); continue; }
        if *c == ',' {
            if let Some(next) = bytes[index + 1..].iter().find(|n| !n.is_whitespace()) {
                if *next == '}' || *next == ']' { continue; }
            }
        }
        cleaned.push(*c);
    }
    serde_json::from_str(&cleaned).map_err(|error| error.to_string())
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

/// The settings a `per-launch-settings` CLI is handed for this launch: a SessionStart hook that
/// reports the conversation back, so a session started outside the workspace still names itself.
pub fn per_launch_settings(red_agents: &str, context_file: &str, windows: bool) -> Json {
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

    /* What starts this pane's MCP server, as an argv PREFIX. `mcpCommand` is the whole of it and
       wins where it is given; `mcpMain` is the older shape, which named a script for an interpreter
       to run and is kept because the frozen record (`agents-fixtures.json`, F173) is taken through
       it. A native server cannot be expressed as `mcpMain`: it would compose `node /path/to/binary`,
       which is a server that cannot start, in a file a person reads (spec 146). */
    let node = text(inputs, "nodeExecutable").unwrap_or("node");
    let mcp_main = text(inputs, "mcpMain").unwrap_or("");
    let prefix: Vec<String> = match inputs.get("mcpCommand").and_then(Json::as_array) {
        Some(items) if !items.is_empty() => items.iter().filter_map(Json::as_str).map(str::to_string).collect(),
        _ => vec![node.to_string(), mcp_main.to_string()],
    };
    let (server_command, leading) = prefix.split_first().map(|(head, rest)| (head.clone(), rest.to_vec())).unwrap_or_default();
    /* One composer, because four overlays write this same server entry in four spellings and a
       fifth that disagreed with them would be a pane whose MCP server is a different process. */
    let server_args = |file: &str| -> Vec<Json> {
        leading.iter().cloned().map(Json::String).chain([json!("--context"), json!(file)]).collect()
    };
    let server_argv = |file: &str| -> Vec<Json> {
        std::iter::once(Json::String(server_command.clone())).chain(server_args(file)).collect()
    };
    let server = json!({ "type": "stdio", "command": server_command, "args": server_args(&bound_file) });
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

    /* The flag a CLI consumes its configuration with, for the two overlays that HAND it one rather
       than writing a file for it. The kind is rEngine's; the spelling is the recipe's (F214). */
    let consume_flag = declared.get("mcp").and_then(|mcp| mcp.get("flag")).and_then(Json::as_str);
    match overlay {
        "config-args" => {
            let Some(flag) = consume_flag else {
                return Err(format!("Recipe {agent} takes its MCP configuration as config arguments but does not declare which flag carries them."));
            };
            consume_args = vec![
                flag.into(), format!("mcp_servers.{name}.command={}", server["command"]),
                flag.into(), format!("mcp_servers.{name}.args={}", server["args"]),
                flag.into(), format!("mcp_servers.{name}.required=true"),
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
                    flag.into(), "features.hooks=true".into(),
                    flag.into(), format!(
                        "hooks.SessionStart=[{{matcher=\"startup|resume\",hooks=[{{type=\"command\",command={}}}]}}]",
                        json!(command)
                    ),
                    flag.into(), format!(
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
                let settings = private_json(&home.join("settings.json"), &per_launch_settings(red_agents, &bound_file, windows))?;
                plan.insert("settings".into(), json!(settings));
            }
            /* The IDE answer is the caller's: probing for a published editor is a scan of the
               filesystem and a port, which stays where it already is (owner, 2026-09-13). */
            if declared.get("ide").map(|value| !value.is_null()).unwrap_or(false) {
                if let Some(ide) = inputs.get("ide").filter(|value| !value.is_null()) {
                    plan.insert("ide".into(), ide.clone());
                }
            }
            let Some(flag) = consume_flag else {
                return Err(format!("Recipe {agent} consumes its MCP configuration by flag but does not declare which flag."));
            };
            consume_args = vec![flag.to_string(), generic.clone()];
            if let Some(settings) = plan.get("settings").and_then(Json::as_str) {
                let settings_flag = declared.get("hooks").and_then(|hooks| hooks.get("flag")).and_then(Json::as_str);
                let Some(settings_flag) = settings_flag else {
                    return Err(format!("Recipe {agent} is handed per-launch settings but does not declare which flag carries them."));
                };
                consume_args.extend([settings_flag.to_string(), settings.to_string()]);
            }
            consume_args.extend(strings(plan.get("ide").and_then(|ide| ide.get("flags"))));
            consume_args.extend(conversation_args(recipes, agent, &identity, resume));
        }
        "env-inline" => {
            let var = declared["mcp"]["envVar"].as_str().unwrap_or("");
            let previous: Json = match env.get(var).and_then(Json::as_str).filter(|text| !text.is_empty()) {
                Some(text) => parse_jsonc(text)
                    .map_err(|_| format!("Invalid {var} runtime configuration; existing configuration was preserved."))?,
                None => json!({}),
            };
            let mut merged = previous.as_object().cloned().unwrap_or_default();
            merged.insert(
                "mcp".into(),
                add(previous.get("mcp"), &name, json!({ "type": "local", "command": server_argv(&bound_file), "enabled": true }))?,
            );
            consume_env.insert(var.to_string(), json!(serde_json::to_string(&Json::Object(merged)).map_err(|e| e.to_string())?));
        }
        "env-defaults" => {
            let Some(var) = declared.get("mcp").and_then(|mcp| mcp.get("pathVar")).and_then(Json::as_str) else {
                return Err(format!("Recipe {agent} reads its MCP servers from a defaults file but does not declare which variable names it."));
            };
            let defaults = env.get(var).and_then(Json::as_str).unwrap_or("").to_string();
            let previous: Json = match std::fs::read_to_string(&defaults) {
                Ok(text) => parse_jsonc(&text)
                    .map_err(|_| format!("Invalid system defaults in {defaults}; existing configuration was preserved."))?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({}),
                Err(error) => return Err(format!("cannot read {defaults}: {error}")),
            };
            let mut merged = previous.as_object().cloned().unwrap_or_default();
            merged.insert(
                "mcpServers".into(),
                add(previous.get("mcpServers"), &name, json!({ "command": server_command, "args": server_args(&bound_file) }))?,
            );
            let Some(name) = declared.get("mcp").and_then(|mcp| mcp.get("path")).and_then(Json::as_str) else {
                return Err(format!("Recipe {agent} writes a defaults file but does not declare what it is called."));
            };
            let written = private_json(&home.join(name), &Json::Object(merged))?;
            consume_env.insert(var.to_string(), json!(written));
        }
        "project-file" => {
            /* Some CLIs read their MCP servers from a file inside the project rather than from a
               flag or the environment. The recipe says WHICH file; this knows only that it sits at
               the repository root rather than wherever the launch happened to run. rEngine owns only
               its own `rengine_` entries there: everything else in the file is somebody's and is
               preserved, and a previous launch's entry is replaced rather than accumulated. */
            let Some(relative) = declared.get("mcp").and_then(|mcp| mcp.get("path")).and_then(Json::as_str) else {
                return Err(format!("Recipe {agent} writes its MCP overlay into the project but does not declare which file."));
            };
            let start = text(inputs, "cwd").filter(|value| !value.is_empty()).unwrap_or(".");
            let mut root = std::path::PathBuf::from(start);
            let mut walk = root.clone();
            loop {
                if walk.join(".git").exists() { root = walk; break; }
                match walk.parent() {
                    Some(parent) if parent != walk => walk = parent.to_path_buf(),
                    _ => { root = std::path::PathBuf::from(start); break; }
                }
            }
            let file = relative.split('/').fold(root, |path, part| path.join(part));
            let previous: Json = match std::fs::read_to_string(&file) {
                Ok(text) => parse_jsonc(&text).map_err(|_| format!("Invalid MCP configuration in {}; existing configuration was preserved.", file.display()))?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({}),
                Err(error) => return Err(format!("cannot read {}: {error}", file.display())),
            };
            let existing = previous.get("mcpServers");
            if let Some(value) = existing {
                if !value.is_object() && !value.is_null() {
                    return Err(format!("Existing MCP configuration in {} is not an object; it was preserved.", file.display()));
                }
            }
            let mut servers = Map::new();
            for (key, value) in existing.and_then(Json::as_object).cloned().unwrap_or_default() {
                if !key.starts_with("rengine_") { servers.insert(key, value); }
            }
            servers.insert(name.clone(), json!({ "command": server_command, "args": server_args(&bound_file) }));
            let mut merged = previous.as_object().cloned().unwrap_or_default();
            merged.insert("mcpServers".into(), Json::Object(servers));
            let directory = file.parent().expect("the declared path names a file");
            std::fs::create_dir_all(directory)
                .map_err(|error| format!("cannot make {}: {error}", directory.display()))?;
            plan.insert("projectFile".into(), json!(private_json(&file, &Json::Object(merged))?));
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
