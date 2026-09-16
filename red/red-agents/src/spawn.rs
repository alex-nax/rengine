//! The spawn-environment composition of the JS session host, ported (F168, spec 129, KI-092).
//!
//! `agent_pane_composition` mirrors sessions.mjs's `agentPaneComposition` byte-for-byte: the
//! pane-identity family (RENGINE_AGENT_CONVERSATION/_RESUME/_CONVERSATIONS), the workspace trio,
//! the mint/refuse/resume rules, and the bare-pane listing with `describe_age` ages. The mint and
//! the clock arrive as data so the parity fixtures decide nothing at random.
//!
//! `shell_environment` mirrors the envelope the composition travels in: the colour declaration,
//! the NO_COLOR, ELECTRON_RUN_AS_NODE and agent-process-identity scrubs, the delete-on-non-string
//! mechanism the cleared set rides on, and the PATH augmentation — so "cleared in both
//! compositions" is a fact two languages compute identically (KI-068's lesson).

use serde_json::json;

use crate::Value;

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;

/// Plain words beat a timestamp in a pane. Math.round on positive gaps, as the JS side does.
pub fn describe_age(when: i64, now: i64) -> String {
    let gap = (now - when).max(0);
    if gap < 2 * MINUTE { return "just now".to_string(); }
    if gap < HOUR { return format!("{} minutes ago", (gap as f64 / MINUTE as f64).round() as i64); }
    if gap < 2 * HOUR { return "an hour ago".to_string(); }
    if gap < DAY { return format!("{} hours ago", (gap as f64 / HOUR as f64).round() as i64); }
    if gap < 2 * DAY { return "yesterday".to_string(); }
    format!("{} days ago", (gap as f64 / DAY as f64).round() as i64)
}

type EnvMap = std::collections::BTreeMap<String, String>;

fn join_path(platform: &str, directory: &str, part: &str) -> String {
    // The simple shape path.posix.join / path.win32.join has for the inputs this function ever
    // gets: a clean directory and a relative part. win32 normalizes the part's separators.
    if platform == "win32" {
        format!("{}\\{}", directory.trim_end_matches(['\\', '/']), part.replace('/', "\\"))
    } else {
        format!("{}/{}", directory.trim_end_matches('/'), part)
    }
}

/// sessions.mjs's shellEnvironment: merge inherited, then overrides, then the colour defaults;
/// a non-string value deletes; then scrub and augment PATH. JSON null stands in for undefined.
/// `identity` is what the declared CLIs stamp on their children and `installs` is where they put
/// themselves — both unions over the recipes (`launch::process_identity`, `launch::install_paths`),
/// handed in rather than read here, because this function is pure and the recipes are data. One
/// CLI's variables used to be a constant in this file, which meant the second CLI to stamp its own
/// would have gone on marking every pane a child session of whoever started the host (KI-113, F220).
pub fn shell_environment(
    overrides: &serde_json::Map<String, serde_json::Value>,
    inherited: &serde_json::Map<String, serde_json::Value>,
    platform: &str,
    user_directory: &str,
    identity: &[String],
    installs: &[String],
) -> EnvMap {
    let win = platform == "win32";
    let key = |name: &str| if win { name.to_uppercase() } else { name.to_string() };
    // Insertion-ordered upsert, like the JS Map: setting an existing key keeps its first position.
    let mut entries: Vec<(String, (String, String))> = Vec::new();
    let mut apply = |values: &serde_json::Map<String, serde_json::Value>| {
        for (name, value) in values {
            let slot = key(name);
            if let Some(text) = value.as_str() {
                if let Some(entry) = entries.iter_mut().find(|(k, _)| *k == slot) {
                    entry.1 = (name.clone(), text.to_string());
                } else {
                    entries.push((slot, (name.clone(), text.to_string())));
                }
            } else {
                entries.retain(|(k, _)| *k != slot);
            }
        }
    };
    apply(inherited);
    apply(overrides);
    let mut defaults = serde_json::Map::new();
    defaults.insert("TERM".to_string(), json!("xterm-256color"));
    defaults.insert("COLORTERM".to_string(), json!("truecolor"));
    apply(&defaults);

    let electron = key("ELECTRON_RUN_AS_NODE");
    entries.retain(|(k, _)| *k != electron);
    // TERM/COLORTERM declare this surface colour-capable; an inherited NO_COLOR would contradict
    // that for every pane the host ever spawns; the agent identity would make the pane a child
    // session of whatever started the host. An explicit override still wins.
    let overridden: Vec<String> = overrides.keys().map(|name| key(name)).collect();
    for name in std::iter::once("NO_COLOR").chain(identity.iter().map(String::as_str)) {
        let slot = key(name);
        if !overridden.contains(&slot) {
            entries.retain(|(k, _)| *k != slot);
        }
    }

    let mut env: EnvMap = entries.iter().map(|(_, (name, value))| (name.clone(), value.clone())).collect();
    let delimiter = if win { ';' } else { ':' };
    let path_key = entries.iter().find(|(k, _)| *k == key("PATH")).map(|(_, (name, _))| name.clone())
        .unwrap_or_else(|| if win { "Path".to_string() } else { "PATH".to_string() });
    /* The places a CLI's own installer puts it, declared by the recipes, plus the two generic ones
       a person's tools land in. Order is preserved: declared first, as it always was. */
    let extra: Vec<String> = [".local/bin", ".n/bin"]
        .iter()
        .map(|part| part.to_string())
        .chain(installs.iter().cloned())
        .chain(std::iter::once(".cargo/bin".to_string()))
        .map(|part| join_path(platform, user_directory, &part))
        .collect();
    let mut candidates: Vec<String> = env.get(&path_key)
        .map(|value| value.split(delimiter).map(str::to_string).collect())
        .unwrap_or_default();
    candidates.extend(extra);
    let mut seen: Vec<String> = Vec::new();
    let path_value = candidates
        .into_iter()
        .filter(|value| {
            let identity = if win { value.to_lowercase() } else { value.clone() };
            if seen.contains(&identity) { return false; }
            seen.push(identity);
            true
        })
        .collect::<Vec<_>>()
        .join(&delimiter.to_string());
    env.insert(path_key, path_value);
    env
}

/// The conversation capability a recipe declares, read from the parsed registry (the F167 data):
/// does the CLI accept being told which conversation to START?
pub fn conversation_start_capability(recipes: &[(String, Value)], agent: &str) -> Option<bool> {
    recipes
        .iter()
        .find(|(name, _)| name == agent)
        .and_then(|(_, raw)| raw.get("conversation"))
        .map(|talk| talk.get("start").is_some())
}

/// The pane-identity composition, byte-identical to sessions.mjs's agentPaneComposition.
/// `input` is the fixture JSON; the capability comes from the parsed registry, not the TOML text.
pub fn agent_pane_composition(input: &serde_json::Value, capability: Option<bool>) -> serde_json::Value {
    let agent = input["agent"].as_str();
    let mut conversation = input["conversation"].as_str().map(str::to_string);
    let resume = input["resume"].as_bool().unwrap_or(false);
    let action = input["action"].as_str().unwrap_or("launch");
    let args: Vec<&str> = input["args"].as_array().map(|items| items.iter().filter_map(|item| item.as_str()).collect()).unwrap_or_default();
    let workspace = input["workspace"].as_bool().unwrap_or(false);
    let remembered = input["remembered"].as_array().cloned().unwrap_or_default();
    let now = input["now"].as_i64().unwrap_or(0);
    let paths = &input["paths"];

    // Whether this launch already decided what the pane is — read before the mint below.
    let chosen = conversation.is_some() || !args.is_empty();
    let mut argv = vec![
        json!(paths["agentScript"].as_str().expect("paths.agentScript")),
        json!("--project"),
        json!(paths["rootPath"].as_str().expect("paths.rootPath")),
        json!("--action"),
        json!(action),
    ];
    if let Some(name) = agent {
        argv.push(json!("--agent"));
        argv.push(json!(name));
    }

    let mut sets = serde_json::Map::new();
    let mut record = serde_json::Value::Null;
    let mut listing = serde_json::Value::Null;
    if workspace {
        sets.insert("RENGINE_WORKSPACE_CONTEXT".to_string(), paths["workspaceContextFile"].clone());
        sets.insert("RENGINE_NODE".to_string(), paths["node"].clone());
        sets.insert("RENGINE_BASH".to_string(), paths["bash"].clone());
        // Name the conversation now, for a CLI that accepts being told; an agent that names its
        // own is recorded with none, and a named conversation without resume is refused.
        if capability == Some(true) && conversation.is_none() {
            conversation = Some(input["mint"].as_str().expect("mint is data").to_string());
        }
        if capability.is_some() && conversation.is_some() && capability != Some(true) && !resume {
            return json!({
                "refuse": format!("{} names its own conversations: rEngine can put this CLI back into a recorded one but cannot tell it which to start. Resume it explicitly, or start without naming one.", agent.unwrap_or("")),
            });
        }
        if capability.is_some() && conversation.is_some() {
            sets.insert("RENGINE_AGENT_CONVERSATION".to_string(), json!(conversation));
            if resume {
                sets.insert("RENGINE_AGENT_RESUME".to_string(), json!("1"));
            }
            record = json!({ "conversation": conversation, "agent": agent });
        }
        // What this project already has, for the pane to offer: only for a bare pane, and only
        // when there is something to offer.
        let offered: Vec<serde_json::Value> = if chosen { Vec::new() } else { remembered };
        if !offered.is_empty() {
            let rows: Vec<String> = offered
                .iter()
                .filter(|entry| entry["id"].as_str() != conversation.as_deref())
                .map(|entry| format!(
                    "{}\t{}\t{}",
                    entry["id"].as_str().unwrap_or(""),
                    entry["agent"].as_str().unwrap_or(""),
                    describe_age(entry["lastSeenAt"].as_i64().unwrap_or(0), now)
                ))
                .collect();
            if !rows.is_empty() {
                listing = json!({
                    "file": paths["listingFile"].clone(),
                    "content": format!("{}\n", rows.join("\n")),
                    "rows": rows,
                });
            }
        }
        sets.insert("RENGINE_ORCHESTRATOR_SESSION".to_string(), json!(input["id"].as_str().expect("id")));
    }
    if !args.is_empty() {
        argv.push(json!("--"));
        argv.extend(args.into_iter().map(|arg| json!(arg)));
    }
    // No claim without a launch environment that carries one.
    if !sets.contains_key("RENGINE_AGENT_CONVERSATION") {
        conversation = None;
    }
    json!({
        "refuse": serde_json::Value::Null,
        "conversation": conversation,
        "argv": argv,
        "sets": sets,
        "record": record,
        "listing": listing,
    })
}

/// The keys a launch composes for itself and must never inherit — cleared in BOTH compositions
/// (sessions.mjs:129-133 and its pty.spawn call), so this launch's own values win and only what
/// it left out stays deleted.
pub const CLEARED: [&str; 6] = [
    "RENGINE_HANDOFF_GATE",
    "RENGINE_HANDOFF_FILE",
    "RENGINE_ORCHESTRATOR_SESSION",
    "RENGINE_AGENT_CONVERSATION",
    "RENGINE_AGENT_RESUME",
    "RENGINE_AGENT_CONVERSATIONS",
];

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ages_read_like_the_js_side() {
        let now = 1_800_000_000_000;
        assert_eq!(describe_age(now - 30_000, now), "just now");
        assert_eq!(describe_age(now - 45 * MINUTE, now), "45 minutes ago");
        assert_eq!(describe_age(now - 90 * MINUTE, now), "an hour ago");
        assert_eq!(describe_age(now - 5 * HOUR, now), "5 hours ago");
        assert_eq!(describe_age(now - 30 * HOUR, now), "yesterday");
        assert_eq!(describe_age(now - 5 * DAY, now), "5 days ago");
        assert_eq!(describe_age(now + 1000, now), "just now", "a future stamp clamps to zero gap");
    }

    fn map(value: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
        value.as_object().unwrap().clone()
    }

    /* The SHIPPED declaration, so these exercise what a launch actually reads rather than a
       restatement of it. A test that carried its own list would go on passing after the registry
       dropped one. */
    fn shipped() -> Vec<(String, crate::Value)> {
        let text = std::fs::read_to_string("../../agents/registry.toml").expect("the registry");
        crate::load_registry(&text, "registry.toml", None).expect("a registry that cooks")
    }
    fn envelope(
        overrides: &serde_json::Map<String, serde_json::Value>,
        inherited: &serde_json::Map<String, serde_json::Value>,
        platform: &str,
        home: &str,
    ) -> EnvMap {
        let recipes = shipped();
        shell_environment(overrides, inherited, platform, home,
            &crate::launch::process_identity(&recipes), &crate::launch::install_paths(&recipes))
    }

    #[test]
    fn the_envelope_scrubs_and_augments() {
        let inherited = map(json!({ "PATH": "/usr/bin:/bin", "NO_COLOR": "1", "ELECTRON_RUN_AS_NODE": "1", "EDITOR": "vi" }));
        let env = envelope(&serde_json::Map::new(), &inherited, "darwin", "/home/person");
        assert!(!env.contains_key("NO_COLOR"));
        assert!(!env.contains_key("ELECTRON_RUN_AS_NODE"));
        assert_eq!(env["TERM"], "xterm-256color");
        assert_eq!(env["COLORTERM"], "truecolor");
        assert_eq!(env["EDITOR"], "vi");
        assert_eq!(env["PATH"], "/usr/bin:/bin:/home/person/.local/bin:/home/person/.n/bin:/home/person/.opencode/bin:/home/person/.cargo/bin");
    }

    #[test]
    fn a_pane_is_nobodys_child_session() {
        let inherited = map(json!({ "PATH": "/usr/bin:/bin", "CLAUDECODE": "1", "CLAUDE_PID": "92680",
            "CLAUDE_CODE_CHILD_SESSION": "1", "CLAUDE_CODE_SESSION_ID": "287bba3a", "CLAUDE_CODE_MESSAGING_TOKEN": "t",
            "CLAUDE_DIFF_TOOL": "cursor", "CLAUDE_EFFORT": "xhigh" }));
        let env = envelope(&serde_json::Map::new(), &inherited, "darwin", "/home/person");
        for name in crate::launch::process_identity(&shipped()) {
            assert!(!env.contains_key(&name), "{name} names the session that started the host");
        }
        assert_eq!(env["CLAUDE_DIFF_TOOL"], "cursor", "a preference is not an identity");
        assert_eq!(env["CLAUDE_EFFORT"], "xhigh");
        let overrides = map(json!({ "CLAUDE_CODE_SESSION_ID": "minted" }));
        let env = envelope(&overrides, &inherited, "darwin", "/home/person");
        assert_eq!(env["CLAUDE_CODE_SESSION_ID"], "minted", "an explicit override still wins");
        assert!(!env.contains_key("CLAUDE_CODE_CHILD_SESSION"));
        let win = map(json!({ "Path": "C:\\Windows", "claude_code_child_session": "1" }));
        let env = envelope(&serde_json::Map::new(), &win, "win32", "C:\\Users\\person");
        assert!(!env.keys().any(|k| k.eq_ignore_ascii_case("CLAUDE_CODE_CHILD_SESSION")), "case-insensitive on Windows");
    }

    #[test]
    fn an_explicit_override_and_a_delete_behave() {
        let inherited = map(json!({ "PATH": "/usr/bin:/bin", "FOO": "x" }));
        let overrides = map(json!({ "NO_COLOR": "1", "FOO": serde_json::Value::Null }));
        let env = envelope(&overrides, &inherited, "darwin", "/home/person");
        assert_eq!(env["NO_COLOR"], "1", "an explicit override survives the scrub");
        assert!(!env.contains_key("FOO"), "a null deletes, the mechanism the cleared set rides on");
    }

    #[test]
    fn win32_keys_and_paths_follow_the_js_rules() {
        let inherited = map(json!({ "Path": "C:\\Windows;C:\\tools;C:\\TOOLS", "no_color": "1" }));
        let env = envelope(&serde_json::Map::new(), &inherited, "win32", "C:\\Users\\person");
        assert!(!env.contains_key("NO_COLOR"));
        assert_eq!(env["Path"], "C:\\Windows;C:\\tools;C:\\Users\\person\\.local\\bin;C:\\Users\\person\\.n\\bin;C:\\Users\\person\\.opencode\\bin;C:\\Users\\person\\.cargo\\bin",
            "deduped case-insensitively, augmented, semicolon-joined");
    }

    fn pane_input(fields: serde_json::Value) -> serde_json::Value {
        let mut base = json!({
            "id": "sid", "agent": null, "conversation": null, "resume": false, "action": "launch",
            "args": [], "workspace": true, "remembered": [], "mint": "minted-uuid", "now": 1_800_000_000_000i64,
            "paths": {
                "agentScript": "/repo/actions/pane/posix/agent.sh", "rootPath": "/work/project",
                "workspaceContextFile": "/state/integrations/root.json",
                "listingFile": "/state/integrations/sid.conversations.tsv",
                "node": "/usr/local/bin/node", "bash": "/bin/bash",
            },
        });
        base.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
        base
    }

    #[test]
    fn claude_mints_and_kimi_refuses_in_its_own_words() {
        let plan = agent_pane_composition(&pane_input(json!({ "agent": "claude" })), Some(true));
        assert_eq!(plan["conversation"], "minted-uuid");
        assert_eq!(plan["sets"]["RENGINE_AGENT_CONVERSATION"], "minted-uuid");
        assert!(plan["sets"].get("RENGINE_AGENT_RESUME").is_none(), "a minted start is not a resume");
        assert_eq!(plan["record"], json!({ "conversation": "minted-uuid", "agent": "claude" }));

        let plan = agent_pane_composition(&pane_input(json!({ "agent": "kimi", "conversation": "session_x" })), Some(false));
        assert_eq!(plan["refuse"], "kimi names its own conversations: rEngine can put this CLI back into a recorded one but cannot tell it which to start. Resume it explicitly, or start without naming one.");
    }

    #[test]
    fn the_listing_is_for_a_bare_pane_only_and_ages_its_rows() {
        let remembered = json!([
            { "id": "a", "agent": "claude", "lastSeenAt": 1_800_000_000_000i64 - 45 * MINUTE },
            { "id": "b", "agent": "", "lastSeenAt": 1_800_000_000_000i64 - 30 * HOUR },
        ]);
        let bare = agent_pane_composition(&pane_input(json!({ "agent": "kimi", "remembered": remembered })), Some(false));
        assert_eq!(bare["listing"]["rows"], json!(["a\tclaude\t45 minutes ago", "b\t\tyesterday"]));
        assert_eq!(bare["listing"]["content"], "a\tclaude\t45 minutes ago\nb\t\tyesterday\n");
        let decided = agent_pane_composition(&pane_input(json!({ "agent": "kimi", "args": ["--model", "x"], "remembered": remembered })), Some(false));
        assert!(decided["listing"].is_null(), "a pane that already decided is offered nothing");
        assert!(decided["argv"].as_array().unwrap().iter().any(|arg| arg == "--"), "trailing args still forward");
    }

    #[test]
    fn no_workspace_composes_argv_only_and_claims_nothing() {
        let plan = agent_pane_composition(&pane_input(json!({ "agent": "claude", "conversation": "named", "workspace": false })), Some(true));
        assert!(plan["conversation"].is_null(), "nothing is claimed without the launch environment");
        assert_eq!(plan["sets"].as_object().unwrap().len(), 0);
        assert!(plan["record"].is_null());
        assert!(plan["listing"].is_null());
    }
}
