//! Who is asking, off the wire (F158, spec 129; spec 095).
//!
//! **An identity is whatever the caller put on the wire, and that is deliberate.** The token is
//! arbitration among cooperating agents, never an access boundary: every participant already holds
//! the workspace capability, so a lie here buys nothing that was not already reachable. What these
//! headers decide is whose NAME appears in a refusal and on a feed frame, which is worth getting
//! right for a person reading it and not worth defending against a caller who is lying to itself.
//!
//! Two callers, and only one at a time. An agent names itself on `X-Rengine-Agent`; a DESKTOP is
//! named on `X-Rengine-Desktop` by a retired worker forwarding one of its retained desktops' frames
//! to the current one (spec 095, Retirement). The desktop is honoured only in the absence of an
//! agent, because the person at a desktop is never gated and an agent claiming to be one would be
//! claiming its way past the arbitration.

use serde_json::{json, Value};

/// Printable ASCII only, and bounded. A header is somebody else's bytes: control characters in a
/// label reach a terminal that draws them, and an unbounded one reaches a feed frame that is stored.
fn printable(value: Option<&str>, limit: usize) -> String {
    value
        .map(|text| text.chars().filter(|c| (' '..='~').contains(c)).take(limit).collect())
        .unwrap_or_default()
}

/// The shape `token-client.mjs` accepts: 36 characters of hex and dashes. Deliberately looser than a
/// UUID parse, because it is the JS's own rule and a stricter one here would refuse an identity the
/// ledger has already recorded.
fn uuid_shaped(value: &str) -> bool {
    value.len() == 36 && value.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

/// The agent that sent this request, or `None` when nothing named one.
pub fn agent(header: impl Fn(&str) -> Option<String>) -> Option<Value> {
    let id = header("x-rengine-agent")?;
    if !uuid_shaped(&id) {
        return None;
    }
    let label = printable(header("x-rengine-agent-label").as_deref(), 64);
    let mut identity = json!({
        "agentId": id,
        "label": if label.is_empty() { "agent".to_string() } else { label },
    });
    /* A pid only when it is one: `Number('')` is 0 in the JavaScript and 0 is not a process. */
    if let Some(pid) = header("x-rengine-agent-pid").and_then(|value| value.parse::<i64>().ok()).filter(|pid| *pid > 0) {
        identity.as_object_mut().expect("an object").insert("pid".to_string(), json!(pid));
    }
    Some(identity)
}

/// The desktop a retired worker is acting for, honoured only when no agent named itself.
pub fn desktop(header: impl Fn(&str) -> Option<String>) -> Option<String> {
    let named = printable(header("x-rengine-desktop").as_deref(), 64);
    (!named.is_empty()).then_some(named)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name: &str| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| value.to_string())
    }

    const ID: &str = "12345678-1234-1234-1234-123456789abc";

    #[test]
    fn an_agent_names_itself_and_a_label_it_does_not_choose_the_length_of() {
        let who = agent(headers(&[("x-rengine-agent", ID), ("x-rengine-agent-label", "claude 287bba3a")]))
            .expect("an identity");
        assert_eq!(who["agentId"], json!(ID));
        assert_eq!(who["label"], json!("claude 287bba3a"));
        assert_eq!(who.get("pid"), None, "a pid nobody sent is not a pid");

        /* A header is somebody else's bytes: control characters reach a terminal that draws them
           and an unbounded label reaches a feed frame that is stored. */
        let noisy = agent(headers(&[("x-rengine-agent", ID), ("x-rengine-agent-label", "a\u{7}b\u{1b}[31m")])).expect("an identity");
        assert_eq!(noisy["label"], json!("ab[31m"), "control characters are dropped, the rest is kept");
        let long = agent(headers(&[("x-rengine-agent", ID), ("x-rengine-agent-label", &"x".repeat(200))])).expect("an identity");
        assert_eq!(long["label"].as_str().expect("a label").len(), 64);
    }

    #[test]
    fn an_identity_with_no_shape_is_no_identity() {
        assert!(agent(headers(&[])).is_none(), "nothing named one");
        assert!(agent(headers(&[("x-rengine-agent", "not-a-uuid")])).is_none());
        assert!(agent(headers(&[("x-rengine-agent", &ID[..35])])).is_none(), "35 characters is not 36");
        assert!(agent(headers(&[("x-rengine-agent", &"z".repeat(36))])).is_none(), "hex and dashes only");
    }

    #[test]
    fn a_label_nobody_sent_is_still_a_name_a_person_can_read() {
        let who = agent(headers(&[("x-rengine-agent", ID)])).expect("an identity");
        assert_eq!(who["label"], json!("agent"), "a refusal names something rather than nothing");
    }

    #[test]
    fn a_pid_is_a_process_or_it_is_absent() {
        let with = agent(headers(&[("x-rengine-agent", ID), ("x-rengine-agent-pid", "92680")])).expect("an identity");
        assert_eq!(with["pid"], json!(92680));
        for bad in ["0", "-1", "", "nonsense"] {
            let who = agent(headers(&[("x-rengine-agent", ID), ("x-rengine-agent-pid", bad)])).expect("an identity");
            assert_eq!(who.get("pid"), None, "{bad} is not a process");
        }
    }

    #[test]
    fn a_desktop_is_named_and_bounded_the_same_way() {
        assert_eq!(desktop(headers(&[("x-rengine-desktop", "desk-1")])), Some("desk-1".to_string()));
        assert_eq!(desktop(headers(&[])), None);
        assert_eq!(desktop(headers(&[("x-rengine-desktop", "")])), None, "a header sent empty named nobody");
        assert_eq!(desktop(headers(&[("x-rengine-desktop", &"d".repeat(200))])).expect("a desktop").len(), 64);
    }
}
