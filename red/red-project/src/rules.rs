//! The cross-field rules a declaration is judged by, ported from `device-rules.mjs`,
//! `game-rules.mjs` and `dashboard-rules.mjs` (F156b, spec 129).
//!
//! These are pure: no filesystem, no process, nothing but the document and what the sections before
//! it settled. That is why three JS modules could share them and why they are one module here.
//!
//! **The messages are the contract.** Each one is what a person reads when their project will not
//! load, and `tests/declaration-fixtures.json` records them as the JS wrote them — so
//! a rule that reads better here is a rule that broke its record.

use serde_json::{json, Map, Value};

pub const LOCAL: &str = "local";
pub const DEVICE_CONTRACT: i64 = 4;

/// `JSON.stringify(value)` as a message fragment: a missing value reads `undefined`, the way a
/// template literal renders it.
pub fn quoted(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) if value.is_none() => "undefined".to_string(),
        None => "undefined".to_string(),
        Some(value) => value.to_string(),
    }
}

/// Records are named by their own id where they have one, else by the nearest named ancestor, so
/// the message is something to grep for and not an index to count out.
pub fn name_of(record: &Value) -> String {
    match record.get("id").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => format!(" ({id})"),
        _ => String::new(),
    }
}

pub fn root_relative(value: &Value) -> bool {
    let Some(text) = value.as_str() else { return false };
    !text.is_empty()
        && !text.starts_with('/')
        && !(text.len() >= 2 && text.as_bytes()[1] == b':' && text.as_bytes()[0].is_ascii_alphabetic())
        && !text.contains('\\')
        && !text.split('/').any(|part| part == "..")
        && !text.contains('\0')
}

pub fn root_relative_directory(value: &Value) -> bool {
    value.as_str() == Some("") || root_relative(value)
}

fn array<'a>(value: Option<&'a Value>) -> &'a [Value] {
    value.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn is_record(value: &Value) -> bool {
    value.is_object()
}

/// An UPPER_SNAKE key, and a literal string for a value.
fn env_key_ok(key: &str) -> bool {
    let mut bytes = key.bytes();
    matches!(bytes.next(), Some(first) if first.is_ascii_uppercase())
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn literal(value: &Value) -> bool {
    /* 4096 as JavaScript counted it: `value.length` is UTF-16 code units, so a string of 2049
       astral characters is 4098 and refused, where `chars().count()` would call it 2049. */
    value.as_str().is_some_and(|text| red_core::text::utf16_len(text) <= 4096 && !text.contains('\0'))
}

pub fn env_rules(env: Option<&Value>, where_: &str) -> Vec<String> {
    let Some(env) = env else { return Vec::new() };
    let Some(entries) = env.as_object() else {
        return vec![format!("{where_} must be an object of UPPER_SNAKE keys")];
    };
    let mut errors = Vec::new();
    if entries.len() > 64 {
        errors.push(format!("{where_} allows at most 64 entries"));
    }
    for (key, value) in entries {
        if !env_key_ok(key) {
            errors.push(format!("{where_} key {key} must be UPPER_SNAKE"));
        }
        if !literal(value) {
            errors.push(format!("{where_}.{key} must be a literal string"));
        }
    }
    errors
}

/// A game's environment, which additionally refuses the prefixes the workspace composes itself.
pub fn game_env_rules(env: Option<&Value>, where_: &str) -> Vec<String> {
    let Some(env) = env else { return Vec::new() };
    let Some(entries) = env.as_object() else {
        return vec![format!("{where_} must be an object of UPPER_SNAKE keys")];
    };
    let mut errors = Vec::new();
    if entries.len() > 64 {
        errors.push(format!("{where_} allows at most 64 entries"));
    }
    for (key, value) in entries {
        if !env_key_ok(key) {
            errors.push(format!("{where_} key {key} must be UPPER_SNAKE"));
        } else if key.starts_with("RENGINE_") || key.starts_with("DYLD_") || key.starts_with("LD_") {
            errors.push(format!("{where_} key {key} is reserved for the workspace"));
        }
        if !literal(value) {
            errors.push(format!("{where_}.{key} must be a literal string"));
        }
    }
    errors
}

/* ---- devices ---------------------------------------------------------------------------------- */

fn value_rules(node: Option<&Value>, field: &str, where_: &str) -> Vec<String> {
    let Some(node) = node else { return Vec::new() };
    if !is_record(node) {
        return vec![format!("{where_}.{field} must be an object with exactly one of value or env")];
    }
    let declared: Vec<&str> = ["value", "env"].into_iter().filter(|key| node.get(*key).is_some()).collect();
    if declared.len() == 1 {
        Vec::new()
    } else {
        vec![format!(
            "{where_}.{field} needs exactly one of value or env{}",
            if declared.is_empty() { "" } else { ", not both" }
        )]
    }
}

/// `${host}` and `${selector}` named by a probe, in the order they are found.
fn placeholders(probe: Option<&Value>) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for argument in array(probe) {
        let Some(text) = argument.as_str() else { continue };
        let mut rest = text;
        while let Some(at) = rest.find("${") {
            let after = &rest[at + 2..];
            for key in ["host", "selector"] {
                if after.starts_with(key) && after[key.len()..].starts_with('}') && !found.iter().any(|seen| seen == key) {
                    found.push(key.to_string());
                }
            }
            rest = after;
        }
    }
    found
}

pub fn devices_rules(devices: &Value) -> Vec<String> {
    let Some(items) = devices.as_array() else { return Vec::new() };
    let mut errors = Vec::new();
    let mut seen: Vec<Value> = Vec::new();
    let mut locals = 0;
    for (index, device) in items.iter().enumerate() {
        if !is_record(device) {
            continue;
        }
        let at = format!("$.devices[{index}]");
        let where_ = format!("{at}{}", name_of(device));
        let id = device.get("id").cloned().unwrap_or(Value::Null);
        if seen.contains(&id) {
            errors.push(format!("{at}.id repeats {}", quoted(device.get("id"))));
        }
        seen.push(id.clone());
        let kind = device.get("kind").and_then(Value::as_str);
        if kind == Some(LOCAL) {
            locals += 1;
            if locals == 2 {
                errors.push(format!("{where_}: only one device may declare kind {}", json!(LOCAL)));
            }
            if device.get("id").and_then(Value::as_str) != Some(LOCAL) {
                errors.push(format!("{where_}: a {} device must use the reserved id {}", json!(LOCAL), json!(LOCAL)));
            }
            for field in ["probe", "host", "selector"] {
                if device.get(field).is_some() {
                    errors.push(format!(
                        "{where_}.{field} is not permitted on the {LOCAL} device, which is trivially reachable"
                    ));
                }
            }
        } else if device.get("id").and_then(Value::as_str) == Some(LOCAL) {
            errors.push(format!("{where_}: the id {} is reserved for a device of kind {}", json!(LOCAL), json!(LOCAL)));
        } else if let Some(kind) = kind {
            if device.get("probe").is_none() {
                errors.push(format!(
                    "{where_}.probe is required for a {kind} device, so its reachability is measured rather than assumed"
                ));
            }
            for key in placeholders(device.get("probe")) {
                if device.get(&key).is_none() {
                    errors.push(format!("{where_}.probe names ${{{key}}} but the record declares no {key}"));
                }
            }
        }
        for field in ["host", "selector"] {
            errors.extend(value_rules(device.get(field), field, &where_));
        }
        for (n, value) in array(device.get("requires")).iter().enumerate() {
            if !root_relative(value) {
                errors.push(format!(
                    "{where_}.requires[{n}] must be root-relative; a device requires stays local even when the device is remote"
                ));
            }
        }
    }
    errors
}

/// What the sections settled before this one: the accepted blocks, and which of them failed.
#[derive(Default)]
pub struct Context {
    pub contract: Option<i64>,
    pub devices: Option<Value>,
    pub devices_error: bool,
    pub games: Option<Value>,
    pub games_error: bool,
}

fn declared_device_ids(context: &Context) -> Option<Vec<String>> {
    if context.devices_error {
        return None;
    }
    let declared: Vec<String> = context
        .devices
        .as_ref()
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|device| device.get("id").and_then(Value::as_str).map(str::to_string)).collect())
        .unwrap_or_default();
    Some(if declared.iter().any(|id| id == LOCAL) {
        declared
    } else {
        std::iter::once(LOCAL.to_string()).chain(declared).collect()
    })
}

fn device_kind_of(id: Option<&Value>, context: &Context) -> Option<String> {
    if context.devices_error {
        return None;
    }
    let named = id.and_then(Value::as_str).unwrap_or(LOCAL);
    if named == LOCAL {
        return Some(LOCAL.to_string());
    }
    context
        .devices
        .as_ref()
        .and_then(Value::as_array)
        .and_then(|items| items.iter().find(|device| device.get("id").and_then(Value::as_str) == Some(named)))
        .and_then(|device| device.get("kind").and_then(Value::as_str).map(str::to_string))
}

pub fn device_reference_rules(record: &Value, where_: &str, context: &Context) -> Vec<String> {
    let Some(device) = record.get("device") else { return Vec::new() };
    if let Some(contract) = context.contract {
        if contract < DEVICE_CONTRACT {
            return vec![format!(
                "{where_}.device requires contract {DEVICE_CONTRACT} (declared contract {contract})"
            )];
        }
    }
    let Some(ids) = declared_device_ids(context) else { return Vec::new() };
    let Some(named) = device.as_str() else { return Vec::new() };
    if ids.iter().any(|id| id == named) {
        return Vec::new();
    }
    vec![format!(
        "{where_}.device references undeclared device id {}; this declaration offers {}",
        json!(named),
        ids.join(", ")
    )]
}

/* ---- games ------------------------------------------------------------------------------------ */

pub const PANE_SURFACES: [&str; 2] = ["embedded", "cooperative"];

pub fn games_rules(games: &Value, context: &Context) -> Vec<String> {
    let Some(items) = games.as_array() else { return Vec::new() };
    let mut errors = Vec::new();
    let mut seen: Vec<Value> = Vec::new();
    for (index, game) in items.iter().enumerate() {
        if !is_record(game) {
            continue;
        }
        let at = format!("$.games[{index}]");
        let where_ = format!("{at}{}", name_of(game));
        let id = game.get("id").cloned().unwrap_or(Value::Null);
        if seen.contains(&id) {
            errors.push(format!("{at}.id repeats {}", quoted(game.get("id"))));
        }
        seen.push(id);
        errors.extend(game_env_rules(game.get("env"), &format!("{where_}.env")));
        errors.extend(device_reference_rules(game, &where_, context));
        /* A pane surface reserves a loopback surface and a local PTY; it cannot describe a window on
           another machine, and remote launching is outside this contract entirely. */
        let kind = device_kind_of(game.get("device"), context);
        let surface = game.get("surface").and_then(Value::as_str).unwrap_or_default();
        if PANE_SURFACES.contains(&surface) {
            if let Some(kind) = kind.filter(|kind| kind != LOCAL) {
                errors.push(format!(
                    "{where_}.surface {} needs the {LOCAL} device; {} is a {kind} device, and rEngine does not launch on a remote device",
                    json!(surface),
                    quoted(game.get("device"))
                ));
            }
        }
        for (n, value) in array(game.get("requires")).iter().enumerate() {
            if !root_relative(value) {
                errors.push(format!("{where_}.requires[{n}] must be root-relative"));
            }
        }
        if let Some(cwd) = game.get("cwd") {
            if !root_relative_directory(cwd) {
                errors.push(format!("{where_}.cwd must be root-relative"));
            }
        }
    }
    errors
}

/* ---- the dashboard ---------------------------------------------------------------------------- */

fn kind_fields(kind: &str) -> Option<&'static [&'static str]> {
    match kind {
        "script" => Some(&["script", "args", "env"]),
        "log" => Some(&["command", "filters"]),
        "capture" => Some(&["command", "into", "format"]),
        "game" => Some(&["game", "args"]),
        _ => None,
    }
}

fn kind_required(kind: &str) -> &'static [&'static str] {
    match kind {
        "script" => &["script"],
        "log" => &["command"],
        "capture" => &["command", "into", "format"],
        "game" => &["game"],
        _ => &[],
    }
}

const EVERY_KIND_FIELD: [&str; 9] =
    ["script", "args", "env", "command", "filters", "command", "into", "format", "game"];

pub fn dashboard_rules(dashboard: &Value, context: &Context) -> Vec<String> {
    let mut errors = Vec::new();
    let declared: Option<Vec<Value>> = if context.games_error {
        None
    } else {
        Some(
            context
                .games
                .as_ref()
                .and_then(Value::as_array)
                .map(|items| items.iter().map(|item| item.get("id").cloned().unwrap_or(Value::Null)).collect())
                .unwrap_or_default(),
        )
    };
    if !is_record(dashboard) || !dashboard.get("groups").is_some_and(Value::is_array) {
        return errors;
    }
    let mut groups: Vec<Value> = Vec::new();
    let mut actions: Vec<Value> = Vec::new();
    for (g, group) in array(dashboard.get("groups")).iter().enumerate() {
        if !is_record(group) {
            continue;
        }
        let gp = format!("$.dashboard.groups[{g}]");
        let gw = format!("{gp}{}", name_of(group));
        let group_id = group.get("id").cloned().unwrap_or(Value::Null);
        if groups.contains(&group_id) {
            errors.push(format!("{gp}.id repeats {}", quoted(group.get("id"))));
        }
        groups.push(group_id);
        for (i, action) in array(group.get("actions")).iter().enumerate() {
            if !is_record(action) {
                continue;
            }
            let ap = format!("{gp}.actions[{i}]");
            let named = name_of(action);
            let where_ = if named.is_empty() { format!("{gw}.actions[{i}]") } else { format!("{ap}{named}") };
            let action_id = action.get("id").cloned().unwrap_or(Value::Null);
            if actions.contains(&action_id) {
                errors.push(format!("{ap}.id repeats {}", quoted(action.get("id"))));
            }
            actions.push(action_id);
            let kind = action.get("kind").and_then(Value::as_str).unwrap_or_default();
            let Some(own) = kind_fields(kind) else { continue };
            /* A field that belongs to another kind is named as such rather than left to the schema,
               which can only say the key is unknown. */
            let mut reported: Vec<&str> = Vec::new();
            for field in EVERY_KIND_FIELD {
                if reported.contains(&field) {
                    continue;
                }
                reported.push(field);
                if action.get(field).is_some() && !own.contains(&field) {
                    errors.push(format!("{where_}.{field} is not a {kind} field"));
                }
            }
            for field in kind_required(kind) {
                if action.get(*field).is_none() {
                    errors.push(format!("{where_}: {kind} requires {field}"));
                }
            }
            for key in ["requires", "artifacts"] {
                for (n, value) in array(action.get(key)).iter().enumerate() {
                    if !root_relative(value) {
                        errors.push(format!("{where_}.{key}[{n}] must be root-relative"));
                    }
                }
            }
            if kind == "script" {
                if let Some(script) = action.get("script").and_then(Value::as_str) {
                    let shell = script.contains(['|', ';', '&', '$', '`']);
                    if !root_relative(&json!(script)) || !script.ends_with(".sh") || shell {
                        errors.push(format!("{where_}.script must be a root-relative .sh path inside the root"));
                    }
                }
            }
            if kind == "capture" {
                if let Some(into) = action.get("into").filter(|value| value.is_string()) {
                    if !root_relative(into) {
                        errors.push(format!("{where_}.into must be root-relative"));
                    }
                }
            }
            if kind == "game" {
                for (n, value) in array(action.get("args")).iter().enumerate() {
                    let literal = value.as_str().is_some_and(|text| !text.is_empty() && !text.contains("${"));
                    if !literal {
                        errors.push(format!("{where_}.args[{n}] must be a literal argument without ${{…}}"));
                    }
                }
                if let (Some(declared), Some(named)) = (declared.as_ref(), action.get("game").filter(|value| value.is_string())) {
                    if !declared.contains(named) {
                        let names: Vec<String> = declared.iter().map(|id| id.as_str().unwrap_or_default().to_string()).collect();
                        errors.push(format!(
                            "{where_}.game references undeclared game id {}; this declaration declares {}",
                            named,
                            if names.is_empty() { "no games".to_string() } else { names.join(", ") }
                        ));
                    }
                }
            }
            errors.extend(device_reference_rules(action, &where_, context));
            errors.extend(env_rules(action.get("env"), &format!("{where_}.env")));
        }
    }
    errors
}

/// The keys `${…}` may name in a format's command, and whether one is named.
pub fn uses(spec: Option<&Value>, name: &str) -> bool {
    spec.and_then(|spec| spec.get("command"))
        .and_then(Value::as_array)
        .is_some_and(|command| {
            command.iter().any(|argument| argument.as_str().is_some_and(|text| text.contains(&format!("${{{name}}}"))))
        })
}

/// `report`: three problems, then a count — one clipped line in two desktop surfaces.
pub fn report(problems: &[String]) -> String {
    const REPORTED: usize = 3;
    if problems.len() > REPORTED {
        let rest = problems.len() - REPORTED;
        format!(
            "{}; and {rest} more problem{}",
            problems[..REPORTED].join("; "),
            if rest == 1 { "" } else { "s" }
        )
    } else {
        problems.join("; ")
    }
}

/// A map with the keys the caller listed, in that order — the shape several rules build.
pub fn object(pairs: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in pairs {
        map.insert(key.to_string(), value);
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    /* The corpus that judges these rules (`tests/declaration-fixtures.json`) is frozen:
       it was recorded from the JavaScript while the JavaScript existed, so a case cannot be added to
       it now. This is the rule it could not have caught either way — every fixture in it is ASCII,
       and the bound is the one place where "how long is this string" has two answers. */
    #[test]
    fn a_value_is_bounded_the_way_javascript_bounded_it() {
        /* `envRules({ A: '😀'.repeat(2049) })` answered `['env.A must be a literal string']`:
           2049 astral characters are 2049 code points and 4098 UTF-16 code units, and the rule is
           written in code units. Counting code points would accept twice the declared limit. */
        let over = json!({ "A": "😀".repeat(2049) });
        assert_eq!(super::env_rules(Some(&over), "env"), vec!["env.A must be a literal string".to_string()]);
        let under = json!({ "A": "😀".repeat(2048) });
        assert!(super::env_rules(Some(&under), "env").is_empty(), "4096 units exactly is still a literal string");
        let ascii = json!({ "A": "x".repeat(4097) });
        assert_eq!(super::env_rules(Some(&ascii), "env"), vec!["env.A must be a literal string".to_string()]);
    }

    /// Absence and null are different answers, as they were on the other side: a declaration with no
    /// env has no rules to break, and one whose env is null is refused by name.
    #[test]
    fn an_absent_env_is_not_a_null_one() {
        assert!(super::env_rules(None, "env").is_empty());
        assert_eq!(super::env_rules(Some(&json!(null)), "env"), vec!["env must be an object of UPPER_SNAKE keys".to_string()]);
        assert_eq!(super::env_rules(Some(&json!([])), "env"), vec!["env must be an object of UPPER_SNAKE keys".to_string()]);
    }
}
