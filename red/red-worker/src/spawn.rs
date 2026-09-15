//! Spawning an agent pane on a task (F158, spec 129; spec 103).
//!
//! A spawn is the one route that starts a CLI on somebody's behalf, so what it refuses matters more
//! than what it does. Three things are decided here, and each is a refusal a caller can act on:
//!
//! - **A host too old to carry it.** A retained session host that predates task-driven panes
//!   neither records the task on a conversation nor passes a pane's arguments to its CLI, so a
//!   spawn against it starts an agent with no prompt — which looks like a working pane and is not.
//!   Refused by name, with nothing started (spec 103).
//! - **A CLI name that is not one.** It reaches a process launch, so it is held to a shape rather
//!   than passed along.
//! - **Whether rEngine may NAME the conversation.** Only a CLI whose recipe declares a start
//!   spelling can be told which conversation to begin. One that can only resume, or that names its
//!   own, is started unnamed and records none — the same treatment the pane launcher gives it, and
//!   never a refusal for a spawn that named nothing the caller chose.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct Refused {
    pub message: String,
    pub status: u16,
}

fn refuse(message: &str, status: u16) -> Refused {
    Refused { message: message.to_string(), status }
}

/// The sentence a host too old for this is refused with, word for word — checked against
/// `runtime/worker.mjs` by `the_old_host_sentence_is_the_javascripts` below, because a person reads
/// it and decides whether to replace a host on the strength of it. It names the CONSEQUENCE
/// rather than the capability, because the person reading it has to decide whether to replace a
/// host — and "nothing was started" is the part that lets them not worry first.
pub const OLD_HOST: &str = "This retained session host predates task-driven agent panes: it neither records the task on a conversation nor passes a pane's arguments to its CLI, so a spawn would start an agent with no prompt. Replacing the session host requires quiescence. Nothing was started.";

/// The sentence a host too old to launch a DECLARED game is refused with.
///
/// A host that predates per-project game declarations has a removed built-in game and would launch
/// that instead: the refusal names what it would do rather than what it lacks, because a person who
/// asked for their game and got somebody else's has no way to tell from a capability name.
pub const OLD_GAME_HOST: &str = "This retained session host predates per-project game declarations and would launch its removed built-in game; game_preflight answers from the declaration. Replacing the session host requires quiescence.";

/// May this host launch a game the project declared?
pub fn host_can_launch(state: &Value) -> Result<(), Refused> {
    let declared = state.get("capabilities").and_then(|held| held.get("projectGame")).and_then(Value::as_i64);
    if declared == Some(1) {
        Ok(())
    } else {
        Err(refuse(OLD_GAME_HOST, 409))
    }
}

/// Can this host carry a spawn at all? The capability is the host's own declaration.
pub fn host_can_spawn(state: &Value) -> Result<(), Refused> {
    let declared = state
        .get("capabilities")
        .and_then(|capabilities| capabilities.get("taskConversations"))
        .and_then(Value::as_i64);
    if declared == Some(1) {
        Ok(())
    } else {
        Err(refuse(OLD_HOST, 409))
    }
}

/// The CLI a caller named, held to a shape because it reaches a process launch.
pub fn agent_name(asked: Option<&str>) -> Result<String, Refused> {
    let named = asked.unwrap_or_default();
    let shaped = (1..=64).contains(&named.len())
        && named.starts_with(|first: char| first.is_ascii_alphanumeric())
        && named.chars().all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c));
    if shaped {
        Ok(named.to_string())
    } else {
        Err(refuse("Choose an agent CLI to spawn.", 400))
    }
}

/// May rEngine name the conversation this pane starts?
///
/// Only when the recipe declares a START spelling — a flag the CLI takes to begin a NAMED
/// conversation. A CLI that can only resume one, or that names its own, is started unnamed; the
/// frame then says the conversation is `null` rather than inventing an id nothing can resume.
pub fn names_the_conversation(recipes: &Value, agent: &str) -> bool {
    recipes
        .get(agent)
        .and_then(|recipe| recipe.get("conversation"))
        .and_then(|talk| talk.get("start"))
        .is_some_and(|start| !start.is_null())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn recipes() -> Value {
        let text = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().and_then(|red| red.parent())
                .expect("the checkout").join("orchestrator/agents/registry.toml"),
        )
        .expect("the registry");
        red_agents::projection(&red_agents::load_registry(&text, "registry.toml", None).expect("a registry"))
    }

    /* The refusal a person acts on: it names the consequence rather than the capability, because
       what they have to decide is whether to replace a host. */
    #[test]
    fn a_host_that_cannot_carry_a_spawn_is_refused_before_anything_starts() {
        assert_eq!(host_can_spawn(&json!({ "capabilities": { "taskConversations": 1 } })), Ok(()));
        for old in [json!({}), json!({ "capabilities": {} }), json!({ "capabilities": { "taskConversations": 0 } })] {
            let refused = host_can_spawn(&old).expect_err("refused");
            assert_eq!(refused.status, 409);
            assert!(refused.message.ends_with("Nothing was started."), "{}", refused.message);
            assert!(refused.message.contains("no prompt"), "it says what would go wrong, not which flag is missing");
        }
    }

    /* A refusal a person ACTS on is a contract. While `worker.mjs` is here it is the authority;
       when it goes this becomes a claim about a file that does not exist and is replaced by the
       recorded answers, the way every other parity proof here was. */
    #[test]
    fn the_old_host_sentence_is_the_javascripts() {
        let worker = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().and_then(|red| red.parent())
            .expect("the checkout").join("orchestrator/runtime/worker.mjs");
        let Ok(js) = std::fs::read_to_string(&worker) else { return };
        let Some(at) = js.find("task-driven agent panes") else {
            panic!("the JavaScript no longer refuses an old host in these words");
        };
        let start = js[..at].rfind('\'').expect("an opening quote") + 1;
        let (mut text, mut escaped) = (String::new(), false);
        for character in js[start..].chars() {
            match character {
                _ if escaped => {
                    text.push(character);
                    escaped = false;
                }
                '\\' => escaped = true,
                '\'' => break,
                _ => text.push(character),
            }
        }
        assert_eq!(text, OLD_HOST, "the refusal a person acts on has drifted from the one they used to get");
    }

    /* The other old-host refusal, and it names the same kind of thing: what would happen, not which
       flag is missing. A person who asked for their game and got the removed built-in one has no way
       to tell from a capability name. */
    #[test]
    fn a_host_that_would_launch_the_wrong_game_is_refused_by_name() {
        assert_eq!(host_can_launch(&json!({ "capabilities": { "projectGame": 1 } })), Ok(()));
        for old in [json!({}), json!({ "capabilities": {} }), json!({ "capabilities": { "projectGame": 0 } })] {
            let refused = host_can_launch(&old).expect_err("refused");
            assert_eq!(refused.status, 409);
            assert!(refused.message.contains("removed built-in game"), "{}", refused.message);
            assert!(refused.message.contains("game_preflight answers from the declaration"),
                    "it names what does work: {}", refused.message);
        }
    }

    /* Both old-host sentences are ones a person acts on, so both are checked against the JavaScript
       while it is still here — the same device as `the_old_host_sentence_is_the_javascripts`. */
    #[test]
    fn the_old_game_host_sentence_is_the_javascripts() {
        let worker = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().and_then(|red| red.parent())
            .expect("the checkout").join("orchestrator/runtime/worker.mjs");
        let Ok(js) = std::fs::read_to_string(&worker) else { return };
        let Some(at) = js.find("predates per-project game declarations") else {
            panic!("the JavaScript no longer refuses an old host in these words");
        };
        let start = js[..at].rfind('\'').expect("an opening quote") + 1;
        let (mut text, mut escaped) = (String::new(), false);
        for character in js[start..].chars() {
            match character {
                _ if escaped => {
                    text.push(character);
                    escaped = false;
                }
                '\\' => escaped = true,
                '\'' => break,
                _ => text.push(character),
            }
        }
        assert_eq!(text, OLD_GAME_HOST, "the refusal a person acts on has drifted from the one they used to get");
    }

    #[test]
    fn an_agent_name_is_a_name_because_it_reaches_a_process() {
        assert_eq!(agent_name(Some("claude")), Ok("claude".to_string()));
        assert_eq!(agent_name(Some("kimi-code")), Ok("kimi-code".to_string()));
        assert_eq!(agent_name(Some("a")), Ok("a".to_string()));
        assert_eq!(agent_name(Some(&"a".repeat(64))), Ok("a".repeat(64)));
        for bad in [None, Some(""), Some("-leading"), Some(".hidden"), Some("two words"),
                    Some("semi;colon"), Some("slash/es"), Some("nul\0byte"), Some("../escape")] {
            assert_eq!(agent_name(bad).expect_err("refused").status, 400, "{bad:?}");
        }
        assert!(agent_name(Some(&"a".repeat(65))).is_err(), "65 is past the bound");
    }

    /* Read off the SHIPPED recipes, so this says what the workspace actually does rather than what a
       fixture says it does. claude is told which conversation to start; codex and kimi can only
       resume one, and are started unnamed rather than refused. */
    #[test]
    fn only_a_cli_that_can_be_told_which_conversation_to_start_is_told() {
        let recipes = recipes();
        assert!(names_the_conversation(&recipes, "claude"), "claude takes a --session-id");
        assert!(!names_the_conversation(&recipes, "codex"), "codex can only resume one");
        assert!(!names_the_conversation(&recipes, "kimi"), "and so can kimi");
        /* A CLI with no conversation at all, and one nobody has heard of, are both simply unnamed —
           never a refusal, because the caller chose nothing that could be wrong. */
        assert!(!names_the_conversation(&recipes, "gemini"));
        assert!(!names_the_conversation(&recipes, "nosuchcli"));
    }
}
