//! Which of a project's declared actions may be pressed, and which half of one is not ready
//! (F155, spec 075/078/082).
//!
//! Availability COMPOSES: the device answering, and this action's own local prerequisites, with the
//! failing half named. A person reading a grey button gets the reason from `missing`, and there is
//! nowhere else the reason exists — so each entry's `type` and its sentence are as much the
//! interface as the button is.
//!
//! This is also where the two listings meet. `project_devices` asks for the board so a device can
//! carry the controls bound to it, and the board asks each action's device for its reachability;
//! one probe cache under both is what keeps that from costing a probe per action.

use serde_json::{json, Value};

use crate::devices::{bound_targets, declared_devices, device_status, is_local, target_availability, Context, LOCAL};
use crate::games::inspect_game;
use crate::rules::object;

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn strings<'a>(value: &'a Value, key: &str) -> Vec<&'a str> {
    value.get(key).and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).collect()).unwrap_or_default()
}

/// `{ rootId, declared }` and then whichever refusal the declaration already carries.
fn refused(root_id: &str, declared: &Value, section: &str, empty: &'static str) -> Option<Value> {
    let mut fields: Vec<(&'static str, Value)> = vec![("rootId", json!(root_id)), ("declared", declared.get("declared").cloned().unwrap_or(json!(false)))];
    if declared.get("declared").and_then(Value::as_bool) != Some(true) {
        fields.push((empty, json!([])));
        return Some(object(fields));
    }
    if let Some(said) = declared.get("error").and_then(Value::as_str) {
        fields.push(("error", json!(said)));
        fields.push((empty, json!([])));
        return Some(object(fields));
    }
    if let Some(said) = declared.get(section).and_then(Value::as_str) {
        fields.push(("contract", declared.get("contract").cloned().unwrap_or(Value::Null)));
        fields.push(("error", json!(said)));
        fields.push((empty, json!([])));
        return Some(object(fields));
    }
    None
}

/// A game action's availability is its referenced record's preflight, taken from the spec-078 path
/// the launch itself uses rather than a second copy of those checks.
fn game_missing(context: &Context<'_>, declared: &Value, action: &Value) -> Vec<Value> {
    match inspect_game(context, declared, action.get("game").and_then(Value::as_str)) {
        Err(fail) => vec![json!({ "type": "game", "name": fail.message })],
        Ok(config) => {
            if config.get("ready").and_then(Value::as_bool) == Some(true) {
                Vec::new()
            } else {
                let first = config.get("issues").and_then(Value::as_array).and_then(|issues| issues.first()).cloned();
                vec![json!({ "type": "game", "name": first.unwrap_or_else(|| json!("The game preflight failed.")) })]
            }
        }
    }
}

pub fn dashboard_actions(context: &Context<'_>, declared: &Value) -> Value {
    if let Some(answer) = refused(context.root_id, declared, "dashboardError", "groups") {
        return answer;
    }
    let Some(dashboard) = declared.get("dashboard").filter(|value| value.is_object()) else {
        return object(vec![
            ("rootId", json!(context.root_id)),
            ("declared", json!(true)),
            ("contract", declared.get("contract").cloned().unwrap_or(Value::Null)),
            ("groups", json!([])),
        ]);
    };
    let groups: Vec<Value> = dashboard
        .get("groups")
        .and_then(Value::as_array)
        .map(|groups| {
            groups
                .iter()
                .map(|group| {
                    let actions: Vec<Value> = group
                        .get("actions")
                        .and_then(Value::as_array)
                        .map(|actions| actions.iter().map(|action| resolve_action(context, declared, action)).collect())
                        .unwrap_or_default();
                    object(vec![
                        ("id", group.get("id").cloned().unwrap_or(Value::Null)),
                        ("title", group.get("title").cloned().unwrap_or(Value::Null)),
                        ("actions", json!(actions)),
                    ])
                })
                .collect()
        })
        .unwrap_or_default();
    object(vec![
        ("rootId", json!(context.root_id)),
        ("declared", json!(true)),
        ("contract", declared.get("contract").cloned().unwrap_or(Value::Null)),
        ("title", dashboard.get("title").cloned().unwrap_or(Value::Null)),
        ("groups", json!(groups)),
    ])
}

fn resolve_action(context: &Context<'_>, declared: &Value, action: &Value) -> Value {
    let mut missing: Vec<Value> = Vec::new();
    for name in strings(action, "requires") {
        if !crate::devices::present(context.root_path, name) {
            missing.push(json!({ "type": "requires", "name": name }));
        }
    }
    for name in strings(action, "tools") {
        if !crate::devices::on_path(name, context.environment) {
            missing.push(json!({ "type": "tools", "name": name }));
        }
    }
    let (device, unreachable) = target_availability(context, declared, Some(action));
    missing.extend(unreachable);
    if text(action, "kind") == "game" && missing.is_empty() {
        missing.extend(game_missing(context, declared, action));
    }
    /* `{ ...action, device, available, missing }`: the action's own keys keep their declared order,
       and a declared `device` — an id — is REPLACED IN PLACE by the record, so a caller reads the
       device it resolved to where it wrote the name. */
    let mut out = action.as_object().cloned().unwrap_or_default();
    match device {
        Some(record) => {
            out.insert("device".into(), record);
        }
        None => {
            out.remove("device");
        }
    }
    out.insert("available".into(), json!(missing.is_empty()));
    out.insert("missing".into(), json!(missing));
    Value::Object(out)
}

/// The controls a device's targets become in the Devices tab. Availability is NOT recomputed here:
/// the board is the caller's own, already composed, and a game's state is the same preflight the
/// launch uses. Both run after every device status, so they read the probe cache those filled and a
/// control costs no probe of its own.
pub fn project_devices(context: &Context<'_>, declared: &Value) -> Value {
    if let Some(answer) = refused(context.root_id, declared, "devicesError", "devices") {
        return answer;
    }
    let records = declared_devices(declared);
    let resolved: Vec<Value> = records.iter().map(|device| device_status(context, device)).collect();
    let board = dashboard_actions(context, declared);
    let actions: Vec<Value> = board
        .get("groups")
        .and_then(Value::as_array)
        .map(|groups| groups.iter().flat_map(|group| group.get("actions").and_then(Value::as_array).cloned().unwrap_or_default()).collect())
        .unwrap_or_default();
    let game_records: Vec<Value> = declared.get("games").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut states: serde_json::Map<String, Value> = serde_json::Map::new();
    for game in &game_records {
        let id = text(game, "id").to_string();
        /* A reason the device already carries is dropped rather than restated: an unreachable
           device is one reason on one row, never the same sentence under every target bound to it. */
        let carried: Vec<String> = records
            .iter()
            .position(|record| text(record, "id") == game.get("device").and_then(Value::as_str).unwrap_or(LOCAL))
            .and_then(|index| resolved[index].get("issues").and_then(Value::as_array).cloned())
            .map(|issues| issues.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        let state = match inspect_game(context, declared, Some(&id)) {
            Err(fail) => object(vec![
                ("id", json!(id)),
                ("title", game.get("title").cloned().unwrap_or(Value::Null)),
                ("ready", json!(false)),
                ("remote", json!(false)),
                ("issue", json!(fail.message)),
                ("location", json!("")),
            ]),
            Ok(config) => {
                let first = config
                    .get("issues")
                    .and_then(Value::as_array)
                    .and_then(|issues| issues.iter().filter_map(Value::as_str).find(|issue| !carried.iter().any(|seen| seen == issue)))
                    .unwrap_or_default()
                    .to_string();
                object(vec![
                    ("id", json!(id)),
                    ("title", game.get("title").cloned().unwrap_or(Value::Null)),
                    ("ready", json!(config.get("ready").and_then(Value::as_bool).unwrap_or(false))),
                    ("remote", json!(config.get("refusal").is_some())),
                    ("issue", json!(first)),
                    ("location", config.get("location").cloned().unwrap_or_else(|| json!(""))),
                ])
            }
        };
        states.insert(id, state);
    }
    let devices: Vec<Value> = records
        .iter()
        .enumerate()
        .map(|(index, device)| {
            let id = text(device, "id");
            let (games, bound_actions) = bound_targets(declared, id);
            let mut out = resolved[index].as_object().cloned().unwrap_or_default();
            out.insert(
                "declared".into(),
                json!(declared.get("devices").and_then(Value::as_array).is_some_and(|items| items.iter().any(|item| text(item, "id") == id))),
            );
            out.insert("probed".into(), json!(!is_local(device) && device.get("probe").and_then(Value::as_array).is_some()));
            out.insert("games".into(), json!(games));
            out.insert("actions".into(), json!(bound_actions));
            /* A resolved action carries the device RECORD in `device`, not the declared id, and an
               action naming an undeclared device carries none — so it lands under no device. */
            let controls: Vec<Value> = actions
                .iter()
                .filter(|action| action.get("device").and_then(|device| device.get("id")).and_then(Value::as_str) == Some(id))
                .map(|action| {
                    object(vec![
                        ("id", action.get("id").cloned().unwrap_or(Value::Null)),
                        ("title", action.get("title").cloned().unwrap_or(Value::Null)),
                        ("kind", action.get("kind").cloned().unwrap_or(Value::Null)),
                        ("available", action.get("available").cloned().unwrap_or(Value::Null)),
                        ("missing", action.get("missing").cloned().unwrap_or(Value::Null)),
                    ])
                })
                .collect();
            let targets: Vec<Value> = game_records
                .iter()
                .filter(|game| game.get("device").and_then(Value::as_str).unwrap_or(LOCAL) == id)
                .filter_map(|game| states.get(text(game, "id")).cloned())
                .collect();
            out.insert("controls".into(), json!(controls));
            out.insert("targets".into(), json!(targets));
            Value::Object(out)
        })
        .collect();
    object(vec![
        ("rootId", json!(context.root_id)),
        ("declared", json!(true)),
        ("contract", declared.get("contract").cloned().unwrap_or(Value::Null)),
        ("refreshed", json!(context.refresh)),
        ("devices", json!(devices)),
    ])
}
