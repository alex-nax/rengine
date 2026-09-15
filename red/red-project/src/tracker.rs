//! A project's own task inventory, and the tests it says are behind each task (F153; specs 100,
//! 103, 116, 117).
//!
//! Only the LOCAL backend is here. The remote providers need a network client, and F154 owns that
//! decision — so what this holds is the backend this repository itself uses: `features.json` read as
//! neutral rows, with the readiness `tools/features.py` applies, so the Tasks tab and the command
//! line cannot disagree about what is blocked.
//!
//! Joined onto it is the tests manifest of spec 117: what a criterion claims and what proves it.
//! rEngine READS it and runs nothing — no entry moves a row, and a manifest saying everything failed
//! leaves every task where its provider put it. The one field the format exists for is `proven`: a
//! green run says a command went green, and only a sabotage row says the test can go red for its
//! own reason (AGENTS.md). The two are never collapsed into one word.

use std::path::Path;

use serde_json::{json, Value};

use crate::rules::object;

/// State is (id, name, category) and never a boolean: a two-value enum cannot represent Linear's
/// team-defined workflow states, and a local row's `passes` is never read back as truth.
pub const CATEGORIES: [&str; 6] = ["backlog", "unstarted", "started", "completed", "canceled", "blocked"];

const TESTS_SCHEMA: &str = include_str!("../../../contracts/task-tests-v1.schema.json");

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// The neutral row every provider is flattened into.
/// The same neutral row, for a provider's issue. Public because `tracker_remote` builds one and the
/// two must be the same shape: a GitHub row and a local one are read by the same pane.
pub fn remote_row(id: String, key: String, title: Value, state: (&str, &str, &str), fields: Vec<(&'static str, Value)>) -> Value {
    row(id, key, title, state, fields)
}

fn row(id: String, key: String, title: Value, state: (&str, &str, &str), fields: Vec<(&'static str, Value)>) -> Value {
    let mut out = vec![
        ("id", json!(id)),
        ("key", json!(key)),
        ("title", title),
        ("state", json!({ "id": state.0, "name": state.1, "category": state.2 })),
        ("priority", Value::Null),
        ("labels", json!([])),
        ("assignee", Value::Null),
        ("url", Value::Null),
        ("updatedAt", Value::Null),
        ("blockedBy", json!([])),
        ("criteria", json!([])),
        ("evidence", json!([])),
        ("tests", json!([])),
    ];
    for (name, value) in fields {
        if let Some(slot) = out.iter_mut().find(|(key, _)| *key == name) {
            slot.1 = value;
        }
    }
    object(out)
}

/// Readiness follows the rule `tools/features.py` applies, so the view and the command line cannot
/// disagree about what is blocked.
fn local_state(feature: &Value, features: &[Value]) -> (&'static str, &'static str, &'static str) {
    if feature.get("passes").and_then(Value::as_bool) == Some(true) {
        return ("passing", "passing", "completed");
    }
    let unmet = feature
        .get("dependencies")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter().any(|id| {
                features
                    .iter()
                    .find(|feature| feature.get("id") == Some(id))
                    .and_then(|feature| feature.get("passes").and_then(Value::as_bool))
                    != Some(true)
            })
        })
        .unwrap_or(false);
    if unmet {
        ("blocked", "blocked", "blocked")
    } else {
        ("ready", "ready", "unstarted")
    }
}

/// The project's own inventory, or the named reason there is none to read.
pub fn local_rows(root_path: &str, block: &Value) -> Value {
    let name = block.get("inventory").and_then(Value::as_str).unwrap_or("features.json");
    let file = Path::new(root_path).join(name);
    let text = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return json!({ "rows": [], "unavailable": format!("{name} is not in this project.") });
        }
        Err(error) => return json!({ "rows": [], "invalid": [format!("{name}: {error}")] }),
    };
    let parsed: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => return json!({ "rows": [], "invalid": [format!("{name}: {error}")] }),
    };
    let features: Vec<Value> = parsed.get("features").and_then(Value::as_array).cloned().unwrap_or_default();
    let rows: Vec<Value> = features
        .iter()
        .map(|feature| {
            let id = feature.get("id").map(js_id).unwrap_or_default();
            let dependencies: Vec<String> = feature
                .get("dependencies")
                .and_then(Value::as_array)
                .map(|ids| ids.iter().map(|id| format!("F{}", js_id(id))).collect())
                .unwrap_or_default();
            row(
                id.clone(),
                format!("F{id}"),
                feature.get("description").cloned().unwrap_or_else(|| json!("")),
                local_state(feature, &features),
                vec![
                    ("priority", feature.get("priority").cloned().unwrap_or(Value::Null)),
                    (
                        "labels",
                        json!([feature.get("milestone"), feature.get("category")]
                            .into_iter()
                            .flatten()
                            .filter(|value| !value.is_null() && value.as_str() != Some(""))
                            .cloned()
                            .collect::<Vec<_>>()),
                    ),
                    ("assignee", feature.get("owner_workspace").cloned().unwrap_or(Value::Null)),
                    ("blockedBy", json!(dependencies)),
                    ("criteria", feature.get("acceptance_criteria").filter(|value| value.is_array()).cloned().unwrap_or_else(|| json!([]))),
                    (
                        "evidence",
                        json!(feature
                            .get("evidence")
                            .and_then(Value::as_array)
                            .map(|items| items.iter().filter(|item| item.is_string()).cloned().collect::<Vec<_>>())
                            .unwrap_or_default()),
                    ),
                ],
            )
        })
        .collect();
    json!({ "rows": rows })
}

/// `String(value)` for an inventory id, which may be a number or a string.
fn js_id(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// The revision this checkout is at, so a reader can say whether a manifest describes it.
fn head_commit(root_path: &str) -> Option<String> {
    let git = Path::new(root_path).join(".git");
    let head = std::fs::read_to_string(git.join("HEAD")).ok()?.trim().to_string();
    if is_sha(&head) {
        return Some(head);
    }
    let reference = head.strip_prefix("ref: ")?.trim().to_string();
    /* Packed refs are a follow-up; unknown beats a guess. */
    let value = std::fs::read_to_string(git.join(reference)).ok()?.trim().to_string();
    is_sha(&value).then_some(value)
}

fn is_sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// The manifest a declaration names, joined onto the rows it keys.
pub fn with_tests(root_path: &str, declared: &Value, result: &Value) -> Value {
    let manifest = declared.get("tests").and_then(|tests| tests.get("manifest")).and_then(Value::as_str);
    let Some(manifest) = manifest.filter(|name| !name.is_empty()) else { return result.clone() };
    let file = Path::new(root_path).join(manifest);
    let parsed: Value = match std::fs::read_to_string(&file) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(error) => return with_error(result, format!("{manifest}: {error}")),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return with_error(result, format!("{manifest}: the declared tests manifest is not in this project."));
        }
        Err(error) => return with_error(result, format!("{manifest}: {error}")),
    };
    let schema: Value = serde_json::from_str(TESTS_SCHEMA).expect("the tests contract");
    let problems = red_store::schema::validate_schema(&schema, &parsed);
    if !problems.is_empty() {
        return with_error(result, format!("{manifest}: {}", problems.iter().take(3).cloned().collect::<Vec<_>>().join("; ")));
    }

    let entries: Vec<Value> = parsed.get("entries").and_then(Value::as_array).cloned().unwrap_or_default();
    let for_task = |key: &str| -> Vec<Value> { entries.iter().filter(|entry| text(entry, "task") == key).cloned().collect() };
    let rows: Vec<Value> = result.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();

    /* A manifest drifts from its inventory the moment a criterion is renumbered, and a claim
       pointing past the task's criteria reads as coverage it does not have — worse than claiming
       none. Only a provider that knows its own criteria can be checked, so the others carry the
       index unjudged. */
    let mut drift: Vec<String> = Vec::new();
    for row in &rows {
        let criteria = row.get("criteria").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
        for entry in for_task(text(row, "key")) {
            for index in entry.get("criteria").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
                let index = index.as_u64().unwrap_or(0) as usize;
                if criteria > 0 && index > criteria {
                    drift.push(format!(
                        "{manifest}: {} claims criterion {index}, but the task has {criteria} criterion{}",
                        text(row, "key"),
                        if criteria == 1 { "" } else { "s" }
                    ));
                }
            }
        }
    }

    /* An artifact is answered for HERE rather than when someone clicks it, so a row can say
       "missing" or "outside this project" instead of a click failing. rEngine still opens nothing
       it was not asked to open and still produces nothing: this is a resolve and a stat (spec 126). */
    let mut outside: Vec<String> = Vec::new();
    let mut joined: Vec<Value> = Vec::new();
    for row in &rows {
        let mut out = row.as_object().cloned().unwrap_or_default();
        let tests: Vec<Value> = for_task(text(row, "key"))
            .into_iter()
            .map(|entry| {
                let mut entry = entry.as_object().cloned().unwrap_or_default();
                let proven = entry.get("sabotage").and_then(Value::as_array).is_some_and(|rows| !rows.is_empty());
                if let Some(artifacts) = entry.get("last").and_then(|last| last.get("artifacts")).and_then(Value::as_array).cloned() {
                    let settled: Vec<Value> = artifacts.iter().map(|artifact| settle(root_path, artifact, &mut outside)).collect();
                    let mut last = entry.get("last").and_then(Value::as_object).cloned().unwrap_or_default();
                    last.insert("artifacts".into(), json!(settled));
                    entry.insert("proven".into(), json!(proven));
                    entry.insert("last".into(), Value::Object(last));
                } else {
                    entry.insert("proven".into(), json!(proven));
                }
                Value::Object(entry)
            })
            .collect();
        out.insert("tests".into(), json!(tests));
        joined.push(Value::Object(out));
    }
    if !outside.is_empty() {
        drift.push(format!(
            "{manifest}: {}",
            outside.iter().take(3).map(|path| format!("{path} is outside this project")).collect::<Vec<_>>().join("; ")
        ));
    }
    let head = head_commit(root_path);
    let commit = parsed.get("commit").and_then(Value::as_str);
    let mut out = result.as_object().cloned().unwrap_or_default();
    out.insert("rows".into(), json!(joined));
    out.insert(
        "tests".into(),
        json!({
            "at": parsed.get("at").cloned().unwrap_or(Value::Null),
            "commit": parsed.get("commit").cloned().unwrap_or(Value::Null),
            "count": entries.len(),
            "current": match (head.as_deref(), commit) {
                (Some(head), Some(commit)) => json!(head == commit),
                _ => Value::Null,
            },
        }),
    );
    if !drift.is_empty() {
        out.insert("testsError".into(), json!(drift.iter().take(3).cloned().collect::<Vec<_>>().join("; ")));
    }
    Value::Object(out)
}

fn settle(root_path: &str, artifact: &Value, outside: &mut Vec<String>) -> Value {
    let label = artifact.get("label").and_then(Value::as_str).unwrap_or("");
    let declared = text(artifact, "path");
    match red_store::store::resolve_in_root(root_path, declared, true) {
        Ok((_, relative)) => {
            let state = if Path::new(root_path).join(&relative).exists() { "ok" } else { "missing" };
            json!({ "path": relative, "label": label, "state": state })
        }
        Err(_) => {
            outside.push(declared.to_string());
            json!({ "path": declared, "label": label, "state": "outside" })
        }
    }
}

fn with_error(result: &Value, message: String) -> Value {
    let mut out = result.as_object().cloned().unwrap_or_default();
    out.insert("testsError".into(), json!(message));
    Value::Object(out)
}

/// The whole local answer, in the shape the route gives it.
/// The same answer, for a project whose tracker is somebody else's server (F154, spec 083).
///
/// `state_directory` is where the credential lives — beside the WORKSPACE state and never in the
/// committed declaration — and `identity` is the declared project NAME the token file is keyed by,
/// so a person can create it by name and a checkout that moved keeps its tracker.
///
/// **`identity` and the block's own `project` are different things.** The block's `project` is
/// Linear's project filter. Naming both `project` made the filter silently take the token's value.
pub fn remote_tracker(
    root_id: &str,
    root_path: &str,
    declared: &Value,
    state_directory: &str,
    credential: Option<&str>,
    fetching: &dyn crate::tracker_remote::Fetching,
    now_ms: i64,
) -> Value {
    let _ = state_directory;
    let block = declared.get("tracker").cloned().unwrap_or_else(|| json!({ "provider": "local" }));
    let provider = block.get("provider").and_then(Value::as_str).unwrap_or("local").to_string();
    let mut named = block.as_object().cloned().unwrap_or_default();
    named.insert(
        "identity".to_string(),
        declared.get("project").cloned().filter(|name| !name.is_null()).unwrap_or_else(|| json!(root_id)),
    );
    let named = Value::Object(named);
    let answered = match provider.as_str() {
        "linear" => crate::tracker_remote::linear_rows(&named, credential, fetching),
        _ => crate::tracker_remote::github_rows(&named, credential, fetching),
    };
    let base = object(vec![
        ("rootId", json!(root_id)),
        ("declared", json!(true)),
        ("provider", json!(provider)),
        ("rows", json!([])),
        ("categories", json!(CATEGORIES)),
        ("contract", declared.get("contract").cloned().unwrap_or(Value::Null)),
    ]);
    let joined = merge(base, &answered, vec![
        ("fresh", json!(true)),
        ("checkedAt", json!(red_core::time::iso(now_ms))),
    ]);
    /* The manifest is joined onto a remote provider's rows by the same reader, so a GitHub row and a
       local one carry their evidence in the same shape. */
    with_tests(root_path, declared, &joined)
}

pub fn project_tracker(root_id: &str, root_path: &str, declared: &Value) -> Value {
    let base = |provider: Value, extra: Vec<(&'static str, Value)>| {
        let mut out = vec![
            ("rootId", json!(root_id)),
            ("declared", json!(declared.get("declared").and_then(Value::as_bool) == Some(true))),
            ("provider", provider),
            ("rows", json!([])),
            ("categories", json!(CATEGORIES)),
        ];
        out.extend(extra);
        object(out)
    };
    /* A project that declares nothing at all still has its own inventory if it keeps one, which is
       the default backend and the one this repository uses. */
    if declared.get("declared").and_then(Value::as_bool) != Some(true) {
        return merge(base(json!("local"), vec![]), &local_rows(root_path, &json!({})), vec![("fresh", json!(true))]);
    }
    if let Some(said) = declared.get("error").and_then(Value::as_str) {
        return base(Value::Null, vec![("error", json!(said))]);
    }
    if let Some(said) = declared.get("trackerError").and_then(Value::as_str) {
        return base(Value::Null, vec![("contract", declared.get("contract").cloned().unwrap_or(Value::Null)), ("error", json!(said))]);
    }
    let block = declared.get("tracker").cloned().unwrap_or_else(|| json!({ "provider": "local" }));
    let result = base(
        block.get("provider").cloned().unwrap_or_else(|| json!("local")),
        vec![("contract", declared.get("contract").cloned().unwrap_or(Value::Null))],
    );
    let local = merge(result, &local_rows(root_path, &block), vec![("fresh", json!(true))]);
    with_tests(root_path, declared, &local)
}

/// `{ ...result, ...rows, ...extra }` with the key order a spread gives.
fn merge(result: Value, rows: &Value, extra: Vec<(&'static str, Value)>) -> Value {
    let mut out = result.as_object().cloned().unwrap_or_default();
    if let Some(map) = rows.as_object() {
        for (key, value) in map {
            out.insert(key.clone(), value.clone());
        }
    }
    for (key, value) in extra {
        out.insert(key.into(), value);
    }
    Value::Object(out)
}
