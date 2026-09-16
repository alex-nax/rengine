//! Saying one line to a pane that is already running: the decisions (F222, spec 148).
//!
//! The route's sequence lives in the binary beside the other handlers; what is here is every
//! judgement it makes, so each can be read and tested without a workspace around it. The order is
//! load-bearing and is the same order `agent_spawn` uses for the same reason: **a caller that gets
//! a refusal must be able to be certain nothing was typed**, so everything that can refuse comes
//! before anything that acts, and the grant — the only one of them that is spent — is last.

use serde_json::{json, Value};

/// The kinds rEngine implements. One, and it is the one whose composer echo was measured.
pub const KINDS: [&str; 1] = ["paste"];

/// Is this pane one a message can be said to at all? `None` means yes.
///
/// A person's shell is not refused because relaying into it would be dangerous — it is refused
/// because there is nothing there that takes a line and answers it, and a workspace that typed into
/// one would be typing into a command prompt.
pub fn pane_refusal(pane: &Value) -> Option<String> {
    let field = |name: &str| pane.get(name).and_then(Value::as_str).unwrap_or_default();
    if field("type") != "agent" {
        return Some("409|A message goes to an agent pane. This session is not one, and nothing was typed.".to_string());
    }
    if field("state") != "running" {
        return Some("409|Session is not running.".to_string());
    }
    if field("agent").is_empty() {
        return Some("409|This pane has not said which CLI it is running, so rEngine cannot ask how that CLI takes a message. Nothing was typed.".to_string());
    }
    None
}

/// How this pane's CLI takes a message, as its recipe declares it — refused by name when it
/// declares none, and refused by KIND when it declares one rEngine has no implementation for. The
/// second refusal is the treatment `prompt.kind` already gives an unimplemented delivery: the kinds
/// are rEngine's, and which one a CLI takes is the recipe's.
pub fn delivery(recipes: &[(String, red_agents::Value)], agent: &str) -> Result<String, String> {
    let kind = red_agents::launch::message_delivery(recipes, agent).map_err(|message| format!("409|{message}"))?;
    if !KINDS.contains(&kind.as_str()) {
        return Err(format!("500|rEngine declares the {kind} message delivery for {agent} and does not implement it. Nothing was typed."));
    }
    Ok(kind)
}

/// What the feed is told about one relay.
///
/// **The text is not in it, and the count is.** The feed is this project's lifecycle record, and
/// what belongs on it is that a relay happened, to which pane, by whom and whether it landed. A
/// feed carrying the words would be a transcript of one agent's conversation written into another
/// channel, which is the thing `session_output` is bounded and deliberate about.
pub fn frame_fields(id: &str, agent: &str, confirm: &str, characters: usize, delivered: bool, grant: &Value) -> Value {
    json!({
        "sessionId": id,
        "agent": agent,
        "confirm": confirm,
        "characters": characters,
        "delivered": delivered,
        "grant": grant,
    })
}

/// The pane record's own word for how it went, turned into the answer a caller reads. `None` while
/// the handshake is still in flight.
pub fn outcome_of(pane: &Value) -> Option<bool> {
    match pane.get("message").and_then(Value::as_str) {
        Some("delivered") => Some(true),
        Some("undelivered") => Some(false),
        _ => None,
    }
}

/// And the sentence for a relay that was typed and never came back. It is not an error: the line is
/// sitting in somebody's composer unsubmitted, which is the safe half of the handshake working.
pub const UNDELIVERED: &str = "The line was typed into the pane and the pane never echoed it back, so it was not submitted and no Enter was sent. It is in the composer for a person to look at.";
/// What a handshake that has not answered inside the route's own wait is reported as. The watcher
/// is still bounded by its own deadline; this says only that the route stopped waiting first.
pub const UNRESOLVED: &str = "The line was typed into the pane and the workspace stopped waiting for the echo before the handshake finished. The pane's own record says how it ended; no Enter is sent without an echo.";

#[cfg(test)]
mod tests {
    use super::*;

    /* A registry cooked the way a real one is, because a recipe is only a recipe once it has been:
       `project()` reads keys `cook` fills in, and a hand-built table is not one. */
    fn registry(kind: &str) -> Vec<(String, red_agents::Value)> {
        let document = format!(
            "[recipes.declared]\npackage = \"x\"\n\n[recipes.declared.update]\nkind = \"reinstall\"\n\n[recipes.declared.models]\nkind = \"none\"\n\n[recipes.declared.mcp]\nkind = \"env-inline\"\nenvVar = \"X\"\n\n[recipes.declared.message]\nkind = \"{kind}\"\n"
        );
        red_agents::load_registry(&document, "fixture.toml", None).expect("it cooks")
    }

    fn agent_pane() -> Value {
        json!({ "id": "p", "type": "agent", "state": "running", "agent": "testcli" })
    }

    #[test]
    fn only_a_running_agent_pane_takes_a_message() {
        assert_eq!(pane_refusal(&agent_pane()), None);
        for (patch, says) in [
            (json!({ "type": "shell" }), "not one"),
            (json!({ "state": "exited" }), "not running"),
            (json!({ "agent": "" }), "has not said which CLI"),
        ] {
            let mut pane = agent_pane();
            for (key, value) in patch.as_object().expect("an object") {
                pane[key.as_str()] = value.clone();
            }
            let refusal = pane_refusal(&pane).expect("refused");
            assert!(refusal.contains(says), "{refusal}");
            assert!(refusal.starts_with("409|"), "{refusal}");
        }
    }

    /* Both halves of the capability rule: a CLI that has declared nothing is refused by NAME, and a
       CLI that declared a kind rEngine has no implementation for is refused by that KIND. The
       second is the one that would otherwise become a silent no-op the day a recipe is edited. */
    #[test]
    fn an_undeclared_cli_is_refused_by_name_and_an_unimplemented_kind_by_its_kind() {
        let declared = registry("paste");
        assert_eq!(delivery(&declared, "declared").expect("implemented"), "paste");
        let refusal = delivery(&declared, "somethingelse").expect_err("refused");
        assert!(refusal.contains("somethingelse"), "{refusal}");
        assert!(refusal.ends_with("Nothing was typed."), "{refusal}");

        let future = registry("telepathy");
        let refusal = delivery(&future, "declared").expect_err("refused");
        assert!(refusal.contains("telepathy") && refusal.contains("does not implement it"), "{refusal}");
    }

    /* What the feed may carry, asserted rather than assumed: the fact, never the words. */
    #[test]
    fn the_feed_frame_carries_the_fact_and_not_the_message() {
        let fields = frame_fields("p", "testcli", "ab12cd34", 41, true, &json!({ "remaining": 2 }));
        let printed = fields.to_string();
        assert!(printed.contains("\"characters\":41") && printed.contains("\"delivered\":true"));
        assert!(!printed.contains("text"), "no field could carry the words: {printed}");
    }

    #[test]
    fn the_record_says_which_of_the_three_states_a_relay_is_in() {
        assert_eq!(outcome_of(&json!({ "message": "delivered" })), Some(true));
        assert_eq!(outcome_of(&json!({ "message": "undelivered" })), Some(false));
        assert_eq!(outcome_of(&json!({})), None, "in flight is not a verdict");
    }
}
