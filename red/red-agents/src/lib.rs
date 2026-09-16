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

pub mod bind;
/// The mint and the clock: two binaries need them, and two copies would drift.
pub mod mint {
    pub fn uuid_v4() -> String {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).expect("the operating system answers randomness");
        bytes[6] = bytes[6] & 0x0f | 0x40;
        bytes[8] = bytes[8] & 0x3f | 0x80;
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
    }
    /* ISO-8601 with milliseconds, the shape `new Date().toISOString()` writes, because the identity's
       startedAt is read back by JS and by the desktop. */
    pub fn now_iso() -> String {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let (seconds, sub) = (millis.div_euclid(1000), millis.rem_euclid(1000));
        let days = seconds.div_euclid(86_400);
        let time = seconds.rem_euclid(86_400);
        // Civil-from-days (Howard Hinnant's algorithm), so no date crate is needed for one field.
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = if m <= 2 { y + 1 } else { y };
        format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{sub:03}Z", time / 3600, (time % 3600) / 60, time % 60)
    }
}

pub mod handoff;

/// The registry document this build reads: `$RENGINE_AGENT_REGISTRY`, else the one beside the
/// checkout's `orchestrator/agents/`. Here rather than beside one binary because three of them ask.
pub fn registry_path() -> Result<String, String> {
    if let Ok(declared) = std::env::var("RENGINE_AGENT_REGISTRY") {
        return Ok(declared);
    }
    let exe = std::env::current_exe().map_err(|error| format!("the registry document needs RENGINE_AGENT_REGISTRY: {error}"))?;
    // red/target/debug/<binary> -> debug/ .. target/ .. red/ .. the repository root.
    exe.parent()
        .and_then(|directory| directory.ancestors().nth(3))
        .map(|root| root.join("orchestrator/agents/registry.toml").to_string_lossy().into_owned())
        .ok_or_else(|| "the registry document needs RENGINE_AGENT_REGISTRY".to_string())
}

/// Every declared recipe, with the extra document read at call time — a recipe added as data needs
/// no process restart, which is what the JavaScript this replaces promised.
pub fn recipes() -> Result<Vec<(String, Value)>, String> {
    let path = registry_path()?;
    let text = std::fs::read_to_string(&path).map_err(|error| format!("cannot read {path}: {error}"))?;
    let extra = match std::env::var("RENGINE_AGENT_REGISTRY_EXTRA") {
        Ok(extra_path) if !extra_path.is_empty() => {
            let extra_text = std::fs::read_to_string(&extra_path).map_err(|error| format!("cannot read {extra_path}: {error}"))?;
            Some((extra_text, extra_path))
        }
        _ => None,
    };
    load_registry(&text, &path, extra.as_ref().map(|(text, path)| (text.as_str(), path.as_str())))
}

pub mod hooks;
pub mod launch;
pub mod parsers;
pub mod report;
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
/* The resume spellings `parsers.rs` implements, named for what they do (spec 141). A recipe
   declares which one it speaks; nothing here knows which CLI that is. */
const READ_SPELLINGS: [&str; 2] = ["flags", "subcommand"];

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
    /* An overlay KIND is a capability rEngine implements; every spelling inside it is the recipe's
       to say, and a recipe that names a kind without its spellings is refused here rather than at
       the launch that needed it (F214, spec 141). */
    for key in required_spellings(mcp.unwrap_or("")) {
        if raw.get("mcp").and_then(|m| m.get(key)).and_then(Value::string).is_none() {
            return Err(format!("Registry recipe {cli} declares the {} MCP overlay without `{key}`.", mcp.unwrap_or("")));
        }
    }
    if let Some(kind) = raw.get("hooks").and_then(|h| h.get("kind")).and_then(Value::string) {
        if kind == "per-launch-settings" && raw.get("hooks").and_then(|h| h.get("flag")).and_then(Value::string).is_none() {
            return Err(format!("Registry recipe {cli} is handed per-launch settings without declaring the flag that carries them."));
        }
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
        if let Some(read) = talk.get("read") {
            let kind = read.get("kind").and_then(Value::string);
            if !kind.map_or(false, |kind| READ_SPELLINGS.contains(&kind)) {
                return Err(format!("Registry recipe {cli} names a conversation read spelling rEngine does not implement."));
            }
        }
    }
    Ok(())
}

fn string_or_null(value: Option<&Value>) -> serde_json::Value {
    value.and_then(Value::string).map(|text| json!(text)).unwrap_or(serde_json::Value::Null)
}

fn strings_or_null(value: Option<&Value>) -> serde_json::Value {
    match value {
        Some(Value::Array(items)) => json!(items.iter().map(|item| item.string()).collect::<Vec<_>>()),
        _ => serde_json::Value::Null,
    }
}

fn args_or_null(value: Option<&Value>) -> serde_json::Value {
    match value.and_then(|table| table.get("args")) {
        Some(Value::Array(items)) => json!({ "args": items.iter().map(|item| item.string()).collect::<Vec<_>>() }),
        _ => serde_json::Value::Null,
    }
}

/// Does this id have the shape a recipe declares? The pattern is the recipe's, matched with a real
/// engine — **the one place any conversation id shape is judged** (spec 141 decision 1). `parsers`,
/// `launch` and `red-store` all ask here, so no two of them can disagree about what a CLI's ids look
/// like. They did: two hand-rolled copies read kimi's pattern by sniffing for substrings and picked
/// the wrong alternative for ids that accept a uuid OR a ULID with an optional prefix.
pub fn id_matches(pattern: &str, id: &str) -> bool {
    regex::RegexBuilder::new(pattern)
        .case_insensitive(true)
        .build()
        .map(|expression| expression.is_match(id))
        .unwrap_or(false)
}

/// What each MCP overlay kind needs the recipe to spell out. The kind is rEngine's to implement;
/// the flag, the file and the variable are the CLI's, and declaring one without them is refused.
fn required_spellings(kind: &str) -> &'static [&'static str] {
    match kind {
        "flag" | "config-args" => &["flag"],
        "project-file" => &["path"],
        "env-defaults" => &["pathVar", "path"],
        "env-inline" => &["envVar"],
        _ => &[],
    }
}

/// The capabilities declared AFTER registry.mjs was deleted, patched onto a recipe's view.
///
/// `project()` is **frozen evidence**: it emits exactly the shape `registry.mjs`'s
/// `resolvedRecipes()` emitted, and `agent-registry-toml.test.mjs` deep-compares it against a record
/// taken before that module was deleted, which by its own terms must never be regenerated. A
/// capability declared since cannot appear in that answer, and widening the projection to carry one
/// would turn a parity proof into a comparison against itself.
///
/// So every later declaration lands here instead, and **this is the one list to add the next one
/// to**. `launch::projected` applies it, so everything inside the crate reads one complete view
/// while the artifact the parity test compares stays byte-identical to the record.
fn declared_since(raw: &Value, view: &mut serde_json::Value) {
    let Some(table) = view.as_object_mut() else { return };
    /* F213: how this CLI's resume spellings are read — a spelling, not a name. */
    if let Some(read) = conversation_read(raw) {
        if let Some(talk) = table.get_mut("conversation").and_then(serde_json::Value::as_object_mut) {
            talk.insert("read".to_string(), read);
        }
    }
    /* F214: how an MCP overlay reaches this CLI — the file a `project-file` overlay is written to,
       relative to the project root; the flag a `flag` overlay is consumed with; the environment
       variable an `env-defaults` overlay names its file in. The launch path implements the KINDS;
       every spelling belongs to the recipe. */
    for key in ["path", "flag", "pathVar"] {
        if let Some(value) = raw.get("mcp").and_then(|mcp| mcp.get(key)).and_then(Value::string) {
            if let Some(mcp) = table.get_mut("mcp").and_then(serde_json::Value::as_object_mut) {
                mcp.insert(key.to_string(), json!(value));
            }
        }
    }
    /* F220: the rest of an `ide` block, which `project()` carries only the flags and env var of.
       red-ide implements one CLI's editor protocol and is handed the spellings rather than keeping
       them, the way it is already handed the environment it answers about. */
    if let Some(ide) = raw.get("ide") {
        if let Some(table) = view_ide(table) {
            for key in ["configVar", "configDirectory", "authHeader"] {
                if let Some(value) = ide.get(key).and_then(Value::string) {
                    table.insert(key.to_string(), json!(value));
                }
            }
        }
    }
    /* F220: the environment variables this CLI stamps on its children, and where it installs
       itself. Both are things a pane's environment must know about EVERY declared CLI, not about
       whichever one this launch is — so they are read as a union, and each is one recipe's to say. */
    for key in ["identity", "install"] {
        if let Some(block) = raw.get(key) {
            table.insert(key.to_string(), json!({
                "vars": strings_or_null(block.get("vars")),
                "path": block.get("path").and_then(Value::string),
            }));
        }
    }
    /* F216: what this CLI can be handed — a paused conversation by manifest — and what "ready to
       resume" means for it. */
    if let Some(handoff) = raw.get("conversation").and_then(|talk| talk.get("handoff")) {
        if let Some(talk) = table.get_mut("conversation").and_then(serde_json::Value::as_object_mut) {
            talk.insert("handoff".to_string(), json!({
                "kind": handoff.get("kind").and_then(Value::string),
                "ready": strings_or_null(handoff.get("ready")),
            }));
        }
    }
    /* F214: the flag that hands a `per-launch-settings` CLI the settings written for its launch. */
    if let Some(flag) = raw.get("hooks").and_then(|hooks| hooks.get("flag")).and_then(Value::string) {
        if let Some(hooks) = table.get_mut("hooks").and_then(serde_json::Value::as_object_mut) {
            hooks.insert("flag".to_string(), json!(flag));
        }
    }
}

fn view_ide(table: &mut serde_json::Map<String, serde_json::Value>) -> Option<&mut serde_json::Map<String, serde_json::Value>> {
    table.get_mut("ide").and_then(serde_json::Value::as_object_mut)
}

/// The shipped registry as it sits beside the running binary, plus an extra document when a caller
/// names one. The crates that need what EVERY CLI declares — the store's id shapes, the project's
/// roster and command environment, the editor bridge's protocol — all asked this question, and
/// three copies of the answer is two too many (F220, spec 141).
///
/// Empty when no document can be read, which is an honest "nothing is declared here" rather than a
/// guess at what is.
pub fn shipped_recipes() -> Vec<(String, Value)> {
    let path = std::env::var("RENGINE_AGENT_REGISTRY").ok().filter(|path| !path.is_empty()).unwrap_or_else(|| {
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
    let Ok(text) = std::fs::read_to_string(&path) else { return Vec::new() };
    let extra = std::env::var("RENGINE_AGENT_REGISTRY_EXTRA")
        .ok()
        .filter(|path| !path.is_empty())
        .and_then(|path| std::fs::read_to_string(&path).ok().map(|text| (text, path)));
    load_registry(&text, &path, extra.as_ref().map(|(text, path)| (text.as_str(), path.as_str()))).unwrap_or_default()
}

/// A recipe's whole view as this crate reads it: the frozen projection with `declared_since`
/// applied. Every consumer inside the crate goes through here, so no two of them can disagree about
/// what one recipe declares.
pub fn view(raw: &Value) -> serde_json::Value {
    let mut view = project(raw);
    declared_since(raw, &mut view);
    view
}

/// How this recipe's resume spellings are READ, for `parsers` (F213, spec 141): the declared
/// spelling and its data. It rides on the conversation view, which carries the id shape and the
/// normalisation that reading an id needs.
///
/// `None` when the recipe declares no read spelling: an honest "this CLI has not said", not a guess.
pub fn conversation_read(raw: &Value) -> Option<serde_json::Value> {
    let read = raw.get("conversation")?.get("read")?;
    Some(json!({
        "kind": read.get("kind").and_then(Value::string),
        "names": strings_or_null(read.get("names")),
        "opaque": strings_or_null(read.get("opaque")),
        "word": string_or_null(read.get("word")),
        "valueFlags": strings_or_null(read.get("valueFlags")),
    }))
}

/// The resolved atom projection of one cooked recipe — exactly the shape registry.mjs's
/// resolvedRecipes() emits, omitted capabilities as explicit nulls, so the parity test can
/// deep-compare the two sides of the one document. **Frozen**: see `conversation_read` for why a
/// newly declared capability does not belong here.
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
        let bad_update = parse_toml("[recipes.x]\npackage=\"@t/x\"\n[recipes.x.update]\nkind=\"weird\"\n[recipes.x.mcp]\nkind=\"flag\"\nflag=\"--servers\"\n", "t.toml").unwrap();
        assert!(cook("x", bad_update.get("recipes").unwrap().get("x").unwrap()).unwrap_err().contains("unknown update mode"));
        let bad_mcp = parse_toml("[recipes.x]\npackage=\"@t/x\"\n[recipes.x.update]\nkind=\"reinstall\"\n[recipes.x.mcp]\nkind=\"warp\"\n", "t.toml").unwrap();
        assert!(cook("x", bad_mcp.get("recipes").unwrap().get("x").unwrap()).unwrap_err().contains("MCP overlay"));
        let bad_parser = parse_toml("[recipes.x]\npackage=\"@t/x\"\n[recipes.x.update]\nkind=\"reinstall\"\n[recipes.x.mcp]\nkind=\"flag\"\nflag=\"--servers\"\n[recipes.x.conversation]\nparser=\"telepathy\"\n", "t.toml").unwrap();
        assert!(cook("x", bad_parser.get("recipes").unwrap().get("x").unwrap()).unwrap_err().contains("conversation parser"));
        assert!(cook("Bad Name", bad_update.get("recipes").unwrap().get("x").unwrap()).unwrap_err().contains("Invalid agent name"));
    }

    /* The read spelling is validated the way the overlays are: a recipe may only ask for one
       `parsers.rs` implements, and asking for one it does not is refused at cook rather than
       becoming a silent "this CLI has not told us how to read it" at launch. */
    #[test]
    fn a_read_spelling_rengine_does_not_implement_is_refused() {
        let recipe = |spelling: &str| {
            format!("[recipes.x]\npackage=\"@t/x\"\n[recipes.x.update]\nkind=\"reinstall\"\n[recipes.x.mcp]\nkind=\"flag\"\nflag=\"--servers\"\n[recipes.x.conversation]\nparser=\"claude-flags\"\n[recipes.x.conversation.read]\nkind=\"{spelling}\"\n")
        };
        let cooked = |spelling: &str| {
            let parsed = parse_toml(&recipe(spelling), "t.toml").unwrap();
            cook("x", parsed.get("recipes").unwrap().get("x").unwrap())
        };
        assert!(cooked("telepathy").unwrap_err().contains("conversation read spelling"));
        for spelling in READ_SPELLINGS {
            assert!(cooked(spelling).is_ok(), "{spelling} is a spelling parsers.rs implements");
        }
    }

    /* A KIND is rEngine's to implement; the spellings inside it are the CLI's. A recipe that names
       a kind and leaves its spellings out used to inherit claude's `--mcp-config` or kimi's
       `.kimi-code/mcp.json` — one CLI's spelling imposed on every other (F214, spec 141). */
    #[test]
    fn an_overlay_kind_without_its_spellings_is_refused_by_name() {
        let recipe = |mcp: &str| format!("[recipes.x]\npackage=\"@t/x\"\n[recipes.x.update]\nkind=\"reinstall\"\n[recipes.x.mcp]\n{mcp}");
        let cooked = |mcp: &str| {
            let parsed = parse_toml(&recipe(mcp), "t.toml").unwrap();
            cook("x", parsed.get("recipes").unwrap().get("x").unwrap())
        };
        for (mcp, missing) in [
            ("kind=\"flag\"\n", "flag"),
            ("kind=\"project-file\"\n", "path"),
            ("kind=\"env-inline\"\n", "envVar"),
            ("kind=\"env-defaults\"\npath=\"d.json\"\n", "pathVar"),
            ("kind=\"env-defaults\"\npathVar=\"VAR\"\n", "path"),
        ] {
            let refusal = cooked(mcp).unwrap_err();
            assert!(refusal.contains(&format!("`{missing}`")), "{mcp} should be refused for {missing}, said: {refusal}");
        }
        assert!(cooked("kind=\"flag\"\nflag=\"--servers\"\n").is_ok(), "a kind with its spelling is accepted");
        /* And the settings flag, which belongs to the CLI the same way. */
        let hooked = |hooks: &str| {
            let text = format!("[recipes.x]\npackage=\"@t/x\"\n[recipes.x.update]\nkind=\"reinstall\"\n[recipes.x.mcp]\nkind=\"flag\"\nflag=\"--servers\"\n[recipes.x.hooks]\n{hooks}");
            let parsed = parse_toml(&text, "t.toml").unwrap();
            cook("x", parsed.get("recipes").unwrap().get("x").unwrap())
        };
        assert!(hooked("kind=\"per-launch-settings\"\n").unwrap_err().contains("flag that carries them"));
        assert!(hooked("kind=\"per-launch-settings\"\nflag=\"--settings\"\n").is_ok());
    }

    /* The declared block must reach the parser. It rides on `talk_of`'s view rather than inside
       `project()`, so a projection that drops it leaves every launch minting its own id — which is
       what F213 shipped broken for an afternoon. */
    #[test]
    fn the_declared_read_block_reaches_the_conversation_view() {
        let recipes = load_registry(&std::fs::read_to_string("../../orchestrator/agents/registry.toml").unwrap(), "registry.toml", None).unwrap();
        for (cli, spelling) in [("claude", "flags"), ("kimi", "flags"), ("codex", "subcommand")] {
            let talk = launch::conversation_of(&recipes, cli).expect("a shipped CLI that resumes");
            assert_eq!(talk.get("read").and_then(|read| read.get("kind")).and_then(serde_json::Value::as_str), Some(spelling),
                       "{cli} carries its declared read spelling into the view parsers reads");
            assert!(talk.get("ids").and_then(serde_json::Value::as_str).is_some(), "{cli} keeps the projected atoms alongside it");
        }
    }

    #[test]
    fn an_extra_merges_and_a_redeclaration_is_refused() {
        let registry = "[recipes.claude]\npackage=\"@a/claude\"\n[recipes.claude.update]\nkind=\"self\"\ncommand=\"update\"\n[recipes.claude.mcp]\nkind=\"flag\"\nflag=\"--servers\"\n";
        let extra = "[recipes.testcli]\npackage=\"@t/testcli\"\n[recipes.testcli.update]\nkind=\"reinstall\"\n[recipes.testcli.mcp]\nkind=\"flag\"\nflag=\"--servers\"\n";
        let merged = load_registry(registry, "r.toml", Some((extra, "extra.toml"))).expect("the extra merges");
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[1].0, "testcli");
        let clash = extra.replace("testcli", "claude");
        let error = load_registry(registry, "r.toml", Some((&clash, "clash.toml"))).unwrap_err();
        assert_eq!(error, "Extra agent registry redeclares claude, which is already in the registry.");
    }
}
