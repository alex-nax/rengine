//! red-agents: the agent recipe registry as data (F148a, spec 129, KI-092; charter D46).
//!
//! One TOML document — `orchestrator/agents/registry.toml` — is the only recipe table: the
//! remaining JS (registry.mjs, until F149) and this crate both parse it, through the same bounded
//! subset, so the two sides resolve identical recipes for every CLI. The subset exists so "the
//! same document" means the same thing on both sides; a general TOML crate would accept a
//! superset the JS side refuses, and the parity proof would have a hole exactly where an author
//! makes a mistake.
//!
//! cook() mirrors registry.mjs's validation in the same words; project() produces the resolved
//! atom projection the cross-language parity test compares. The flag parsers named by a recipe
//! ('claude-flags', 'kimi-flags', 'codex-resume') stay code on each side — they are the read side
//! of a resume spelling, and F149 owns them.

use serde_json::json;

pub mod hooks;
pub mod parsers;
pub mod spawn;

/// One parsed value. Tables keep document order as a Vec so duplicate keys and duplicate tables
/// are detectable and the merged list reads the way the document does.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    String(String),
    Integer(i64),
    Boolean(bool),
    Array(Vec<Value>),
    Table(Vec<(String, Value)>),
}

impl Value {
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Table(entries) => entries.iter().find(|(name, _)| name == key).map(|(_, value)| value),
            _ => None,
        }
    }
    pub fn string(&self) -> Option<&str> {
        match self {
            Value::String(text) => Some(text),
            _ => None,
        }
    }
    pub fn integer(&self) -> Option<i64> {
        match self {
            Value::Integer(number) => Some(*number),
            _ => None,
        }
    }
    fn table(&self) -> Option<&Vec<(String, Value)>> {
        match self {
            Value::Table(entries) => Some(entries),
            _ => None,
        }
    }
}

fn fail_at(name: &str, line: usize, message: impl std::fmt::Display) -> String {
    format!("{name}:{line}: {message}")
}

fn value_at(source: &str, name: &str, line: usize) -> Result<(Value, usize), String> {
    let bytes = source.as_bytes();
    if bytes.first() == Some(&b'"') {
        let mut out = String::new();
        let mut i = 1;
        loop {
            let Some(&char) = bytes.get(i) else { return Err(fail_at(name, line, "unterminated string")); };
            match char {
                b'"' => return Ok((Value::String(out), i + 1)),
                b'\\' => {
                    let esc = bytes.get(i + 1).copied();
                    let simple = match esc {
                        Some(b'b') => Some('\u{8}'),
                        Some(b't') => Some('\t'),
                        Some(b'n') => Some('\n'),
                        Some(b'f') => Some('\u{c}'),
                        Some(b'r') => Some('\r'),
                        Some(b'"') => Some('"'),
                        Some(b'\\') => Some('\\'),
                        _ => None,
                    };
                    if let Some(char) = simple {
                        out.push(char);
                        i += 2;
                        continue;
                    }
                    if esc == Some(b'u') {
                        let hex = source.get(i + 2..i + 6).unwrap_or("");
                        if hex.len() != 4 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                            return Err(fail_at(name, line, "a bad \\u escape"));
                        }
                        let code = u32::from_str_radix(hex, 16).map_err(|_| fail_at(name, line, "a bad \\u escape"))?;
                        out.push(char::from_u32(code).ok_or_else(|| fail_at(name, line, "a bad \\u escape"))?);
                        i += 6;
                        continue;
                    }
                    return Err(fail_at(name, line, format!(
                        "the escape \\{} is outside the registry TOML subset",
                        esc.map(|b| b as char).unwrap_or_default()
                    )));
                }
                _ => {
                    let char = source[i..].chars().next().expect("a byte that is not NUL starts a char");
                    out.push(char);
                    i += char.len_utf8();
                }
            }
        }
    }
    if bytes.first() == Some(&b'\'') {
        let Some(end) = source[1..].find('\'') else { return Err(fail_at(name, line, "unterminated literal string")); };
        return Ok((Value::String(source[1..1 + end].to_string()), end + 2));
    }
    if bytes.first() == Some(&b'[') {
        let mut items = Vec::new();
        let mut i = 1;
        loop {
            while matches!(bytes.get(i), Some(b' ' | b'\t')) { i += 1; }
            if i >= source.len() { return Err(fail_at(name, line, "unterminated array")); }
            if bytes[i] == b']' { return Ok((Value::Array(items), i + 1)); }
            if !items.is_empty() {
                if bytes[i] != b',' { return Err(fail_at(name, line, "an array separates its values with commas")); }
                i += 1;
                while matches!(bytes.get(i), Some(b' ' | b'\t')) { i += 1; }
                if i >= source.len() { return Err(fail_at(name, line, "unterminated array")); }
                if bytes[i] == b']' { return Ok((Value::Array(items), i + 1)); }
            }
            let (item, end) = value_at(&source[i..], name, line)?;
            items.push(item);
            i += end;
        }
    }
    let end = source.find([' ', '\t', ',', ']']).unwrap_or(source.len());
    let word = &source[..end];
    match word {
        "true" => return Ok((Value::Boolean(true), end)),
        "false" => return Ok((Value::Boolean(false), end)),
        _ => {}
    }
    let digits = word.strip_prefix(['+', '-']).unwrap_or(word);
    if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        if let Ok(number) = word.parse::<i64>() {
            return Ok((Value::Integer(number), end));
        }
    }
    let shown: String = source.chars().take(24).collect();
    Err(fail_at(name, line, format!("{shown:?} is outside the registry TOML subset")))
}

fn bare_key(part: &str) -> bool {
    !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Parse one registry document. `name` is the label errors carry, so a refusal names the file a
/// person has open — the JS parser answers with the same `name:line: message` shape.
pub fn parse_toml(text: &str, name: &str) -> Result<Value, String> {
    let mut root = Value::Table(Vec::new());
    let mut defined: Vec<String> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    for (index, source) in text.lines().enumerate() {
        let no = index + 1;
        let bytes = source.as_bytes();
        let mut quote: Option<u8> = None;
        let mut cut = source.len();
        let mut i = 0;
        while i < bytes.len() {
            let char = bytes[i];
            match quote {
                Some(b'"') => {
                    if char == b'\\' { i += 1; } else if char == b'"' { quote = None; }
                }
                Some(b'\'') => {
                    if char == b'\'' { quote = None; }
                }
                _ => {
                    if char == b'"' || char == b'\'' { quote = Some(char); } else if char == b'#' { cut = i; break; }
                }
            }
            i += 1;
        }
        let rest = source[..cut].trim();
        if rest.is_empty() { continue; }
        if rest.starts_with('[') {
            if rest.starts_with("[[") || !rest.ends_with(']') {
                return Err(fail_at(name, no, "only [table] headers are in the registry TOML subset"));
            }
            let inner = rest[1..rest.len() - 1].trim();
            let parts: Vec<&str> = inner.split('.').map(str::trim).collect();
            if parts.iter().any(|part| !bare_key(part)) {
                return Err(fail_at(name, no, format!("a bad table header [{inner}]")));
            }
            let dotted = parts.join(".");
            if defined.contains(&dotted) {
                return Err(fail_at(name, no, format!("the table [{dotted}] is defined twice")));
            }
            defined.push(dotted.clone());
            // Navigate from the root, creating tables; a segment that is already a value refuses.
            let mut table = &mut root;
            for part in &parts {
                let Value::Table(entries) = table else { unreachable!("only tables hold tables"); };
                let position = match entries.iter().position(|(key, _)| key == part) {
                    Some(position) => {
                        if !matches!(entries[position].1, Value::Table(_)) {
                            return Err(fail_at(name, no, format!("[{dotted}] meets {part}, which is already a value")));
                        }
                        position
                    }
                    None => {
                        entries.push((part.to_string(), Value::Table(Vec::new())));
                        entries.len() - 1
                    }
                };
                table = &mut entries[position].1;
            }
            current = parts.iter().map(|part| part.to_string()).collect();
            continue;
        }
        let Some(eq) = rest.find('=') else {
            return Err(fail_at(name, no, format!("expected a [table] header or key = value, got {:?}", &rest[..rest.len().min(24)])));
        };
        let key = rest[..eq].trim();
        if !bare_key(key) {
            return Err(fail_at(name, no, format!("a bad key {key:?}")));
        }
        let after = rest[eq + 1..].trim();
        if after.is_empty() {
            return Err(fail_at(name, no, format!("{key} names no value")));
        }
        let (parsed, end) = value_at(after, name, no)?;
        if !after[end..].trim().is_empty() {
            return Err(fail_at(name, no, "trailing content after a value"));
        }
        // The current table, fresh from the root each line so no borrow outlives the iteration.
        let mut table = &mut root;
        for part in &current {
            let Value::Table(entries) = table else { unreachable!("the path holds only tables"); };
            let position = entries.iter().position(|(name, _)| name == part).expect("the header created it");
            table = &mut entries[position].1;
        }
        let Value::Table(entries) = table else { unreachable!("the path ends at a table"); };
        if entries.iter().any(|(name, _)| name == key) {
            return Err(fail_at(name, no, format!("{key} is defined twice")));
        }
        entries.push((key.to_string(), parsed));
    }
    Ok(root)
}

const MCP_OVERLAYS: [&str; 5] = ["flag", "config-args", "env-defaults", "env-inline", "project-file"];
const HOOK_OVERLAYS: [&str; 3] = ["per-launch-settings", "per-launch-config", "guided-bootstrap"];
const PARSERS: [&str; 3] = ["claude-flags", "kimi-flags", "codex-resume"];

fn agent_name(cli: &str) -> bool {
    let bytes = cli.as_bytes();
    !bytes.is_empty() && bytes.len() <= 32 && bytes[0].is_ascii_lowercase()
        && bytes[1..].iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn single_word(command: &str) -> bool {
    let bytes = command.as_bytes();
    !bytes.is_empty() && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// The validation registry.mjs's cook() applies, in the same words, so a bad recipe fails the
/// same way on whichever side reads it first.
pub fn cook(cli: &str, raw: &Value) -> Result<(), String> {
    if !agent_name(cli) {
        return Err(format!("Invalid agent name in the registry: {cli}"));
    }
    if raw.get("package").and_then(Value::string).map_or(true, str::is_empty) {
        return Err(format!("Registry recipe {cli} names no package."));
    }
    let update = raw.get("update");
    let kind = update.and_then(|u| u.get("kind")).and_then(Value::string);
    if !matches!(kind, Some("self" | "reinstall")) {
        return Err(format!("Registry recipe {cli} has an unknown update mode."));
    }
    if let Some(command) = update.and_then(|u| u.get("command")).and_then(Value::string) {
        if !single_word(command) {
            return Err(format!("Registry recipe {cli} names an update subcommand that is not a single word."));
        }
    }
    let mcp = raw.get("mcp").and_then(|m| m.get("kind")).and_then(Value::string);
    if !mcp.map_or(false, |kind| MCP_OVERLAYS.contains(&kind)) {
        return Err(format!("Registry recipe {cli} names an MCP overlay rEngine does not implement."));
    }
    if let Some(kind) = raw.get("hooks").and_then(|h| h.get("kind")).and_then(Value::string) {
        if !HOOK_OVERLAYS.contains(&kind) {
            return Err(format!("Registry recipe {cli} names a hooks overlay rEngine does not implement."));
        }
    }
    if let Some(talk) = raw.get("conversation") {
        let parser = talk.get("parser").and_then(Value::string);
        if !parser.map_or(false, |name| PARSERS.contains(&name)) {
            return Err(format!("Registry recipe {cli} names a conversation parser rEngine does not implement."));
        }
    }
    Ok(())
}

fn string_or_null(value: Option<&Value>) -> serde_json::Value {
    value.and_then(Value::string).map(|text| json!(text)).unwrap_or(serde_json::Value::Null)
}

fn args_or_null(value: Option<&Value>) -> serde_json::Value {
    match value.and_then(|table| table.get("args")) {
        Some(Value::Array(items)) => json!({ "args": items.iter().map(|item| item.string()).collect::<Vec<_>>() }),
        _ => serde_json::Value::Null,
    }
}

/// The resolved atom projection of one cooked recipe — exactly the shape registry.mjs's
/// resolvedRecipes() emits, omitted capabilities as explicit nulls, so the parity test can
/// deep-compare the two sides of the one document.
pub fn project(raw: &Value) -> serde_json::Value {
    let update = raw.get("update").expect("cook ran first");
    let models = raw.get("models");
    let mcp = raw.get("mcp").expect("cook ran first");
    json!({
        "package": raw.get("package").and_then(Value::string),
        "update": {
            "kind": update.get("kind").and_then(Value::string),
            "command": string_or_null(update.get("command")),
        },
        "model": raw.get("model").and_then(|m| m.get("flag")).and_then(Value::string).map(|flag| json!({ "flag": flag })),
        "models": {
            "kind": models.and_then(|m| m.get("kind")).and_then(Value::string).unwrap_or("none"),
            "list": models.and_then(|m| m.get("list")).map(|list| {
                let Value::Array(items) = list else { unreachable!("cook-shaped data") };
                items.iter().map(|item| item.string()).collect::<Vec<_>>()
            }),
            "default": string_or_null(models.and_then(|m| m.get("default"))),
        },
        "conversation": raw.get("conversation").map(|talk| json!({
            "start": args_or_null(talk.get("start")),
            "resume": args_or_null(talk.get("resume")),
            "ids": talk.get("ids").and_then(Value::string),
            "parser": talk.get("parser").and_then(Value::string),
            "short": {
                "stripPrefix": string_or_null(talk.get("short").and_then(|s| s.get("stripPrefix"))),
                "length": talk.get("short").and_then(|s| s.get("length")).and_then(Value::integer).unwrap_or(8),
            },
            "normalize": talk.get("normalize").and_then(Value::string),
            "provider": talk.get("provider").and_then(Value::string),
            "resumeLine": talk.get("resumeLine").and_then(Value::string),
        })),
        "mcp": {
            "kind": mcp.get("kind").and_then(Value::string),
            "envVar": string_or_null(mcp.get("envVar")),
        },
        "hooks": raw.get("hooks").map(|hooks| json!({ "kind": hooks.get("kind").and_then(Value::string) })),
        "ide": raw.get("ide").map(|ide| {
            let flags = match ide.get("flags") {
                Some(Value::Array(items)) => items.iter().map(|item| item.string()).collect::<Vec<_>>(),
                _ => Vec::new(),
            };
            json!({ "flags": flags, "envVar": ide.get("envVar").and_then(Value::string) })
        }),
    })
}

/// Parse, cook and merge the shipped registry with an optional extra file, in document order.
/// The extra file is the same shape under `recipes`; redeclaring a shipped recipe is refused in
/// the same words the JS side uses.
pub fn load_registry(registry: &str, registry_name: &str, extra: Option<(&str, &str)>) -> Result<Vec<(String, Value)>, String> {
    let shipped = parse_toml(registry, registry_name)?;
    let recipes = shipped.get("recipes").and_then(Value::table)
        .ok_or("The agent registry must be a TOML document with a recipes table.")?;
    let mut merged = recipes.clone();
    for (cli, raw) in &merged {
        cook(cli, raw)?;
    }
    if let Some((text, name)) = extra {
        let declared = parse_toml(text, name)?;
        let entries = declared.get("recipes").and_then(Value::table)
            .ok_or("An extra agent registry must be a TOML document with a recipes table.")?;
        for (cli, raw) in entries {
            if merged.iter().any(|(name, _)| name == cli) {
                return Err(format!("Extra agent registry redeclares {cli}, which is already in the registry."));
            }
            cook(cli, raw)?;
            merged.push((cli.clone(), raw.clone()));
        }
    }
    Ok(merged)
}

/// The whole merged registry as one JSON object, cli -> projection.
pub fn projection(recipes: &[(String, Value)]) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for (cli, raw) in recipes {
        map.insert(cli.clone(), project(raw));
    }
    serde_json::Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shipped() -> Vec<(String, Value)> {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../orchestrator/agents/registry.toml");
        let text = std::fs::read_to_string(path).expect("the shipped registry document");
        load_registry(&text, "orchestrator/agents/registry.toml", None).expect("it cooks")
    }

    #[test]
    fn the_shipped_document_carries_the_five_clis_in_order() {
        let recipes = shipped();
        let names: Vec<&str> = recipes.iter().map(|(cli, _)| cli.as_str()).collect();
        assert_eq!(names, ["claude", "codex", "gemini", "opencode", "kimi"]);
        let kimi = &recipes[4].1;
        let ids = kimi.get("conversation").and_then(|c| c.get("ids")).and_then(Value::string).unwrap();
        assert!(ids.contains("{8}") && ids.contains("session_"), "the literal string kept its backslashes: {ids}");
        let claude = &recipes[0].1;
        let Some(Value::Array(models)) = claude.get("models").and_then(|m| m.get("list")) else { panic!("claude lists models") };
        assert_eq!(models.len(), 4);
        assert!(recipes[2].1.get("conversation").is_none(), "gemini names no conversation");
        assert!(recipes[2].1.get("hooks").is_none(), "gemini names no hooks");
    }

    #[test]
    fn the_projection_carries_the_atoms_and_the_explicit_nulls() {
        let projection = projection(&shipped());
        assert_eq!(projection["kimi"]["conversation"]["short"]["stripPrefix"], "session_");
        assert_eq!(projection["kimi"]["conversation"]["short"]["length"], 8);
        assert!(projection["kimi"]["conversation"]["start"].is_null(), "kimi resumes but is never told which to start");
        assert!(projection["codex"]["ide"].is_null());
        assert!(projection["gemini"]["conversation"].is_null());
        assert_eq!(projection["gemini"]["models"]["kind"], "none");
        assert_eq!(projection["claude"]["models"]["list"][0], "claude-fable-5-1");
        assert_eq!(projection["opencode"]["mcp"]["envVar"], "OPENCODE_CONFIG_CONTENT");
        assert_eq!(projection["claude"]["hooks"]["kind"], "per-launch-settings");
    }

    #[test]
    fn the_subset_refuses_with_a_line_number() {
        let cases: &[(&str, usize, &str)] = &[
            ("kind = { self = true }", 1, "outside the registry TOML subset"),
            ("package = \"unterminated", 1, "unterminated string"),
            ("a = 1\na = 2", 2, "defined twice"),
            ("[a]\nx = 1\n[a]\ny = 2", 3, "defined twice"),
            ("x = \"a \\q b\"", 1, "outside the registry TOML subset"),
            ("x = 1 trailing", 1, "trailing content"),
            ("[[a]]", 1, "only [table] headers"),
            ("x = [1 2]", 1, "separates its values with commas"),
            ("not a line", 1, "expected a [table] header or key = value"),
            ("x = 'open", 1, "unterminated literal string"),
        ];
        for (text, line, word) in cases {
            let error = parse_toml(text, "case.toml").expect_err("each case refuses");
            assert!(error.starts_with(&format!("case.toml:{line}: ")), "{error} names the line");
            assert!(error.contains(word), "{error} names the reason");
        }
        // And the same refusals survive a comment and a # inside a string.
        let text = "# a comment\n[recipes.x]\npackage = \"@test/x\" # trailing comment\nids = 'a # not a comment'\n";
        let parsed = parse_toml(text, "ok.toml").expect("comments and quoted # parse");
        assert_eq!(parsed.get("recipes").and_then(|r| r.get("x")).and_then(|x| x.get("ids")).and_then(Value::string), Some("a # not a comment"));
    }

    #[test]
    fn cook_refuses_what_the_js_side_refuses() {
        let bad_update = parse_toml("[recipes.x]\npackage=\"@t/x\"\n[recipes.x.update]\nkind=\"weird\"\n[recipes.x.mcp]\nkind=\"flag\"\n", "t.toml").unwrap();
        assert!(cook("x", bad_update.get("recipes").unwrap().get("x").unwrap()).unwrap_err().contains("unknown update mode"));
        let bad_mcp = parse_toml("[recipes.x]\npackage=\"@t/x\"\n[recipes.x.update]\nkind=\"reinstall\"\n[recipes.x.mcp]\nkind=\"warp\"\n", "t.toml").unwrap();
        assert!(cook("x", bad_mcp.get("recipes").unwrap().get("x").unwrap()).unwrap_err().contains("MCP overlay"));
        let bad_parser = parse_toml("[recipes.x]\npackage=\"@t/x\"\n[recipes.x.update]\nkind=\"reinstall\"\n[recipes.x.mcp]\nkind=\"flag\"\n[recipes.x.conversation]\nparser=\"telepathy\"\n", "t.toml").unwrap();
        assert!(cook("x", bad_parser.get("recipes").unwrap().get("x").unwrap()).unwrap_err().contains("conversation parser"));
        assert!(cook("Bad Name", bad_update.get("recipes").unwrap().get("x").unwrap()).unwrap_err().contains("Invalid agent name"));
    }

    #[test]
    fn an_extra_merges_and_a_redeclaration_is_refused() {
        let registry = "[recipes.claude]\npackage=\"@a/claude\"\n[recipes.claude.update]\nkind=\"self\"\ncommand=\"update\"\n[recipes.claude.mcp]\nkind=\"flag\"\n";
        let extra = "[recipes.testcli]\npackage=\"@t/testcli\"\n[recipes.testcli.update]\nkind=\"reinstall\"\n[recipes.testcli.mcp]\nkind=\"flag\"\n";
        let merged = load_registry(registry, "r.toml", Some((extra, "extra.toml"))).expect("the extra merges");
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[1].0, "testcli");
        let clash = extra.replace("testcli", "claude");
        let error = load_registry(registry, "r.toml", Some((&clash, "clash.toml"))).unwrap_err();
        assert_eq!(error, "Extra agent registry redeclares claude, which is already in the registry.");
    }
}
