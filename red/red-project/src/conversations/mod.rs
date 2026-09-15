//! The conversations an agent CLI already holds for a project (F210, spec 140).
//!
//! rEngine records the conversations it MINTS (spec 096). A CLI's own store holds more: every
//! conversation there is, including ones begun outside the editor — a terminal, a checkout at a
//! different path, a session that predates this workspace.
//!
//! **One adapter per CLI, one file each.** `claude`, `codex` and `kimi` are siblings here and
//! nothing in this module knows what any of them look like inside: it owns the shapes they all
//! return and the list of who to ask. Adding an agent is a new file plus a line in `stores`, and
//! that is the whole point — the first draft of this feature put all three in one file, which read
//! fine and was wrong, because it made "add an agent" an edit to shared code that every other agent
//! also depends on. See `docs/lessons-learned.md`.
//!
//! **These adapters only read.** The transcripts are each CLI's own format and each CLI's to
//! change; a store that cannot be parsed is reported unreadable, never repaired.
//!
//! The stores are shaped differently and the differences decide the work — claude keys a directory
//! by the checkout PATH, kimi ships an index keyed by working directory, and codex partitions by
//! DATE, so only it must open every candidate to answer "which of these are mine". That is why the
//! whole listing is on demand and never on a timer.
//!
//! The path-derived keys claude and kimi use are an implementation detail of those CLIs, MAPPED
//! here and never adopted: a second machine with the same project at a different path produces a
//! different key, which is the same trap spec 137 met for memories.

pub mod claude;
pub mod codex;
pub mod kimi;

use std::fs;
use std::path::Path;

use serde_json::{json, Map, Value};

use crate::recordings::Fail;

/// The most transcripts one agent reports for one root. A bound, not a budget: a person choosing a
/// conversation to resume is not scrolling past a hundred, and codex's tree is walked per request.
const MAX_PER_AGENT: usize = 64;
/// How far into a transcript the title search reads. Claude writes `ai-title` repeatedly as the
/// conversation is renamed, so the LAST one in this window wins; the first user message is the
/// fallback and appears near the top. Reading whole files would make listing O(transcript).
const TITLE_SCAN_BYTES: u64 = 256 * 1024;
/// How much of a claude transcript's END is searched for a title. `ai-title` is rewritten as the
/// conversation is renamed, so the most recent one is at the back; and a transcript whose head is
/// all harness envelopes (`<command-name>`, caveats) has its first real message further in than a
/// head-only scan reaches.
const TAIL_SCAN_BYTES: u64 = 192 * 1024;
/// How much of a message an expanded row shows. Long enough to recognise a conversation, short
/// enough that the row stays a row: the view wraps it, it does not scroll it.
const EXCERPT_CHARS: usize = 200;

fn refuse(message: &str, status: u16) -> Fail {
    Fail::with_status(message, status)
}

/// The first `limit` bytes of a file as text, lossily. Transcripts are JSONL written by other
/// programs; a partial final line is expected when the file is being appended to right now, and a
/// byte that is not UTF-8 is not a reason to report the store unreadable.
fn head_text(path: &Path, limit: u64) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let end = (limit as usize).min(bytes.len());
    Some(String::from_utf8_lossy(&bytes[..end]).into_owned())
}

/// The last `limit` bytes of a file as text, lossily, starting at the first newline inside the

/// window so a partial line is never parsed as a whole one.
fn tail_text(path: &Path, limit: u64) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let start = bytes.len().saturating_sub(limit as usize);
    let slice = &bytes[start..];
    let from = if start == 0 { 0 } else { slice.iter().position(|b| *b == b'\n').map(|i| i + 1).unwrap_or(0) };
    Some(String::from_utf8_lossy(&slice[from..]).into_owned())
}

fn modified_ms(path: &Path) -> f64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|gap| gap.as_millis() as f64)
        .unwrap_or(0.0)
}

/// One line of prose from a transcript, trimmed to something a row can draw. Newlines become

/// spaces because a title is one line; a message that is only whitespace is no title at all.
fn one_line(text: &str, limit: usize) -> Option<String> {
    let flat: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let trimmed = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(limit).collect())
}

/// Claude's own title for a conversation, or the first thing the person said.
///
/// Of four transcripts in this repository when this was written, ONE carried an `ai-title` and
/// three did not — so the fallback is not a nicety. A row that shows a bare id names nothing, which

fn entry(id: &str, title: Option<String>, modified: f64, agent: &str) -> Value {
    detailed(id, title, None, None, modified, agent)
}

fn detailed(id: &str, title: Option<String>, first: Option<String>, last: Option<String>, modified: f64, agent: &str) -> Value {
    json!({
        "id": id,
        "agent": agent,
        "title": title.unwrap_or_default(),
        "first": first.unwrap_or_default(),
        "last": last.unwrap_or_default(),
        "modifiedAt": modified,
    })
}

fn sort_and_cap(mut rows: Vec<Value>) -> Vec<Value> {
    rows.sort_by(|a, b| {
        let left = b.get("modifiedAt").and_then(Value::as_f64).unwrap_or(0.0);
        let right = a.get("modifiedAt").and_then(Value::as_f64).unwrap_or(0.0);
        left.partial_cmp(&right).unwrap_or(std::cmp::Ordering::Equal)
    });
    rows.truncate(MAX_PER_AGENT);
    rows
}

/// `{ store: "...", conversations: [...] }`, or `{ store, error }` when the directory is there and
/// unreadable. An agent with NO store at all reports `present: false` — which is a different

/// answer from an empty list, and a person reading the view is entitled to know which.
fn answer(agent: &str, store: &Path, present: bool, rows: Option<Vec<Value>>, error: Option<String>) -> Value {
    let mut map = Map::new();
    map.insert("agent".to_string(), json!(agent));
    map.insert("store".to_string(), json!(store.to_string_lossy()));
    map.insert("present".to_string(), json!(present));
    match (rows, error) {
        (_, Some(message)) => {
            map.insert("error".to_string(), json!(message));
            map.insert("conversations".to_string(), json!([]));
        }
        (Some(rows), None) => {
            map.insert("conversations".to_string(), json!(sort_and_cap(rows)));
        }
        (None, None) => {
            map.insert("conversations".to_string(), json!([]));
        }
    }
    Value::Object(map)
}

/// claude: one directory per project, named from the checkout path; one file per conversation,

/// different facts and only one of them is actionable.
pub fn stores(home: &Path, root_path: &str, since_days: u64) -> Result<Value, Fail> {
    if root_path.is_empty() {
        return Err(refuse("A project root is required to list its conversations.", 400));
    }
    /* The ROSTER is the registry's, in the order it declares (spec 141 decision 5). An adapter
       answers for a CLI whose store this crate can read; every other declared CLI is answered
       DECLARED AND EMPTY, because a CLI missing from the list would read as an oversight rather
       than as "this one keeps no per-project store". Adding a CLI to the registry adds a row here
       with no edit, and giving it an adapter is one line below. */
    let roster = roster();
    /* The ones this crate can READ come first, in adapter order, then everyone else in the order the
       registry declares them: a person reading the list sees the stores that have something in them
       together, rather than two permanently empty rows in the middle. The split is by capability —
       "is there a reader for this CLI" — not by a remembered order. */
    let (readable, rest): (Vec<String>, Vec<String>) =
        roster.into_iter().partition(|cli| ADAPTERS.contains(&cli.as_str()));
    let ordered = ADAPTERS
        .iter()
        .map(|name| name.to_string())
        .filter(|name| readable.contains(name))
        .chain(rest);
    let answers: Vec<Value> = ordered
        .map(|cli| match cli.as_str() {
            "claude" => claude::list(home, root_path),
            "codex" => codex::list(home, root_path, since_days),
            "kimi" => kimi::list(home, root_path),
            other => json!({ "agent": other, "store": "", "present": false, "conversations": [] }),
        })
        .collect();
    Ok(json!({ "root": root_path, "agents": answers }))
}

/// Every CLI the registry declares, in declaration order. Falls back to the CLIs with adapters when
/// no registry can be read, so a listing is never silently short.
fn roster() -> Vec<String> {
    let path = std::env::var("RENGINE_AGENT_REGISTRY").ok().unwrap_or_else(|| {
        /* Walking UP to the document rather than counting directories down from the binary: a test
           binary lives one level deeper (`target/debug/deps`), and a fixed depth finds nothing
           there — which would answer a short roster that looked like a real one. */
        std::env::current_exe()
            .ok()
            .and_then(|exe| {
                exe.ancestors()
                    .map(|directory| directory.join("orchestrator/agents/registry.toml"))
                    .find(|candidate| candidate.is_file())
            })
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    let named = std::fs::read_to_string(&path).ok().and_then(|text| {
        let extra = std::env::var("RENGINE_AGENT_REGISTRY_EXTRA")
            .ok()
            .filter(|path| !path.is_empty())
            .and_then(|path| std::fs::read_to_string(&path).ok().map(|text| (text, path)));
        red_agents::load_registry(&text, &path, extra.as_ref().map(|(text, path)| (text.as_str(), path.as_str())))
            .ok()
            .map(|recipes| recipes.into_iter().map(|(name, _)| name).collect::<Vec<_>>())
    });
    named.filter(|names: &Vec<String>| !names.is_empty()).unwrap_or_else(|| ADAPTERS.iter().map(|name| name.to_string()).collect())
}

/// The CLIs this crate has a reader for. The only place their names belong: a dispatch to one file
/// each, which is what an adapter roster is.
const ADAPTERS: [&str; 3] = ["claude", "codex", "kimi"];

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    /// A throwaway home directory. Shared, because every adapter's test needs one and three copies
    /// of it would be the very duplication this module was split to avoid.
    pub(crate) fn temp(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("red-conversations-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("a temp directory");
        directory
    }

    #[test]
    fn listing_writes_nothing_under_the_stores() {
        let home = temp("readonly");
        let store = home.join(".claude/projects/-tmp-demo");
        fs::create_dir_all(&store).expect("the store");
        fs::write(store.join("33333333-3333-3333-3333-333333333333.jsonl"), "{\"type\":\"user\",\"message\":{\"content\":\"hi\"}}\n")
            .expect("a transcript");

        fn fingerprint(directory: &Path) -> Vec<(String, u64, u64)> {
            let mut out = Vec::new();
            let mut stack = vec![directory.to_path_buf()];
            while let Some(next) = stack.pop() {
                let Ok(listing) = fs::read_dir(&next) else { continue };
                for item in listing.flatten() {
                    let path = item.path();
                    if path.is_dir() {
                        stack.push(path);
                        continue;
                    }
                    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    out.push((path.to_string_lossy().into_owned(), size, modified_ms(&path) as u64));
                }
            }
            out.sort();
            out
        }

        let before = fingerprint(&home);
        let _ = stores(&home, "/tmp/demo", 3650).expect("a listing");
        let after = fingerprint(&home);
        assert_eq!(before, after, "listing a store never writes to it");
        let _ = fs::remove_dir_all(&home);
    }

    /* An agent missing from the answer would read as an oversight; one present and empty says
       "this CLI keeps no conversation store", which is a fact a person can act on. */
    #[test]
    fn every_agent_is_named_even_with_no_store() {
        let _guard = ENVIRONMENT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let home = temp("named");
        let answer = stores(&home, "/tmp/demo", 3650).expect("a listing");
        let agents: Vec<&str> = answer["agents"]
            .as_array()
            .expect("agents")
            .iter()
            .map(|a| a.get("agent").and_then(Value::as_str).unwrap_or(""))
            .collect();
        assert_eq!(agents, vec!["claude", "codex", "kimi", "gemini", "opencode"]);
        assert_eq!(json!(agents.len()), json!(5));
        let _ = fs::remove_dir_all(&home);
    }

    /* Who is listed is the REGISTRY's, not a list kept here (F217, spec 141 decision 5): a CLI added
       as data is answered for, declared and empty, because this crate has no reader for it — and a
       CLI missing from the list would read as an oversight rather than as "keeps no store". */
    /* `stores()` reads the registry from the process environment, and cargo runs these tests as
       threads in ONE process — so a test that names an extra registry changes what every other test
       sees. It showed up immediately as the roster test answering six CLIs; the lock is what keeps
       them from being flaky by construction. */
    static ENVIRONMENT: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /* A recipe with no conversation block at all: the registry's minimum, which is the point. */
    const RECIPE: &str = r#"[recipes.newcomer]
package = "@test/newcomer"

[recipes.newcomer.update]
kind = "reinstall"

[recipes.newcomer.mcp]
kind = "flag"
flag = "--servers"
"#;

    #[test]
    fn a_cli_added_as_data_is_listed_without_an_edit_here() {
        let _guard = ENVIRONMENT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let home = temp("declared-roster");
        let extra = home.join("extra.toml");
        fs::write(&extra, RECIPE).expect("extra registry");
        std::env::set_var("RENGINE_AGENT_REGISTRY_EXTRA", &extra);
        let answer = stores(&home, "/tmp/demo", 3650).expect("a listing");
        std::env::remove_var("RENGINE_AGENT_REGISTRY_EXTRA");
        let agents: Vec<&str> = answer["agents"]
            .as_array()
            .expect("agents")
            .iter()
            .map(|a| a.get("agent").and_then(Value::as_str).unwrap_or(""))
            .collect();
        assert!(agents.contains(&"newcomer"), "a declared CLI is answered for: {agents:?}");
        let newcomer = answer["agents"].as_array().expect("agents").iter().find(|a| a["agent"] == "newcomer").expect("the row");
        assert_eq!(newcomer["present"], json!(false), "declared and empty, because nothing here reads its store");
        /* And the readable ones still come first, so the split is by capability, not by arrival. */
        assert_eq!(&agents[..3], &["claude", "codex", "kimi"]);
        let _ = fs::remove_dir_all(&home);
    }
}
