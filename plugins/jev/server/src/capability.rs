//! Named, closed capabilities and the scrub that runs before anything leaves (F229, spec 151).
//!
//! There is no generic "ask Jev" here, and that is the boundary. A generic tool would let any caller
//! send anything, and every rule below would be decoration. So a capability owns its question set,
//! its state builder reads only the sources it declares, and **its parameters are identifiers, never
//! free text** — the capability that proves why is triage, which naturally wants the failure *text*,
//! and a text parameter would be a hole the size of the whole boundary.
//!
//! The honest limit, recorded rather than papered over: agents here run as the owner's UID and can
//! read the key, so this disciplines the sanctioned path and does not contain a determined caller.
//! The audit trail is the record plus the vendor's own usage log.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::{record, Answer, Jev, Question};

/// What this plugin says about itself when core asks. Core owns whether it is switched ON; this
/// answers whether it could actually work, in the plugin's own words -- a key it does not have is
/// its problem to describe, not core's to know about.
pub fn status(state_directory: &str) -> serde_json::Value {
    let has_key = crate::key_path(state_directory).exists();
    let counts = record::tally(state_directory);
    serde_json::json!({
        "ready": has_key,
        "detail": if has_key {
            "Ready. Every judgement is recorded here and nothing is acted on.".to_string()
        } else {
            format!("No key. Put one line at {} to use this.", crate::key_path(state_directory).display())
        },
        "usage": {
            "calls": counts.get("calls").copied().unwrap_or(0),
            "inputTokens": counts.get("inputTokens").copied().unwrap_or(0),
            "model": crate::MODEL,
        },
    })
}

/// Remove from text the things that are written down here but have no business leaving the machine.
///
/// "Already written down" is not "safe to send", and this repository proves it: `pr0fe@192.168.31.217`
/// is in the charter, in `features.json` three times, and in spec 147. Failure output carries home
/// directories, usernames and internal topology on top of that.
pub fn scrub(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        // /Users/<name>/ and /home/<name>/ become ~/ — the path shape survives, the person does not.
        if let Some(rest) = matches_at(&bytes, i, "/Users/").or_else(|| matches_at(&bytes, i, "/home/")) {
            let mut j = rest;
            while j < bytes.len() && bytes[j] != '/' && !bytes[j].is_whitespace() { j += 1; }
            if j > rest {
                out.push_str("~");
                i = j;
                continue;
            }
        }
        // user@host, and bare private addresses, become placeholders.
        if bytes[i].is_ascii_digit() {
            if let Some(end) = private_address_at(&bytes, i) {
                // Take a `name@` immediately before it with the address.
                trim_trailing_user(&mut out);
                out.push_str("<host>");
                i = end;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn matches_at(chars: &[char], at: usize, prefix: &str) -> Option<usize> {
    let wanted: Vec<char> = prefix.chars().collect();
    if at + wanted.len() > chars.len() { return None; }
    for (offset, want) in wanted.iter().enumerate() {
        if chars[at + offset] != *want { return None; }
    }
    Some(at + wanted.len())
}

/// A dotted quad in a private range, returning where it ends.
fn private_address_at(chars: &[char], at: usize) -> Option<usize> {
    let mut parts = [0u16; 4];
    let mut i = at;
    for slot in 0..4 {
        let start = i;
        let mut value: u32 = 0;
        while i < chars.len() && chars[i].is_ascii_digit() && i - start < 3 {
            value = value * 10 + chars[i].to_digit(10)? as u32;
            i += 1;
        }
        if i == start || value > 255 { return None; }
        parts[slot] = value as u16;
        if slot < 3 {
            if i >= chars.len() || chars[i] != '.' { return None; }
            i += 1;
        }
    }
    // A digit immediately after is a version string, not an address.
    if i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') { return None; }
    let private = parts[0] == 10
        || (parts[0] == 192 && parts[1] == 168)
        || (parts[0] == 172 && (16..=31).contains(&parts[1]));
    if private { Some(i) } else { None }
}

/// Drop a `name@` that the address was attached to.
fn trim_trailing_user(out: &mut String) {
    if !out.ends_with('@') { return; }
    out.pop();
    while let Some(last) = out.chars().last() {
        if last.is_alphanumeric() || last == '-' || last == '_' || last == '.' { out.pop(); } else { break; }
    }
}

/// What a capability produced.
#[derive(Debug)]
pub struct Judgement {
    pub id: String,
    pub answers: BTreeMap<String, Answer>,
    pub input_tokens: u64,
}

/// The capabilities this build has. Each is a closed shape whose parameters are identifiers — there
/// is no variant carrying prose.
pub enum Capability {
    /// Is a failure the change under test, or the environment? `output` names a file the harness
    /// already wrote inside the state directory; `test` is the failing test's name.
    Triage { output: String, test: String },
}

impl Capability {
    pub fn name(&self) -> &'static str {
        match self { Capability::Triage { .. } => "triage" }
    }

    /// Build this capability's state from the sources it declares — reading the file itself rather
    /// than accepting text from the caller — and scrub it.
    fn state(&self, state_directory: &str) -> Result<serde_json::Value, String> {
        match self {
            Capability::Triage { output, test } => {
                let path = declared_output(state_directory, output)?;
                let text = std::fs::read_to_string(&path)
                    .map_err(|e| format!("cannot read the recorded run at {}: {e}", path.display()))?;
                let tail: String = text.lines().rev().take(80).collect::<Vec<_>>()
                    .into_iter().rev().collect::<Vec<_>>().join("\n");
                Ok(serde_json::json!({
                    "test": scrub(test),
                    "output": scrub(&tail),
                }))
            }
        }
    }

    fn questions(&self) -> BTreeMap<String, Question> {
        match self {
            Capability::Triage { .. } => BTreeMap::from([
                ("flaky".to_string(), Question::Noul {
                    instructions: "Is this failure better explained by test-environment flakiness — \
                                   resource or port contention under concurrency — than by the change \
                                   under test?".to_string(),
                    when_true: Some("The failure is about the environment".to_string()),
                    when_false: Some("The failure is about the code under test".to_string()),
                }),
                ("verdict".to_string(), Question::Choice {
                    instructions: "What should the engineer do next?".to_string(),
                    options: BTreeMap::from([
                        ("treat_as_flake".to_string(), "Record it as flakiness and proceed".to_string()),
                        ("rerun_isolated".to_string(), "Re-run the single test alone to decide".to_string()),
                        ("investigate_change".to_string(), "Stop and investigate the change".to_string()),
                    ]),
                }),
            ]),
        }
    }
}

/// A recorded run lives inside the state directory and nowhere else. A caller naming anything that
/// escapes it is refused by name before a byte is read, which is what keeps the parameter an
/// identifier rather than a way to send any file on the machine.
fn declared_output(state_directory: &str, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains("..") || Path::new(name).is_absolute() {
        return Err(format!("{name:?} is not a recorded run: a run is named relative to the state directory"));
    }
    let root = Path::new(state_directory).join("runs");
    let path = root.join(name);
    if !path.starts_with(&root) {
        return Err(format!("{name:?} resolves outside the recorded runs and is refused"));
    }
    Ok(path)
}

/// Run a capability. Refuses when Jev is switched off, so "off" is a property of the system and not
/// a thing each caller remembers to check.
///
/// **Shadow mode**: this returns the judgement and never acts on it. Nothing in this build gates a
/// decision on an answer — the bands come after there are outcomes to set them from (spec 151
/// decision 5), and until then a capability's product is a recorded judgement a person reads.
pub fn run(state_directory: &str, capability: &Capability) -> Result<Judgement, String> {
    let state = capability.state(state_directory)?;
    let hash = record::state_hash(&state.to_string());

    // A repeat inside the record is served from it: asking twice pays twice and can answer
    // differently, because pinning the model does not pin decoding.
    for row in record::rows(state_directory).iter().rev() {
        if row.get("stateHash").and_then(|h| h.as_str()) == Some(hash.as_str())
            && row.get("capability").and_then(|c| c.as_str()) == Some(capability.name()) {
            let mut answers = BTreeMap::new();
            if let Some(map) = row.get("answers").and_then(|a| a.as_object()) {
                for (id, value) in map {
                    if let Some(answer) = Answer::from_json(value) { answers.insert(id.clone(), answer); }
                }
            }
            return Ok(Judgement {
                id: row.get("id").and_then(|i| i.as_str()).unwrap_or_default().to_string(),
                answers,
                input_tokens: 0,
            });
        }
    }

    let jev = Jev::from_state_directory(state_directory)?;
    let response = jev.ask(&state, &capability.questions())?;
    let id = record::append(state_directory, capability.name(), &hash, &response)?;
    Ok(Judgement { id, answers: response.answers, input_tokens: response.input_tokens })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> String {
        let directory = std::env::temp_dir()
            .join(format!("rengine-jev-cap-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("temp");
        directory.to_str().expect("utf8").to_string()
    }

    #[test]
    fn the_charters_own_private_host_does_not_leave() {
        // The worked example, taken from this repository: it appears in 000-charter.md, three times
        // in features.json, and in spec 147.
        let scrubbed = scrub("Verified on pr0fe@192.168.31.217 (PowerShell 5.1.26100)");
        assert!(!scrubbed.contains("192.168.31.217"), "the address is gone: {scrubbed}");
        assert!(!scrubbed.contains("pr0fe"), "and so is the account it was attached to: {scrubbed}");
        assert!(scrubbed.contains("<host>"), "with something in its place: {scrubbed}");
        assert!(scrubbed.contains("PowerShell 5.1.26100"), "the rest survives: {scrubbed}");
    }

    #[test]
    fn home_directories_become_a_tilde_and_versions_are_left_alone() {
        let scrubbed = scrub("error at /Users/alex/rengine/editor/app.c:221 and /home/ci/work/x");
        assert!(!scrubbed.contains("alex") && !scrubbed.contains("/home/ci"), "{scrubbed}");
        assert!(scrubbed.contains("~/rengine/editor/app.c:221"), "the useful part survives: {scrubbed}");
        // A version quad is not an address and must not be mangled.
        assert_eq!(scrub("PowerShell 5.1.26100.9444"), "PowerShell 5.1.26100.9444");
        assert_eq!(scrub("a public 8.8.8.8 stays"), "a public 8.8.8.8 stays");
    }

    #[test]
    fn it_describes_whether_it_can_work_and_never_shows_the_key() {
        let directory = temp("status");
        let without = status(&directory);
        assert_eq!(without["ready"], false, "no key means it cannot work");
        assert!(without["detail"].as_str().expect("detail").contains("No key"));

        std::fs::write(crate::key_path(&directory), "sk-secret-value").expect("key");
        let with = status(&directory);
        assert_eq!(with["ready"], true);
        assert!(!with.to_string().contains("sk-secret-value"),
                "what core renders must never carry the key: {with}");
        assert_eq!(with["usage"]["model"], crate::MODEL);
    }

    #[test]
    fn a_run_name_cannot_escape_the_state_directory() {
        let directory = temp("escape");
        for bad in ["../../../etc/passwd", "/etc/passwd", ""] {
            let error = declared_output(&directory, bad).expect_err("refused");
            assert!(error.contains("recorded run") || error.contains("refused"), "{bad}: {error}");
        }
        let good = declared_output(&directory, "suite-2026.txt").expect("accepted");
        assert!(good.starts_with(Path::new(&directory).join("runs")));
    }

    #[test]
    fn the_state_a_capability_builds_is_scrubbed_and_read_from_the_file_itself() {
        let directory = temp("state");
        let runs = Path::new(&directory).join("runs");
        std::fs::create_dir_all(&runs).expect("runs");
        std::fs::write(runs.join("suite.txt"),
                       "not ok 266 - a socket the host owns is tunnelled\n  at /Users/alex/rengine/tests/x.mjs\n  host pr0fe@192.168.31.217\n")
            .expect("write");

        let capability = Capability::Triage { output: "suite.txt".into(), test: "a socket the host owns".into() };
        let state = capability.state(&directory).expect("state");
        let text = state.to_string();
        assert!(text.contains("not ok 266"), "the failure survives: {text}");
        assert!(!text.contains("alex") && !text.contains("192.168.31.217"),
                "and the machine's details do not: {text}");
    }
}
