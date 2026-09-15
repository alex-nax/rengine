//! The agent menu the Tasks pane offers (F158, spec 129).
//!
//! The menu itself is `red_project::tasks::agents_menu`. What is here is the part that has to run
//! PROCESSES to build it, and the reason that is two passes rather than one.
//!
//! **A CLI's model list may only be discoverable by asking it.** A recipe can declare its models as
//! data; one whose recipe says `models.kind = "help"` keeps them in its own `--help`, and the only
//! way to know them is to run it. Running every CLI on every menu read would be five processes for
//! a pane that opens on a click, so the composition asks first — with no help at all — and the
//! answer says which CLIs actually need it. Usually that is none.
//!
//! **A CLI that does not answer contributes nothing rather than failing the menu.** A `--help` that
//! times out, or a CLI that is not really installed, leaves that agent with no models and the menu
//! with every other agent on it. A menu that refused because one CLI was slow would be a menu
//! nobody could open.

use std::collections::BTreeMap;

/// How long a CLI gets to describe itself, and how much of it is read. Both are the JavaScript's:
/// eight seconds, and a quarter-megabyte of output.
pub const HELP_TIMEOUT_MS: u64 = 8000;
pub const HELP_LIMIT: usize = 256 * 1024;

/// What a menu read needs from the world, so the composition can be tested without one.
pub trait Ask {
    /// `agent.sh --action list` for this project: which CLIs this machine actually has.
    fn installed(&mut self) -> String;
    /// One CLI's `--help`, bounded. Empty when it did not answer, which is not an error.
    fn help(&mut self, cli: &str) -> String;
}

/// The menu, and the processes it took to build it.
///
/// `needs_help` decides the second pass, and `asked` records which CLIs were actually run — a menu
/// that runs one CLI per read when it should run none is a menu that got slower, and nothing else
/// would notice.
pub struct Built {
    pub menu: serde_json::Value,
    pub asked: Vec<String>,
}

pub fn build(
    root_id: &str,
    recipes: &serde_json::Value,
    declared: &serde_json::Value,
    ask: &mut dyn Ask,
) -> Built {
    let installed = ask.installed();
    let mut help: BTreeMap<String, String> = BTreeMap::new();
    /* The first pass carries no help, which is what makes the second pass rare: the composition
       says which CLIs it could not answer for rather than this guessing. */
    let wanted = red_project::tasks::needs_help(recipes, declared, &installed);
    let mut asked = Vec::new();
    for cli in &wanted {
        let text = ask.help(cli);
        asked.push(cli.clone());
        help.insert(cli.clone(), text);
    }
    let mut help_of = |cli: &str| help.get(cli).cloned().unwrap_or_default();
    Built { menu: red_project::tasks::agents_menu(root_id, recipes, declared, &installed, &mut help_of), asked }
}

/// The live agent panes on this root, as the menu reports them beside the CLIs it offers.
///
/// A pane is named by its conversation when it has one, because that is what the person sees in the
/// title and the picker — the same eight characters, so the two cannot disagree about which session
/// they mean.
pub fn live(sessions: &serde_json::Value, root_id: &str, short: &dyn Fn(&str, &str) -> String) -> serde_json::Value {
    let panes = sessions.as_array().map(Vec::as_slice).unwrap_or_default();
    let listed: Vec<serde_json::Value> = panes
        .iter()
        .filter(|pane| {
            pane.get("rootId").and_then(serde_json::Value::as_str) == Some(root_id)
                && pane.get("type").and_then(serde_json::Value::as_str) == Some("agent")
                && pane.get("state").and_then(serde_json::Value::as_str) == Some("running")
        })
        .map(|pane| {
            let agent = pane.get("agent").and_then(serde_json::Value::as_str).unwrap_or_default();
            let conversation = pane.get("conversation").and_then(serde_json::Value::as_str);
            serde_json::json!({
                "sessionId": pane.get("id").cloned().unwrap_or(serde_json::Value::Null),
                "conversation": conversation.map(serde_json::Value::from).unwrap_or(serde_json::Value::Null),
                "label": match conversation {
                    Some(id) => short(agent, id),
                    None => agent.to_string(),
                },
                "task": pane.get("task").cloned().unwrap_or(serde_json::Value::Null),
            })
        })
        .collect();
    serde_json::Value::Array(listed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Machine {
        installed: String,
        helps: BTreeMap<String, String>,
        ran: Vec<String>,
    }

    impl Ask for Machine {
        fn installed(&mut self) -> String {
            self.installed.clone()
        }
        fn help(&mut self, cli: &str) -> String {
            self.ran.push(cli.to_string());
            self.helps.get(cli).cloned().unwrap_or_default()
        }
    }

    fn recipes() -> serde_json::Value {
        let text = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().and_then(|red| red.parent())
                .expect("the checkout").join("orchestrator/agents/registry.toml"),
        )
        .expect("the registry");
        let cooked = red_agents::load_registry(&text, "registry.toml", None).expect("a registry");
        red_agents::projection(&cooked)
    }

    /* The whole point of the two passes: a menu read runs NO process for a CLI whose models its
       recipe already declares, and that is nearly all of them. */
    #[test]
    fn a_menu_runs_only_the_clis_that_keep_their_models_in_their_help() {
        let mut machine = Machine {
            installed: "claude\t/bin/claude\ncodex\t/bin/codex\nkimi\t/bin/kimi\n".to_string(),
            helps: BTreeMap::from([(
                "codex".to_string(),
                "  -m, --model <MODEL>  the model\n        [possible values: gpt-6-astra, gpt-6-sol]\n".to_string(),
            )]),
            ran: Vec::new(),
        };
        let built = build("root-1", &recipes(), &json!({}), &mut machine);
        assert_eq!(built.asked, vec!["codex".to_string()], "only the one whose recipe says `help`");
        let agents = built.menu["agents"].as_array().expect("agents");
        let codex = agents.iter().find(|agent| agent["cli"] == json!("codex")).expect("codex");
        assert_eq!(codex["models"], json!(["gpt-6-astra", "gpt-6-sol"]), "read out of its own help");
        let claude = agents.iter().find(|agent| agent["cli"] == json!("claude")).expect("claude");
        assert!(claude["models"].as_array().is_some_and(|models| !models.is_empty()), "declared as data, no process run");
    }

    /* A CLI that does not answer leaves the menu standing. A menu that refused because one CLI was
       slow would be a menu nobody could open. */
    #[test]
    fn a_cli_that_says_nothing_contributes_nothing_and_the_menu_still_opens() {
        let mut machine = Machine {
            installed: "claude\t/bin/claude\ncodex\t/bin/codex\n".to_string(),
            helps: BTreeMap::new(),
            ran: Vec::new(),
        };
        let built = build("root-1", &recipes(), &json!({}), &mut machine);
        let agents = built.menu["agents"].as_array().expect("agents");
        assert!(agents.len() >= 2, "every other agent is still offered");
        let codex = agents.iter().find(|agent| agent["cli"] == json!("codex")).expect("codex");
        assert_eq!(codex["models"], json!([]), "no models rather than no menu");
    }

    /* A pane is named by its conversation, because that is what the person sees in the title and the
       picker — the same eight characters, so the two cannot disagree about which session they mean. */
    #[test]
    fn the_live_list_is_this_roots_running_agents_named_as_the_person_sees_them() {
        let short = |agent: &str, id: &str| format!("{agent} {}", &id[..8]);
        let sessions = json!([
            { "id": "p1", "rootId": "root-1", "type": "agent", "state": "running", "agent": "claude", "conversation": "287bba3a-0315-4563-bd3e-6768c13aed0b", "task": "F158" },
            { "id": "p2", "rootId": "root-1", "type": "agent", "state": "running", "agent": "kimi" },
            { "id": "p3", "rootId": "root-1", "type": "agent", "state": "exited", "agent": "codex" },
            { "id": "p4", "rootId": "root-2", "type": "agent", "state": "running", "agent": "codex" },
            { "id": "p5", "rootId": "root-1", "type": "terminal", "state": "running" },
        ]);
        let listed = live(&sessions, "root-1", &short);
        let rows = listed.as_array().expect("rows");
        assert_eq!(rows.len(), 2, "this root's RUNNING AGENTS, and nothing else: {listed}");
        assert_eq!(rows[0]["label"], json!("claude 287bba3a"));
        assert_eq!(rows[0]["task"], json!("F158"));
        /* A pane with no conversation is named by its CLI alone rather than by a truncated nothing. */
        assert_eq!(rows[1]["label"], json!("kimi"));
        assert_eq!(rows[1]["conversation"], serde_json::Value::Null);
        assert_eq!(rows[1]["task"], serde_json::Value::Null);
    }
}
