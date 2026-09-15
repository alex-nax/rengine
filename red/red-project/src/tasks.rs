//! Task writes, the prompts a spawn carries, and the agent/model menu (F153, spec 103).
//!
//! Spec 083 refused task writes outright, because neither GitHub nor Linear offers concurrency
//! control on an issue write and a write from here would be last-write-wins against a teammate's
//! web edit. Spec 103 decision 3 amended that for the LOCAL backend only, and only by running the
//! command the project itself declared: **the workspace never edits an inventory.** Every refusal
//! below is that boundary, and its wording carries the argument — an agent that reads "Nothing was
//! attempted" knows its inventory is untouched, and one that reads a command's own stderr knows it
//! is not.

use std::path::Path;

use serde_json::{json, Value};

use crate::command;
use crate::recordings::Fail;
use crate::rules::object;

pub const TASK_ACTIONS: [&str; 3] = ["add", "update", "decompose"];
pub const BRIEFS: [&str; 2] = ["task", "decompose"];
pub const PLACEHOLDERS: [&str; 5] = ["id", "key", "title", "criteria", "labels"];
const MAX_PROMPT_BYTES: usize = 64 * 1024;
const MAX_ROW_BYTES: usize = 64 * 1024;
const MAX_STDOUT: usize = 32_000;
/// The write is a project command like every other declared command, so it is bounded like one.
const WRITE_TIMEOUT_MS: u64 = 60_000;
const DEFAULT_MAX_BYTES: usize = 4 * 1024 * 1024;

fn refuse(message: impl Into<String>, status: u16) -> Fail {
    Fail { message: message.into(), status: Some(status) }
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// The command a declaration names for its own inventory, or the reason there is none.
pub fn write_command(declared: &Value) -> Result<Value, Fail> {
    if declared.get("declared").and_then(Value::as_bool) != Some(true) {
        return Err(refuse(
            "This project declares nothing in .rengine/project.json, so it names no tracker.write command for the workspace to run. Nothing was attempted.",
            415,
        ));
    }
    for key in ["error", "trackerError"] {
        if let Some(said) = declared.get(key).and_then(Value::as_str) {
            return Err(refuse(said, 415));
        }
    }
    let block = declared.get("tracker").cloned().unwrap_or_else(|| json!({ "provider": "local" }));
    let provider = text(&block, "provider");
    if provider != "local" {
        return Err(refuse(
            format!(
                "This project's tracker is {provider}, and the workspace writes only the local backend: neither GitHub nor Linear offers concurrency control on an issue write, so a write from here would be last-write-wins against a teammate's web edit (spec 083 decision 1, amended for local only by spec 103 decision 3). Nothing was attempted."
            ),
            409,
        ));
    }
    let write = block.get("write").and_then(Value::as_array).filter(|items| !items.is_empty());
    let Some(write) = write else {
        return Err(refuse(
            "This project declares no tracker.write command, so the workspace has nothing to run: the workspace never edits the inventory itself. Add tracker.write to .rengine/project.json (contract 6) naming the project\u{2019}s own write command with ${json}. Nothing was attempted.",
            409,
        ));
    };
    Ok(object(vec![
        ("kind", json!("text")),
        ("command", json!(write)),
        ("timeoutMs", json!(WRITE_TIMEOUT_MS)),
        ("maxBytes", json!(DEFAULT_MAX_BYTES)),
    ]))
}

/// The document that replaces `${json}`: the caller's row, then the two things the workspace knows
/// and the row does not. Action last, so a row carrying its own `action` cannot rename the call.
pub fn write_document(data: &Value) -> Result<(Value, String), Fail> {
    let action = text(data, "action");
    if !TASK_ACTIONS.contains(&action) {
        return Err(refuse(format!("Choose one of {}.", TASK_ACTIONS.join(", ")), 400));
    }
    let Some(row) = data.get("row").and_then(Value::as_object) else {
        return Err(refuse("A task write carries its row as a JSON object.", 400));
    };
    let parent = data.get("parent").filter(|value| !value.is_null());
    if let Some(parent) = parent {
        let named = parent.as_str().filter(|text| !text.is_empty() && text.chars().count() <= 128);
        if named.is_none() {
            return Err(refuse("A parent is the key of the task the new row belongs under.", 400));
        }
    }
    if action == "decompose" && parent.is_none() {
        return Err(refuse("A decompose write is a child row and needs the parent it belongs under. Nothing was attempted.", 400));
    }
    let mut document = row.clone();
    if let Some(parent) = parent {
        document.insert("parent".into(), parent.clone());
    }
    document.insert("action".into(), json!(action));
    let document = Value::Object(document);
    let json = document.to_string();
    if red_core::text::utf16_len(&json) > MAX_ROW_BYTES {
        return Err(refuse(format!("A task row is at most {MAX_ROW_BYTES} bytes of JSON."), 413));
    }
    Ok((document, json))
}

/// Run the project's own write command, with the row where it said to put it.
pub fn task_write(root_id: &str, root_path: &str, declared: &Value, data: &Value, environment: &[(String, String)]) -> Result<Value, Fail> {
    let spec = write_command(declared)?;
    let (document, json) = write_document(data)?;
    let argv: Vec<String> = spec
        .get("command")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(|item| item.as_str().unwrap_or_default().replace("${json}", &json)).collect())
        .unwrap_or_default();
    let run = command::run(Path::new(root_path), &argv, environment, WRITE_TIMEOUT_MS, DEFAULT_MAX_BYTES)
        .map_err(|failed| refuse(failed.message, failed.status))?;
    /* stdout is a project's own words, not a contract: read as JSON when it is, kept as text when
       it is not, and never made into a refusal either way. */
    let said = String::from_utf8(run.stdout.clone()).ok().unwrap_or_default();
    let result = serde_json::from_str::<Value>(&said).ok().filter(Value::is_object);
    let mut fields = vec![
        ("rootId", json!(root_id)),
        ("action", json!(text(data, "action"))),
        (
            "key",
            document.get("key").or_else(|| document.get("id")).cloned().unwrap_or(Value::Null),
        ),
        (
            "command",
            json!(run
                .argv
                .iter()
                .map(|argument| {
                    if argument == root_path {
                        ".".to_string()
                    } else if let Some(rest) = argument.strip_prefix(&format!("{root_path}/")) {
                        rest.to_string()
                    } else {
                        argument.clone()
                    }
                })
                .collect::<Vec<_>>()),
        ),
        ("durationMs", json!(run.duration_ms as u64)),
        ("stdout", json!(red_core::text::truncate_utf16(&said, MAX_STDOUT))),
    ];
    if let Some(result) = result {
        fields.push(("result", result));
    }
    Ok(object(fields))
}

/// A prompt is a project FILE rather than a declaration key (spec 103 decision 7), so changing one
/// needs no contract bump and no host replacement. A placeholder the project misspells is named in
/// the refusal: a prompt quietly missing the task's criteria reads exactly like one that has them.
pub fn render_prompt(template: &str, values: &Value, source: &str) -> Result<String, Fail> {
    let found = placeholders(template);
    let unknown: Vec<&str> = found.iter().copied().filter(|name| !PLACEHOLDERS.contains(name)).collect();
    if !unknown.is_empty() {
        let mut seen: Vec<&str> = Vec::new();
        for name in &unknown {
            if !seen.contains(name) {
                seen.push(name);
            }
        }
        let named = seen.iter().map(|name| format!("${{{name}}}")).collect::<Vec<_>>().join(", ");
        return Err(refuse(
            format!(
                "{source} names {named}, which {} the workspace fills. Use {}. Nothing was started.",
                if unknown.len() == 1 { "is not a placeholder" } else { "are not placeholders" },
                PLACEHOLDERS.iter().map(|name| format!("${{{name}}}")).collect::<Vec<_>>().join(", ")
            ),
            422,
        ));
    }
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find('}').filter(|end| name_ok(&after[..*end])) {
            Some(end) => {
                let name = &after[..end];
                match values.get(name).and_then(Value::as_str) {
                    Some(value) => out.push_str(value),
                    None => out.push_str(&rest[start..start + 3 + end]),
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push_str("${");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    Ok(out)
}

/// `/\$\{([A-Za-z0-9_]*)\}/g` — the empty name matches too, so `${}` is named rather than ignored.
fn placeholders(template: &str) -> Vec<&str> {
    let mut found = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find("${") {
        let after = &rest[start + 2..];
        match after.find('}').filter(|end| name_ok(&after[..*end])) {
            Some(end) => {
                found.push(&after[..end]);
                rest = &after[end + 1..];
            }
            None => rest = after,
        }
    }
    found
}

fn name_ok(name: &str) -> bool {
    name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// What a row says to a prompt. The list forms are rendered here rather than in the template, so a
/// project overriding the prompt writes prose and never a loop.
pub fn prompt_values(row: &Value) -> Value {
    let string = |key: &str| row.get(key).map(js_string).unwrap_or_default();
    let labels: Vec<String> = row.get("labels").and_then(Value::as_array).map(|items| items.iter().map(js_string).collect()).unwrap_or_default();
    let criteria: Vec<String> = row.get("criteria").and_then(Value::as_array).map(|items| items.iter().map(js_string).collect()).unwrap_or_default();
    object(vec![
        ("id", json!(string("id"))),
        ("key", json!(string("key"))),
        ("title", json!(string("title"))),
        ("labels", json!(if labels.is_empty() { "none".to_string() } else { labels.join(", ") })),
        (
            "criteria",
            json!(if criteria.is_empty() {
                "None are recorded in the inventory; establish them with the project before implementing.".to_string()
            } else {
                criteria.iter().enumerate().map(|(index, item)| format!("{}. {item}", index + 1)).collect::<Vec<_>>().join("\n")
            }),
        ),
    ])
}

/// `String(value)`: a string is itself, everything else is how JavaScript prints it.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// The brief a spawn carries: the project's own if it has one, rEngine's shipped one if not.
pub fn prompt_for(root_path: &str, name: &str, values: &Value, shipped: &Path) -> Result<Value, Fail> {
    if !BRIEFS.contains(&name) {
        return Err(refuse(format!("Choose a brief: {}.", BRIEFS.join(" or ")), 400));
    }
    let project = Path::new(root_path).join(".rengine/prompts").join(format!("{name}.md"));
    let (template, source) = match std::fs::read(&project) {
        Ok(bytes) => {
            if bytes.len() > MAX_PROMPT_BYTES {
                return Err(refuse(format!(".rengine/prompts/{name}.md exceeds {MAX_PROMPT_BYTES} bytes."), 413));
            }
            let Ok(text) = String::from_utf8(bytes) else {
                return Err(refuse(format!(".rengine/prompts/{name}.md is not UTF-8 text."), 415));
            };
            (text, format!(".rengine/prompts/{name}.md"))
        }
        Err(_) => {
            let file = shipped.join(format!("{name}.md"));
            let text = std::fs::read_to_string(&file).map_err(|error| refuse(format!("cannot read {}: {error}", file.display()), 500))?;
            (text, format!("rEngine's shipped {name}.md"))
        }
    };
    let rendered = render_prompt(&template, values, &source)?;
    Ok(object(vec![("source", json!(source)), ("text", json!(rendered))]))
}

/* --- the agent and model menu ----------------------------------------------------------------- */

/// What the menu offers when a project declares no `agents` block: the registry's recipes, each
/// with the model list rEngine can offer it.
pub fn known_agents(recipes: &Value) -> Vec<Value> {
    recipes
        .as_object()
        .map(|map| {
            map.iter()
                .map(|(cli, recipe)| {
                    let models = recipe.get("models");
                    let is_static = models.map(|models| models.get("kind").and_then(Value::as_str) == Some("static")).unwrap_or(false);
                    object(vec![
                        ("cli", json!(cli)),
                        ("models", if is_static { models.and_then(|m| m.get("list")).cloned().unwrap_or_else(|| json!([])) } else { json!([]) }),
                        ("default", if is_static { models.and_then(|m| m.get("default")).cloned().unwrap_or_else(|| json!("")) } else { json!("") }),
                    ])
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A CLI whose recipe names no model flag is refused by name rather than started without the model
/// the caller asked for: a spawn that silently drops the model is a pane running the wrong thing
/// that looks right.
pub fn model_args(recipes: &Value, cli: &str, model: Option<&str>) -> Result<Vec<String>, Fail> {
    let Some(model) = model.filter(|model| !model.is_empty()) else { return Ok(Vec::new()) };
    if model.chars().count() > 128 || !identifier(model) {
        return Err(refuse("A model is a plain identifier the CLI accepts.", 400));
    }
    let flag = recipes.get(cli).and_then(|recipe| recipe.get("model")).and_then(|model| model.get("flag")).and_then(Value::as_str);
    let Some(flag) = flag else {
        return Err(refuse(
            format!("rEngine does not know how {cli} is told which model to run, so it will not guess a flag: start {cli} without a model, or declare the flagged CLI you meant. Nothing was started."),
            409,
        ));
    };
    Ok(vec![flag.to_string(), model.to_string()])
}

fn identifier(value: &str) -> bool {
    let mut characters = value.chars();
    characters.next().is_some_and(|first| first.is_ascii_alphanumeric())
        && characters.all(|c| c.is_ascii_alphanumeric() || "._:@/-".contains(c))
}

/// The models a CLI whose recipe declares `models.kind = "help"` lists in its own `--help`.
///
/// clap prints its choices as "[possible values: a, b, c]"; a CLI that prints none leaves the list
/// empty rather than inviting a guess at names that move faster than this file does. The KIND is
/// what selects this parser — it was named for the first CLI to declare that kind (F220, spec 141).
pub fn models_from_help(help: &str) -> Vec<String> {
    let lines: Vec<&str> = help.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).collect();
    for (index, line) in lines.iter().enumerate() {
        if !mentions_model(line) {
            continue;
        }
        let window = lines[index..lines.len().min(index + 3)].join(" ");
        let Some(found) = after_possible_values(&window) else { continue };
        let models: Vec<String> = found
            .split(',')
            .map(|item| item.trim().trim_matches(['"', '\'', '`']).to_string())
            .filter(|item| identifier(item))
            .collect();
        if !models.is_empty() {
            return models.into_iter().take(32).collect();
        }
    }
    Vec::new()
}

/// `/--model\b/` — the word, not a longer flag that starts with it.
fn mentions_model(line: &str) -> bool {
    let mut rest = line;
    while let Some(at) = rest.find("--model") {
        let after = &rest[at + 7..];
        if !after.chars().next().is_some_and(|c| c.is_alphanumeric() || c == '_') {
            return true;
        }
        rest = after;
    }
    false
}

/// `/possible values:\s*([^\]\n]+)/i`.
fn after_possible_values(window: &str) -> Option<&str> {
    let lower = window.to_ascii_lowercase();
    let at = lower.find("possible values:")? + "possible values:".len();
    let rest = &window[at..];
    let start = rest.len() - rest.trim_start().len();
    let rest = &rest[start..];
    let end = rest.find([']', '\n']).unwrap_or(rest.len());
    Some(&rest[..end]).filter(|found| !found.is_empty())
}

pub fn parse_installed(text: &str) -> Vec<(String, bool)> {
    let mut installed: Vec<(String, bool)> = Vec::new();
    for line in text.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)) {
        let mut parts = line.splitn(2, '\t');
        let name = parts.next().unwrap_or_default().trim();
        if name.is_empty() {
            continue;
        }
        let where_ = parts.next().unwrap_or_default().trim();
        let known = !where_.is_empty() && where_ != "not installed";
        match installed.iter_mut().find(|(seen, _)| seen == name) {
            Some(entry) => entry.1 = known,
            None => installed.push((name.to_string(), known)),
        }
    }
    installed
}

/// The menu the Tasks pane offers. A declaration wins outright — a project that lists its agents has
/// said which ones it wants used — and rEngine's own lists fill in only when it has not.
/// Which CLIs the menu would ask for their own model list, and no more than those.
///
/// The caller runs `<cli> --help`, not this — a CLI is a process, and which process to run is the
/// caller's business. But WHICH CLIs to ask is this module's rule, and it is asked for rather than
/// restated on the other side: a declared menu asks no CLI anything, and an uninstalled one is
/// never run. A client that guessed would eventually guess differently from the menu it feeds.
pub fn needs_help(recipes: &Value, declared: &Value, installed_text: &str) -> Vec<String> {
    if declared.get("agents").and_then(Value::as_array).is_some() {
        return Vec::new();
    }
    let installed = parse_installed(installed_text);
    known_agents(recipes)
        .iter()
        .map(|record| text(record, "cli").to_string())
        .filter(|cli| recipes.get(cli).and_then(|recipe| recipe.get("models")).and_then(|models| models.get("kind")).and_then(Value::as_str) == Some("help"))
        .filter(|cli| installed.iter().any(|(name, known)| name == cli && *known))
        .collect()
}

pub fn agents_menu(root_id: &str, recipes: &Value, declared: &Value, installed_text: &str, help_of: &mut dyn FnMut(&str) -> String) -> Value {
    let installed = parse_installed(installed_text);
    let known = |cli: &str| installed.iter().find(|(name, _)| name == cli).map(|(_, known)| *known).unwrap_or(false);
    let declared_agents = declared.get("agents").and_then(Value::as_array).cloned();
    let records = declared_agents.clone().unwrap_or_else(|| known_agents(recipes));
    let mut agents = Vec::new();
    for record in &records {
        let cli = text(record, "cli");
        let mut models: Vec<Value> = record.get("models").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut fallback = record.get("default").cloned().unwrap_or_else(|| json!(""));
        let help_kind = recipes.get(cli).and_then(|recipe| recipe.get("models")).and_then(|models| models.get("kind")).and_then(Value::as_str) == Some("help");
        if declared_agents.is_none() && help_kind && known(cli) {
            models = models_from_help(&help_of(cli)).into_iter().map(|model| json!(model)).collect();
            fallback = models.first().cloned().unwrap_or_else(|| json!(""));
        }
        agents.push(object(vec![
            ("cli", json!(cli)),
            ("installed", json!(known(cli))),
            ("models", json!(models)),
            ("default", fallback),
        ]));
    }
    object(vec![
        ("rootId", json!(root_id)),
        ("declared", json!(declared_agents.is_some())),
        ("agents", json!(agents)),
    ])
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    /// A flag the registry does not name is refused rather than guessed, and a model that is not an
    /// identifier never reaches an argv.
    #[test]
    fn a_model_is_named_by_its_recipe_or_refused() {
        let recipes = json!({ "claude": { "model": { "flag": "--model" } }, "gemini": {} });
        assert_eq!(super::model_args(&recipes, "claude", Some("claude-opus-5")).expect("args"), vec!["--model", "claude-opus-5"]);
        assert_eq!(super::model_args(&recipes, "claude", None).expect("args"), Vec::<String>::new());
        assert_eq!(super::model_args(&recipes, "claude", Some("")).expect("args"), Vec::<String>::new());
        assert_eq!(super::model_args(&recipes, "claude", Some("a model")).expect_err("refused").status, Some(400));
        assert_eq!(super::model_args(&recipes, "gemini", Some("x")).expect_err("refused").status, Some(409));
    }

    /// `--model` the word, not a flag that merely starts with it.
    #[test]
    fn a_longer_flag_is_not_the_model_flag() {
        assert!(super::mentions_model("  -m, --model <M>  [possible values: a]"));
        assert!(!super::mentions_model("  --modelling <M> [possible values: a]"));
        assert_eq!(super::models_from_help("  --modelling <M> [possible values: a]\n"), Vec::<String>::new());
    }
}
