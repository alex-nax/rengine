//! What a project says about itself: `readDeclaration` from `formats.mjs` (F156b, spec 129).
//!
//! A declaration is READ, never trusted. Every judgement here answers one question — may this
//! workspace do what the document asks of it — and the answer is a REPORT rather than an exception,
//! because a project that will not load must still say why in a pane a person is looking at.
//!
//! Two disciplines run through it. **A block's problem disables that block alone**: a broken tracker
//! must not take the formats with it, so each section is reported under its own key and the rest of
//! the document survives. And **a key below its contract floor is refused by name**, because a
//! project that declared something this workspace is too old to understand should be told which
//! contract to move to rather than which key to delete.
//!
//! The answers are recorded in `orchestrator/tests/declaration-fixtures.json` as the JavaScript
//! wrote them, and this is judged against that record.

use serde_json::{json, Map, Value};

use crate::rules::{
    dashboard_rules, devices_rules, games_rules, name_of, quoted, report, root_relative, uses, Context,
};

pub const CONTRACTS: [i64; 10] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
/// Brand-mark colours a project may name: each is a saturated fill the design system pairs with the
/// on-accent ink, which is what keeps the letter legible in every preset.
pub const ICON_TOKENS: [&str; 5] = ["accent", "ok", "warn", "err", "info"];
pub const DEFAULT_TIMEOUT_MS: i64 = 10000;
pub const DEFAULT_MAX_BYTES: i64 = 4 * 1024 * 1024;
const MAX_DECLARATION_BYTES: usize = 256 * 1024;

/// The contract document, compiled into the binary the way red-mcp carries its tool surface: a
/// reader that had to find a file beside itself would be a reader that stops working when it is
/// installed somewhere else.
const SCHEMA: &str = include_str!("../../../contracts/project-v1.schema.json");

fn schema() -> Value {
    serde_json::from_str(SCHEMA).expect("the committed contract parses")
}

fn problem(source: &str, message: &str) -> Value {
    json!({ "declared": true, "source": source, "error": format!("{source}: {message}"), "formats": [] })
}

/// `bounded`: a preview or entry command carries the budget it will be run under, so a caller never
/// has to know the defaults.
fn bounded(spec: Option<&Value>) -> Option<Value> {
    let spec = spec?;
    let mut map = spec.as_object()?.clone();
    map.entry("timeoutMs".to_string()).or_insert_with(|| json!(DEFAULT_TIMEOUT_MS));
    map.entry("maxBytes".to_string()).or_insert_with(|| json!(DEFAULT_MAX_BYTES));
    Some(Value::Object(map))
}

fn language_server_rules(block: &Value) -> Vec<String> {
    let Some(items) = block.as_array() else { return Vec::new() };
    let mut problems = Vec::new();
    let mut seen: Vec<Value> = Vec::new();
    for (index, server) in items.iter().enumerate() {
        let id = server.get("id").cloned().unwrap_or(Value::Null);
        if seen.contains(&id) {
            problems.push(format!("$.languageServers[{index}] repeats id {}", server.get("id").and_then(Value::as_str).unwrap_or("undefined")));
        }
        seen.push(id);
    }
    problems
}

fn tracker_rules(block: &Value, contract: i64) -> Vec<String> {
    let mut problems = Vec::new();
    let provider = block.get("provider").and_then(Value::as_str).unwrap_or_default();
    for (named, key) in [("github", "repository"), ("linear", "team")] {
        if provider == named && block.get(key).is_none() {
            problems.push(format!("$.tracker requires {key} for provider {named}"));
        }
    }
    for (named, key) in [("github", "repository"), ("linear", "team")] {
        if provider != named && block.get(key).is_some() {
            problems.push(format!("$.tracker {key} belongs to provider {named}"));
        }
    }
    if provider != "local" && block.get("inventory").is_some() {
        problems.push("$.tracker inventory belongs to provider local".to_string());
    }
    /* The narrowing keys are Linear's alone. A backend that cannot honour a declared filter refuses
       it by name rather than ignoring it, because a list that quietly answers a wider question than
       the one asked looks exactly like a correct answer (spec 100 decision 4). */
    for key in ["project", "assignee", "states"] {
        if provider != "linear" && block.get(key).is_some() {
            problems.push(format!("$.tracker {key} belongs to provider linear"));
        }
    }
    /* The one key of this block that is WRITTEN rather than read (spec 103 decision 8). Its floor is
       checked here rather than with the section, because the block is contract 5 and only this key
       is contract 6; without it a contract-5 project would have the key accepted in silence. */
    if let Some(write) = block.get("write") {
        if provider != "local" {
            problems.push("$.tracker write belongs to provider local".to_string());
        }
        if contract < 6 {
            problems.push(format!("$.tracker write requires contract 6 (declared contract {contract})"));
        }
        if let Some(argv) = write.as_array() {
            if !argv.iter().any(|argument| argument.as_str().is_some_and(|text| text.contains("${json}"))) {
                problems.push("$.tracker.write must name ${json} in one of its arguments".to_string());
            }
        }
    }
    problems
}

fn agents_rules(value: &Value) -> Vec<String> {
    let Some(items) = value.get("agents").and_then(Value::as_array) else { return Vec::new() };
    let mut problems = Vec::new();
    let mut seen: Vec<Value> = Vec::new();
    for (index, record) in items.iter().enumerate() {
        if !record.is_object() {
            continue;
        }
        let at = format!("$.agents[{index}]");
        let cli = record.get("cli").cloned().unwrap_or(Value::Null);
        if seen.contains(&cli) {
            problems.push(format!("{at}.cli repeats {}", quoted(record.get("cli"))));
        }
        seen.push(cli);
        if let Some(models) = record.get("models").and_then(Value::as_array) {
            let default = record.get("default").cloned().unwrap_or(Value::Null);
            if !models.contains(&default) {
                problems.push(format!("{at}.default must be one of its models"));
            }
        }
    }
    problems
}

const FACETS: [(&str, [&str; 2]); 2] = [("library", ["path", "target"]), ("plugin", ["module", "abi"])];

fn hex_digest(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn packs_rules(block: &Value) -> Vec<String> {
    let Some(items) = block.as_array() else { return Vec::new() };
    let mut problems = Vec::new();
    let mut seen: Vec<Value> = Vec::new();
    for (index, pack) in items.iter().enumerate() {
        if !pack.is_object() {
            continue;
        }
        let at = format!("$.packs[{index}]");
        /* A pack is named by its NAME — the word people say — where every other record here is named
           by its id. `packName` in the JS, and the difference is the point: a pack has no id. */
        let where_ = match pack.get("name").and_then(Value::as_str).filter(|name| !name.is_empty()) {
            Some(name) => format!("{at} ({name})"),
            None => at.clone(),
        };
        if let Some(name) = pack.get("name").filter(|value| value.is_string()) {
            if seen.contains(name) {
                problems.push(format!("{at}.name repeats {name}"));
            }
            seen.push(name.clone());
        }
        if !FACETS.iter().any(|(facet, _)| pack.get(*facet).is_some()) {
            problems.push(format!("{where_} declares no facet; a pack declares library, plugin or both"));
        }
        for (facet, keys) in FACETS {
            let Some(value) = pack.get(facet).filter(|value| value.is_object()) else { continue };
            /* A key in the wrong facet is refused twice: structurally as an unknown key, and here by
               the facet that owns it, which is the half that says what to do about it. */
            for (other, own_keys) in FACETS {
                if other == facet {
                    continue;
                }
                for key in own_keys {
                    if value.get(key).is_some() && !keys.contains(&key) {
                        problems.push(format!("{where_}.{facet}.{key} belongs to the {other} facet"));
                    }
                }
            }
            for key in ["path", "module"] {
                if keys.contains(&key) {
                    if let Some(named) = value.get(key).filter(|value| value.is_string()) {
                        if !root_relative(named) {
                            problems.push(format!("{where_}.{facet}.{key} must be root-relative"));
                        }
                    }
                }
            }
        }
        /* D45 removed the key outright: a declaration says what a project CONSUMES, and an adoption
           is recorded by the owner's sign-off in a spec, not announced by the project that made it. */
        if pack.get("poweredBy").is_some() {
            problems.push(format!(
                "{where_}.poweredBy was removed: an adoption is recorded by the owner's sign-off in a spec (charter D45), not claimed in a declaration"
            ));
        }
        /* The version is the label and the revision is the identity; a tag in the revision collapses
           the two, and an integration check passed against one "0.4.0" says nothing about another. */
        if let Some(revision) = pack.get("pin").and_then(|pin| pin.get("revision")).filter(|value| value.is_string()) {
            if !hex_digest(revision.as_str().unwrap_or_default()) {
                problems.push(format!(
                    "{where_}.pin.revision must be a 40- or 64-character hex digest, not {revision}"
                ));
            }
        }
    }
    problems
}

fn tests_rules(block: &Value) -> Vec<String> {
    match block.get("manifest").filter(|value| value.is_string()) {
        Some(manifest) if !root_relative(manifest) => vec!["$.tests.manifest must be root-relative".to_string()],
        _ => Vec::new(),
    }
}

fn cross_rules(value: &Value) -> Vec<String> {
    let Some(items) = value.get("formats").and_then(Value::as_array) else { return Vec::new() };
    let mut errors = Vec::new();
    let mut seen: Vec<Value> = Vec::new();
    for (index, format) in items.iter().enumerate() {
        if !format.is_object() {
            continue;
        }
        let at = format!("$.formats[{index}]");
        let where_ = format!("{at}{}", name_of(format));
        let id = format.get("id").cloned().unwrap_or(Value::Null);
        if seen.contains(&id) {
            errors.push(format!("{at}.id repeats {}", quoted(format.get("id"))));
        }
        seen.push(id);
        if let Some(modes) = format.get("modes").and_then(Value::as_array) {
            let default = format.get("default").cloned().unwrap_or(Value::Null);
            if !modes.contains(&default) {
                errors.push(format!("{where_}.default must be one of its modes"));
            }
            if modes.contains(&json!("preview")) && format.get("preview").is_none() {
                errors.push(format!("{where_}.preview is required for the preview mode"));
            }
        }
        if format.get("preview").and_then(|spec| spec.get("command")).is_some_and(Value::is_array)
            && !uses(format.get("preview"), "file")
        {
            errors.push(format!("{where_}.preview.command must name ${{file}}"));
        }
        if format.get("entry").and_then(|spec| spec.get("command")).is_some_and(Value::is_array)
            && !(uses(format.get("entry"), "file") && uses(format.get("entry"), "entry"))
        {
            errors.push(format!("{where_}.entry.command must name ${{file}} and ${{entry}}"));
        }
    }
    errors
}

struct Section {
    name: &'static str,
    minimum: i64,
}

/// devices settle before games, and games before dashboard, so each can resolve the references it
/// makes; tests and packs reference nothing and are referenced by nothing, so they settle first.
const SECTIONS: [Section; 7] = [
    Section { name: "tests", minimum: 10 },
    Section { name: "packs", minimum: 9 },
    Section { name: "languageServers", minimum: 7 },
    Section { name: "tracker", minimum: 5 },
    Section { name: "devices", minimum: 4 },
    Section { name: "games", minimum: 3 },
    Section { name: "dashboard", minimum: 2 },
];

fn section_node(schema: &Value, name: &str) -> Value {
    if name == "dashboard" {
        schema.get("$defs").and_then(|defs| defs.get("dashboard")).cloned().unwrap_or(Value::Null)
    } else {
        schema.get("properties").and_then(|properties| properties.get(name)).cloned().unwrap_or(Value::Null)
    }
}

fn section_rules(name: &str, block: &Value, context: &Context) -> Vec<String> {
    let contract = context.contract.unwrap_or(0);
    match name {
        "tests" => tests_rules(block),
        "packs" => packs_rules(block),
        "languageServers" => language_server_rules(block),
        "tracker" => tracker_rules(block, contract),
        "devices" => devices_rules(block),
        "games" => games_rules(block, context),
        "dashboard" => dashboard_rules(block, context),
        _ => Vec::new(),
    }
}

/// The reader. `declaration_file` is spec 085's external declaration, which sits outside the root
/// it describes — which is why the artwork beside it resolves against ITS directory rather than the
/// project's.
pub fn read(root_path: &str, declaration_file: Option<&str>) -> Value {
    let external = declaration_file.is_some();
    let source = declaration_file.unwrap_or(".rengine/project.json").to_string();
    let path = match declaration_file {
        Some(file) => std::path::PathBuf::from(file),
        None => std::path::Path::new(root_path).join(".rengine").join("project.json"),
    };
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !external => {
            return json!({ "declared": false, "formats": [] })
        }
        Err(error) => {
            return problem(&source, &format!("cannot read ({}: {}, open '{}')", node_code(&error), error_text(&error), path.display()))
        }
    };
    if bytes.len() > MAX_DECLARATION_BYTES {
        return problem(&source, "declaration exceeds 256 KiB");
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    let value: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        /* The parser's own words, which are the one thing in this answer that is its runtime's
           rather than this workspace's. `declaration-fixtures.json` marks the case for that. */
        Err(error) => return problem(&source, &format!("invalid JSON ({error})")),
    };
    if !value.is_object() {
        return problem(&source, "declaration must be a JSON object");
    }
    let contract = value.get("contract").and_then(Value::as_i64);
    if !contract.is_some_and(|contract| CONTRACTS.contains(&contract)) {
        return problem(
            &source,
            &format!(
                "unknown contract {}; this rEngine supports contracts {} and {}",
                quoted(value.get("contract")),
                CONTRACTS[..CONTRACTS.len() - 1].iter().map(i64::to_string).collect::<Vec<_>>().join(", "),
                CONTRACTS[CONTRACTS.len() - 1]
            ),
        );
    }
    let contract = contract.expect("a known contract is a number");
    let schema = schema();
    /* The blocks with their own rules are validated by their section, so the document is checked
       without them. */
    let mut base = value.as_object().expect("an object").clone();
    for name in ["dashboard", "games", "devices", "tracker", "packs"] {
        base.remove(name);
    }
    let base = Value::Object(base);
    let structural = red_store::schema::validate_schema(&schema, &base);
    if !structural.is_empty() {
        return problem(&source, &report(&structural));
    }
    /* Identity keys are plain root fields rather than a block, so their contract floor is checked
       here rather than through the sections; without this a project on contract 4 would have them
       accepted in silence and wonder why the chrome never changed (spec 084). */
    for name in ["title", "icon"] {
        if value.get(name).is_some() && contract < 5 {
            return problem(&source, &format!("{name} requires contract 5 (declared contract {contract})"));
        }
    }
    if value.get("agents").is_some() && contract < 6 {
        return problem(&source, &format!("agents requires contract 6 (declared contract {contract})"));
    }
    if let Some(token) = value.get("icon").and_then(|icon| icon.get("token")) {
        if !ICON_TOKENS.contains(&token.as_str().unwrap_or_default()) {
            return problem(
                &source,
                &format!("icon token {token} is not a design token; use {}", ICON_TOKENS.join(", ")),
            );
        }
    }
    /* Brand artwork (spec 104), named where it is declared. */
    let mut artwork: Vec<(String, Value)> = Vec::new();
    if let Some(image) = value.get("icon").and_then(|icon| icon.get("image")) {
        artwork.push(("icon.image".to_string(), image.clone()));
    }
    match value.get("wordmark") {
        Some(Value::String(file)) => artwork.push(("wordmark".to_string(), json!(file))),
        Some(Value::Object(themes)) => {
            for (theme, file) in themes {
                artwork.push((format!("wordmark.{theme}"), file.clone()));
            }
        }
        _ => {}
    }
    if !artwork.is_empty() && contract < 8 {
        return problem(&source, &format!("brand artwork requires contract 8 (declared contract {contract})"));
    }
    /* Exactly one mark. Two, with no rule about which wins, is a defect waiting for a narrow window;
       neither leaves the chip with nothing to draw (spec 104 decision 4). */
    if let Some(icon) = value.get("icon") {
        let has: Vec<&str> = ["glyph", "image"].into_iter().filter(|key| icon.get(*key).is_some()).collect();
        if has.len() != 1 {
            return problem(
                &source,
                &format!(
                    "icon carries exactly one of glyph and image, not {}",
                    if has.is_empty() { "neither".to_string() } else { has.join(" and ") }
                ),
            );
        }
    }
    for (where_, file) in &artwork {
        if !root_relative(file) {
            return problem(&source, &format!("{where_} must be a relative path inside the declaration's directory"));
        }
        if !file.as_str().unwrap_or_default().to_lowercase().ends_with(".svg") {
            return problem(&source, &format!("{where_} must name an .svg file"));
        }
    }
    let mut errors = cross_rules(&base);
    errors.extend(agents_rules(&base));
    if !errors.is_empty() {
        return problem(&source, &report(&errors));
    }
    /* Brand artwork is resolved to an absolute file HERE, beside the declaration that names it,
       because that is the only place that knows where the declaration lives. A file that is missing
       or unreadable is reported and its path omitted, so the chrome falls back to its glyph rather
       than drawing nothing (spec 104 decision 7). */
    let artwork_dir = if external {
        std::path::Path::new(&source).parent().map(std::path::Path::to_path_buf).unwrap_or_default()
    } else {
        std::path::PathBuf::from(root_path)
    };
    let mut artwork_problems: Vec<String> = Vec::new();
    let mut resolve = |where_: &str, file: &Value| -> Option<String> {
        let named = file.as_str()?;
        let absolute = artwork_dir.join(named);
        if std::fs::metadata(&absolute).is_ok() {
            Some(absolute.to_string_lossy().into_owned())
        } else {
            artwork_problems.push(format!("{where_} names {named}, which cannot be read"));
            None
        }
    };
    let icon = match value.get("icon") {
        Some(icon) if icon.get("image").is_some() => {
            let mut map = icon.as_object().cloned().unwrap_or_default();
            if let Some(file) = resolve("icon.image", icon.get("image").expect("an image")) {
                map.insert("imageFile".to_string(), json!(file));
            }
            Some(Value::Object(map))
        }
        other => other.cloned(),
    };
    let wordmark = match value.get("wordmark") {
        Some(Value::String(file)) => Some(json!({ "light": file, "dark": file })),
        other => other.cloned(),
    };
    let wordmark = wordmark.map(|wordmark| {
        let mut map = wordmark.as_object().cloned().unwrap_or_default();
        for (theme, key) in [("light", "lightFile"), ("dark", "darkFile")] {
            if let Some(file) = wordmark.get(theme).and_then(|file| resolve(&format!("wordmark.{theme}"), file)) {
                map.insert(key.to_string(), json!(file));
            }
        }
        Value::Object(map)
    });

    let mut result = Map::new();
    result.insert("declared".to_string(), json!(true));
    result.insert("source".to_string(), json!(source));
    result.insert("contract".to_string(), json!(contract));
    result.insert("project".to_string(), value.get("project").cloned().unwrap_or(Value::Null));
    if let Some(title) = value.get("title") {
        result.insert("title".to_string(), title.clone());
    }
    if let Some(icon) = icon {
        result.insert("icon".to_string(), icon);
    }
    if let Some(wordmark) = wordmark {
        result.insert("wordmark".to_string(), wordmark);
    }
    if !artwork_problems.is_empty() {
        result.insert("artworkError".to_string(), json!(format!("{source}: {}", report(&artwork_problems))));
    }
    if let Some(agents) = value.get("agents") {
        result.insert("agents".to_string(), agents.clone());
    }
    result.insert(
        "formats".to_string(),
        json!(value
            .get("formats")
            .and_then(Value::as_array)
            .map(|formats| formats
                .iter()
                .map(|format| {
                    let mut map = format.as_object().cloned().unwrap_or_default();
                    if let Some(preview) = bounded(format.get("preview")) {
                        map.insert("preview".to_string(), preview);
                    }
                    if let Some(entry) = bounded(format.get("entry")) {
                        map.insert("entry".to_string(), entry);
                    }
                    Value::Object(map)
                })
                .collect::<Vec<Value>>())
            .unwrap_or_default()),
    );

    let mut context = Context { contract: Some(contract), ..Context::default() };
    for section in SECTIONS {
        let Some(block) = value.get(section.name) else { continue };
        let key = format!("{}Error", section.name);
        if contract < section.minimum {
            result.insert(
                key,
                json!(format!(
                    "{source}: {} requires contract {} (declared contract {contract})",
                    section.name, section.minimum
                )),
            );
            if section.name == "devices" {
                context.devices_error = true;
            }
            if section.name == "games" {
                context.games_error = true;
            }
            continue;
        }
        let mut problems = red_store::schema::validate_schema_at(
            &section_node(&schema, section.name),
            block,
            &schema,
            &format!("$.{}", section.name),
        );
        problems.extend(section_rules(section.name, block, &context));
        if problems.is_empty() {
            result.insert(section.name.to_string(), block.clone());
            if section.name == "devices" {
                context.devices = Some(block.clone());
            }
            if section.name == "games" {
                context.games = Some(block.clone());
            }
        } else {
            result.insert(key, json!(format!("{source}: {}", report(&problems))));
            if section.name == "devices" {
                context.devices_error = true;
            }
            if section.name == "games" {
                context.games_error = true;
            }
        }
    }
    Value::Object(result)
}

/// Node's own wording for a filesystem error, because the message it produced is in the record.
fn node_code(error: &std::io::Error) -> &'static str {
    match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::IsADirectory => "EISDIR",
        _ => "EIO",
    }
}

fn error_text(error: &std::io::Error) -> &'static str {
    match error.kind() {
        std::io::ErrorKind::NotFound => "no such file or directory",
        std::io::ErrorKind::PermissionDenied => "permission denied",
        std::io::ErrorKind::IsADirectory => "illegal operation on a directory",
        _ => "input/output error",
    }
}

#[cfg(test)]
mod tests {
    /// The contract list is stated twice — here, and as the `contract` enum of the schema this crate
    /// embeds — because the reader needs it before the schema is parsed and the schema needs it to
    /// refuse an unknown one. Two statements of one fact drift, so this is the assertion that they
    /// have not: a contract added to the document and not here would otherwise be accepted
    /// structurally and then refused by a floor that has never heard of it.
    #[test]
    fn the_contract_list_is_the_schemas_own() {
        let schema: serde_json::Value =
            serde_json::from_str(include_str!("../../../contracts/project-v1.schema.json")).expect("the contract document");
        let declared: Vec<i64> = schema["properties"]["contract"]["enum"]
            .as_array()
            .expect("the contract enum")
            .iter()
            .filter_map(serde_json::Value::as_i64)
            .collect();
        assert_eq!(declared, super::CONTRACTS.to_vec());
    }
}
