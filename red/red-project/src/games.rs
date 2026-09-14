//! What a declared game needs before it can be launched (F155, spec 078/082).
//!
//! Preflight reads only the declaration, the filesystem and the root record, so a replaceable
//! workspace layer can serve it from its own checkout; launching keeps the session host's process
//! state and is not here.
//!
//! THE rule (spec 082): a non-local target is never resolved or stat-ed against the local
//! filesystem. That check is what produced "Game executable not found" for a target that can never
//! be built on this machine — a sentence that sent people looking for a build they were never
//! supposed to have. Its `requires` stay local, because those are what the launch needs *here*.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::devices::{device_for, device_status, is_local, Context, LOCAL};
use crate::recordings::Fail;
use crate::rules::object;

pub const UNDECLARED: &str = "This project declares no games in .rengine/project.json (contract 3).";

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn unready(root_id: &str, root_path: &str, issue: &str) -> Value {
    object(vec![
        ("rootId", json!(root_id)),
        ("declared", json!(false)),
        ("args", json!([])),
        ("cwd", json!(root_path)),
        ("issues", json!([issue])),
        ("ready", json!(false)),
    ])
}

fn executable_at(file: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(file) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// A declared executable, resolved against the project first and the PATH second.
pub fn resolve_candidate(root_path: &str, candidate: &str, environment: &[(String, String)]) -> Option<String> {
    let suffixes: &[&str] = if cfg!(windows) { &["", ".exe"] } else { &[""] };
    if Path::new(candidate).is_absolute() || candidate.contains('/') || candidate.contains('\\') {
        let resolved = Path::new(root_path).join(candidate);
        for suffix in suffixes {
            let file = PathBuf::from(format!("{}{suffix}", resolved.to_string_lossy()));
            if executable_at(&file) {
                return Some(file.to_string_lossy().into_owned());
            }
        }
        return None;
    }
    let separator = if cfg!(windows) { ';' } else { ':' };
    let paths = environment.iter().find(|(key, _)| key.eq_ignore_ascii_case("PATH")).map(|(_, value)| value.as_str()).unwrap_or_default();
    for directory in paths.split(separator).filter(|part| !part.is_empty()) {
        for suffix in suffixes {
            let file = Path::new(directory).join(format!("{candidate}{suffix}"));
            if executable_at(&file) {
                return Some(file.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// The remote launch belongs to the project's own script, which holds knowledge that does not
/// belong in an orchestrator; the refusal names the declaration's own actions.
fn remote_refusal(declared: &Value, game: &Value, device: &Value) -> String {
    let id = text(device, "id");
    let scripts: Vec<&str> = declared
        .get("dashboard")
        .and_then(|dashboard| dashboard.get("groups"))
        .and_then(Value::as_array)
        .map(|groups| {
            groups
                .iter()
                .flat_map(|group| group.get("actions").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default())
                .filter(|action| text(action, "kind") == "script" && action.get("device").and_then(Value::as_str).unwrap_or(LOCAL) == id)
                .filter_map(|action| action.get("id").and_then(Value::as_str))
                .take(3)
                .collect()
        })
        .unwrap_or_default();
    let where_ = format!(
        "{} runs on {} ({id}), not on this machine, and rEngine does not launch on a remote device.",
        text(game, "title"),
        text(device, "title")
    );
    if scripts.is_empty() {
        format!("{where_} Declare a dashboard script action bound to that device; the remote launch stays with the project's own script.")
    } else {
        format!(
            "{where_} Use this project's own dashboard script {}: {}.",
            if scripts.len() == 1 { "action" } else { "actions" },
            scripts.join(", ")
        )
    }
}

/// `path.resolve(root, relative)`: an empty relative names the root itself, which is the one place
/// a declared path may be empty — `cwd` defaults to the project root.
fn resolve_from(root_path: &str, relative: &str) -> String {
    if relative.is_empty() {
        return root_path.to_string();
    }
    if Path::new(relative).is_absolute() {
        return relative.to_string();
    }
    Path::new(root_path).join(relative).to_string_lossy().into_owned()
}

/// The checkout's built surface adapter, which belongs to injection alone.
fn adapter_path() -> PathBuf {
    /* From the BINARY, not from `CARGO_MANIFEST_DIR`, which is baked at compile time: the
       JavaScript resolved this against its own module URL, so it named the checkout the code was
       running from. `red/target/<profile>/red-project` is four levels down from that checkout. */
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.ancestors().nth(4).map(Path::to_path_buf))
        .map(|checkout| checkout.join(".cache/native/librengine_surface.dylib"))
        .unwrap_or_default()
}

pub fn inspect_game(context: &Context<'_>, declared: &Value, game_id: Option<&str>) -> Result<Value, Fail> {
    let (root_id, root_path) = (context.root_id, context.root_path);
    if declared.get("declared").and_then(Value::as_bool) != Some(true) {
        return Ok(unready(root_id, root_path, UNDECLARED));
    }
    for key in ["error", "gamesError"] {
        if let Some(said) = declared.get(key).and_then(Value::as_str) {
            return Ok(unready(root_id, root_path, said));
        }
    }
    let games: Vec<Value> = declared.get("games").and_then(Value::as_array).cloned().unwrap_or_default();
    if games.is_empty() {
        return Ok(unready(root_id, root_path, UNDECLARED));
    }
    let wanted = game_id.filter(|id| !id.is_empty());
    let game = match wanted {
        None => games[0].clone(),
        Some(id) => games.iter().find(|game| text(game, "id") == id).cloned().ok_or_else(|| {
            Fail {
                message: format!(
                    "Unknown gameId {} for this project; it declares {}.",
                    serde_json::to_string(id).unwrap_or_default(),
                    games.iter().map(|game| text(game, "id")).collect::<Vec<_>>().join(", ")
                ),
                status: 404,
            }
        })?,
    };
    let record = device_for(declared, game.get("device").and_then(Value::as_str)).ok_or_else(|| Fail {
        message: format!(
            "Game {} names undeclared device {}.",
            serde_json::to_string(text(&game, "id")).unwrap_or_default(),
            game.get("device").map(|value| value.to_string()).unwrap_or_else(|| "undefined".into())
        ),
        status: 409,
    })?;
    let device = device_status(context, &record);
    let local = is_local(&record);
    let mut issues: Vec<String> = Vec::new();
    if device.get("reachable").and_then(Value::as_bool) != Some(true) {
        issues.extend(device.get("issues").and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>()).unwrap_or_default());
    }
    let candidates: Vec<&str> = game.get("executable").and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let mut executable: Option<String> = None;
    if local {
        for candidate in &candidates {
            if let Some(found) = resolve_candidate(root_path, candidate, context.environment) {
                executable = Some(found);
                break;
            }
        }
        if executable.is_none() {
            issues.push(format!("Game executable not found; expected {} in the selected project.", candidates.join(" or ")));
        }
    }
    let requires: Vec<&str> = game.get("requires").and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    for relative in &requires {
        if !std::fs::metadata(Path::new(root_path).join(relative)).map(|meta| meta.is_file()).unwrap_or(false) {
            issues.push(format!("Required file is missing: {relative}."));
        }
    }
    let declared_cwd = game.get("cwd").and_then(Value::as_str).unwrap_or("");
    let cwd = if local { Some(resolve_from(root_path, declared_cwd)) } else { None };
    if local && !declared_cwd.is_empty() {
        let directory = cwd.clone().unwrap_or_default();
        if !std::fs::metadata(&directory).map(|meta| meta.is_dir()).unwrap_or(false) {
            issues.push(format!("Working directory is missing: {declared_cwd}."));
        }
    }
    let mut fields: Vec<(&'static str, Value)> = vec![
        ("rootId", json!(root_id)),
        ("declared", json!(true)),
        ("id", json!(text(&game, "id"))),
        ("title", json!(text(&game, "title"))),
        ("surface", game.get("surface").cloned().unwrap_or(Value::Null)),
        ("device", device.clone()),
        ("executable", executable.clone().map_or(Value::Null, |found| json!(found))),
        ("candidates", json!(candidates)),
        ("args", game.get("args").cloned().unwrap_or_else(|| json!([]))),
        ("env", game.get("env").cloned().unwrap_or_else(|| json!({}))),
        ("requires", json!(requires)),
        ("cwd", cwd.map_or(Value::Null, |path| json!(path))),
    ];
    if !local {
        fields.push(("location", json!(format!(
            "{} on {} ({}), not on this machine",
            candidates.first().copied().unwrap_or_default(),
            text(&device, "title"),
            text(&device, "id")
        ))));
        fields.push(("refusal", json!(remote_refusal(declared, &game, &device))));
    } else if text(&game, "surface") == "embedded" {
        /* The adapter and its platform gate belong to injection alone. A cooperative game carries
           its own client, which is a loopback socket and a byte layout, so it inherits neither. */
        let adapter = adapter_path();
        fields.push(("adapter", json!(adapter.to_string_lossy())));
        if cfg!(target_os = "macos") {
            if !adapter.exists() {
                issues.push("Build the native surface first: npm run build:surface".into());
            }
        } else {
            issues.push("The embedded game surface needs host integration and qualification on this platform.".into());
        }
    }
    let ready = issues.is_empty();
    fields.push(("issues", json!(issues)));
    fields.push(("ready", json!(ready)));
    Ok(object(fields))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    /// The refusal names the project's own script actions, and says what to do when there are none.
    #[test]
    fn a_remote_target_is_refused_in_the_projects_own_words() {
        let game = json!({ "id": "remote-target", "title": "Remote target", "device": "box" });
        let device = json!({ "id": "box", "title": "The box" });
        let bare = json!({});
        assert_eq!(
            super::remote_refusal(&bare, &game, &device),
            "Remote target runs on The box (box), not on this machine, and rEngine does not launch on a remote device. \
Declare a dashboard script action bound to that device; the remote launch stays with the project's own script."
        );
        let declared = json!({ "dashboard": { "groups": [{ "actions": [
            { "id": "deploy", "kind": "script", "device": "box" },
            { "id": "local-thing", "kind": "script" },
            { "id": "tail", "kind": "log", "device": "box" }
        ] }] } });
        assert!(super::remote_refusal(&declared, &game, &device).ends_with("Use this project's own dashboard script action: deploy."),
            "only script actions bound to THAT device, and the singular when there is one");
    }
}
