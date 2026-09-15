//! report-session: the SessionStart reporter (F172, spec 129, KI-093), ported from
//! report-session.mjs with byte-identical behavior on the recorded fixtures.
//!
//! What the CLI says it is running now: the launcher decides the conversation at launch and
//! cannot see a /resume performed inside the running CLI, so the record follows this report.
//! The context resolver reads, in order: --context on this command line (a session started by
//! hand from the line bind prints inherits no launcher environment and is bound as well as a
//! pane is), then RENGINE_MCP_CONFIG (the per-launch mcp.json whose server is started on that
//! same file), then RENGINE_WORKSPACE_CONTEXT. None of the three means this CLI is not running
//! under rEngine at all, and there is nothing to report to.
//!
//! A hook must never fail the CLI it runs inside: every problem is a stderr note and the exit
//! status is always 0.

use serde_json::{json, Value};
use std::io::Read;


pub struct Outcome {
    pub notes: Vec<String>,
}

const NOTE_PREFIX: &str = "rEngine: ";
const FAIL_PREFIX: &str = "rEngine could not report this conversation: ";

fn fail(message: impl Into<String>) -> Outcome {
    Outcome { notes: vec![format!("{FAIL_PREFIX}{}", message.into())] }
}

/// The context file, in the order that finds it.
fn binding_context(argv: &[String], env: &std::collections::HashMap<String, String>) -> Option<String> {
    let from_argv = || {
        argv.iter()
            .position(|arg| arg == "--context")
            .and_then(|index| argv.get(index + 1))
            .filter(|value| !value.is_empty())
            .cloned()
    };
    let from_env = || {
        if let Some(mcp_config) = env.get("RENGINE_MCP_CONFIG") {
            let parsed: Option<Value> = std::fs::read_to_string(mcp_config)
                .ok()
                .and_then(|text| serde_json::from_str(&text).ok());
            if let Some(servers) = parsed.and_then(|value| value.get("mcpServers").cloned()) {
                if let Some(map) = servers.as_object() {
                    for server in map.values() {
                        let args = server.get("args").and_then(Value::as_array);
                        if let Some(args) = args {
                            if let Some(at) = args.iter().position(|arg| arg.as_str() == Some("--context")) {
                                if let Some(value) = args.get(at + 1).and_then(Value::as_str) {
                                    return Some(value.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }
        env.get("RENGINE_WORKSPACE_CONTEXT").cloned()
    };
    from_argv().or_else(from_env)
}

fn connection(context: &Value) -> Result<(String, String), String> {
    let url = context.get("url").and_then(Value::as_str).unwrap_or("");
    let token = context.get("token").and_then(Value::as_str).unwrap_or("");
    let valid = url.starts_with("http://127.0.0.1")
        && token.len() == 64
        && token.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if !valid {
        return Err("Invalid local workspace connection.".to_string());
    }
    Ok((url.to_string(), token.to_string()))
}

struct Kind {
    /* The shape the recipe declares, not a flag naming one CLI. This field was `kimi: bool`,
       derived from the parser's NAME, with the shape hand-rolled below — the fourth copy of a
       pattern the registry already states once (spec 141). */
    ids: Option<String>,
    strip_prefix: Option<String>,
    short_length: usize,
    lowercase: bool,
    resume_line: String,
}

impl Kind {
    fn matches(&self, conversation: &str) -> bool {
        let Some(pattern) = self.ids.as_deref() else { return false };
        regex::RegexBuilder::new(pattern)
            .case_insensitive(true)
            .build()
            .map(|expression| expression.is_match(conversation))
            .unwrap_or(false)
    }
    fn short(&self, id: &str) -> String {
        let stripped = match &self.strip_prefix {
            Some(prefix) if id.len() >= prefix.len() && id[..prefix.len()].eq_ignore_ascii_case(prefix) => &id[prefix.len()..],
            _ => id,
        };
        stripped.chars().take(self.short_length).collect()
    }
    fn normalize(&self, id: &str) -> String {
        if self.lowercase {
            id.to_lowercase()
        } else {
            id.to_string()
        }
    }
}

/// The recipe's conversation atoms, read from the parsed registry document (the F167 data).
fn provider_kind(name: &str, recipes: &[(String, crate::Value)]) -> Option<Kind> {
    let (_, raw) = recipes.iter().find(|(cli, _)| cli == name)?;
    let talk = raw.get("conversation")?;
    let normalize = talk.get("normalize").and_then(crate::Value::string).unwrap_or("");
    Some(Kind {
        ids: talk.get("ids").and_then(crate::Value::string).map(str::to_string),
        strip_prefix: talk
            .get("short")
            .and_then(|short| short.get("stripPrefix"))
            .and_then(crate::Value::string)
            .map(str::to_string),
        short_length: talk
            .get("short")
            .and_then(|short| short.get("length"))
            .and_then(crate::Value::integer)
            .unwrap_or(8) as usize,
        lowercase: normalize == "lowercase",
        resume_line: talk.get("resumeLine").and_then(crate::Value::string).unwrap_or("").to_string(),
    })
}

fn reported_identity(identity: &Value, conversation: &str, provider: &str, kind: &Kind) -> Value {
    let mut out = identity.clone();
    let object = out.as_object_mut().expect("an identity is an object");
    object.insert("agentId".to_string(), json!(conversation));
    object.insert("label".to_string(), json!(format!("{} {}", provider, kind.short(conversation))));
    object.insert(
        "session".to_string(),
        json!({
            "provider": provider,
            "id": conversation,
            "known": true,
            "source": "reported",
            "resume": kind.resume_line.replace("{id}", conversation),
        }),
    );
    out
}

/// A minimal HTTP POST, because the whole request is one small JSON document and an HTTP stack
/// is not a dependency this crate needs for it. Mirrors launcher/sidecar.mjs's request():
/// !response.ok throws the body's `error` or "Sidecar returned <status>".
fn post_json(url: &str, token: &str, body: &str) -> Result<(), String> {
    let after = url.strip_prefix("http://").ok_or("Invalid local workspace connection.")?;
    let (addr, path) = after.split_once('/').map(|(a, p)| (a, format!("/{p}"))).unwrap_or((after, "/".to_string()));
    let mut stream = std::net::TcpStream::connect(addr).map_err(|error| error.to_string())?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(10))).map_err(|error| error.to_string())?;
    stream.set_write_timeout(Some(std::time::Duration::from_secs(10))).map_err(|error| error.to_string())?;
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    use std::io::Write;
    stream.write_all(request.as_bytes()).map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream.read_to_string(&mut response).map_err(|error| error.to_string())?;
    let status: u16 = response
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    if !(200..300).contains(&status) {
        let body_text = response.split("\r\n\r\n").nth(1).unwrap_or("");
        let message = serde_json::from_str::<Value>(body_text)
            .ok()
            .and_then(|value| value.get("error").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| format!("Sidecar returned {status}"));
        return Err(message);
    }
    Ok(())
}

/// The CLI whose hook spelling does NOT carry a provider flag — so when nothing names one, this is
/// who reported (F219, spec 141).
///
/// rEngine WRITES that hook itself, in the settings file a `per-launch-settings` recipe is handed,
/// and the command it writes omits the flag. Every other spelling passes `--provider` explicitly.
/// So "who reports without saying so" is a capability the registry already declares, and reading it
/// there is the difference between deriving the answer and assuming claude — which is what this did
/// for as long as claude was the only CLI that reported at all. Two such recipes is not a guess this
/// can make, and it says so rather than picking.
fn unflagged_reporter(recipes: &[(String, crate::Value)]) -> Option<String> {
    let mut found = recipes.iter().filter(|(_, raw)| {
        raw.get("hooks")
            .and_then(|hooks| hooks.get("kind"))
            .and_then(crate::Value::string)
            .is_some_and(|kind| kind == "per-launch-settings")
    });
    let only = found.next()?;
    found.next().is_none().then(|| only.0.clone())
}

pub fn report_session(argv: &[String], recipes: &[(String, crate::Value)]) -> i32 {
    let env: std::collections::HashMap<String, String> = std::env::vars().collect();
    let mut notes: Vec<String> = Vec::new();
    let outcome = (|| -> Outcome {
        /* Read and parse the payload BEFORE deciding whether this hook is bound to anything. The JS
           reporter this replaces parsed stdin outside its binding check, so a hook wired up wrong
           said so even with nothing to report to; the port had it after the check and swallowed
           unparseable stdin into an empty object, which made exactly that case silent. A hook that
           cannot say it was handed garbage stays wired up wrong. */
        let mut input_text = String::new();
        if std::io::stdin().read_to_string(&mut input_text).is_err() {
            return fail("the hook payload could not be read");
        }
        let input: Value = match serde_json::from_str(&input_text) {
            Ok(value) => value,
            Err(error) => return fail(format!("the hook payload was not JSON: {error}")),
        };
        let Some(context_file) = binding_context(argv, &env) else {
            return Outcome { notes };
        };
        let context: Value = match std::fs::read_to_string(&context_file) {
            Ok(text) => match serde_json::from_str(&text) {
                Ok(value) => value,
                Err(error) => return fail(error.to_string()),
            },
            Err(error) => return fail(error.to_string()),
        };
        /* Who reported: the hook says so when its CLI's hook spelling carries a flag, and otherwise
           THIS LAUNCH'S OWN CONTEXT says so — rEngine wrote both, and the context names the CLI it
           was written for. This used to default to claude, from when claude was the only CLI that
           reported; a default is one CLI's name standing in for "whoever this launch is"
           (F219, spec 141), and it would have mis-attributed the first CLI to arrive without a
           flag in its hook spelling. */
        let provider = argv
            .iter()
            .position(|arg| arg == "--provider")
            .and_then(|index| argv.get(index + 1))
            .cloned()
            .or_else(|| {
                context
                    .get("agent")
                    .and_then(|agent| agent.get("session"))
                    .and_then(|session| session.get("provider"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .or_else(|| unflagged_reporter(recipes));
        let Some(provider) = provider else {
            return fail("the hook did not name a provider and nothing about this launch names a CLI");
        };
        let Some(kind) = provider_kind(&provider, recipes) else {
            return fail(format!("Unknown agent provider: {provider}"));
        };
        let conversation = kind.normalize(input.get("session_id").and_then(Value::as_str).unwrap_or(""));
        if conversation.is_empty() || !kind.matches(&conversation) {
            let event = input.get("hook_event_name").and_then(Value::as_str).unwrap_or("The hook");
            return fail(format!("{event} carried no session id."));
        }
        let (url, token) = match connection(&context) {
            Ok(pair) => pair,
            Err(message) => return fail(message),
        };
        let identity = context.get("agent").cloned().unwrap_or(Value::Null);
        let mut was: Option<String> = None;
        if identity.is_object() {
            let current = identity.get("agentId").and_then(Value::as_str).unwrap_or("");
            if kind.matches(current) && current != conversation {
                was = Some(current.to_string());
                let rewritten = {
                    let mut context = context.clone();
                    *context.as_object_mut().expect("a context is an object")
                        .get_mut("agent").expect("agent is present") = reported_identity(&identity, &conversation, &provider, &kind);
                    context
                };
                let temporary = format!("{context_file}.{}.tmp", std::process::id());
                let pretty = serde_json::to_string_pretty(&rewritten).expect("the context serializes");
                if let Err(error) = std::fs::write(&temporary, pretty) {
                    let _ = std::fs::remove_file(&temporary);
                    return fail(error.to_string());
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600));
                }
                if let Err(error) = std::fs::rename(&temporary, &context_file) {
                    let _ = std::fs::remove_file(&temporary);
                    return fail(error.to_string());
                }
            }
        }
        /* Posting every time, not only on a change: this is the one report that comes from the CLI
           itself, so a record the launcher could not write heals on the next session start. */
        if let Some(orchestrator_session) = env.get("RENGINE_ORCHESTRATOR_SESSION") {
            let body = format!("{{\"id\":{},\"conversation\":{},\"agent\":{}}}", json!(orchestrator_session), json!(conversation), json!(provider));
            let post_url = format!("{}/api/agent-conversation", url.trim_end_matches('/'));
            if let Err(message) = post_json(&post_url, &token, &body) {
                return fail(message);
            }
        }
        if let Some(was) = was {
            let short = |id: &str| id.chars().take(8).collect::<String>();
            notes.push(format!("{NOTE_PREFIX}this pane is conversation {} (was {}).", short(&conversation), short(&was)));
        }
        Outcome { notes }
    })();
    for note in &outcome.notes {
        eprintln!("{note}");
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
        pairs.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect()
    }

    #[test]
    fn binding_context_reads_in_order() {
        assert_eq!(binding_context(&["--context".to_string(), "argv.json".to_string()], &env(&[])), Some("argv.json".to_string()));
        assert_eq!(binding_context(&[], &env(&[("RENGINE_WORKSPACE_CONTEXT", "ws.json")])), Some("ws.json".to_string()));
        assert_eq!(binding_context(&[], &env(&[])), None);
    }

    #[test]
    fn the_connection_rules_are_the_js_ones() {
        assert!(connection(&json!({ "url": "http://127.0.0.1:4000", "token": "f".repeat(64) })).is_ok());
        assert!(connection(&json!({ "url": "http://example.com", "token": "f".repeat(64) })).is_err());
        assert!(connection(&json!({ "url": "http://127.0.0.1:4000", "token": "short" })).is_err());
    }
}
