//! The routes that read a project ROOT, answered the same way by whoever is asked (F156, spec 143).
//!
//! What a project declares about itself and what it leaves behind: the declaration and its formats,
//! the recordings its recorder committed, the devices it declares and whether each answers, which
//! of its dashboard actions may be pressed, a game's preflight, its task inventory, a window of a
//! file's bytes, its worktrees, and the conversations each agent CLI already holds for it.
//!
//! **Here rather than in either server, because BOTH answer them and neither may forward them.**
//! The door answers them because it is the workspace's front. The worker answers them because the
//! host beneath it may PREDATE them — a retained session host serves a workspace that was opened
//! before these routes existed, and a worker that forwarded would answer from a host that never had
//! them. That is spec 065's whole premise and KI-043's lesson, and `capabilities.projectGame` is
//! the promise a worker makes about it: a routine workspace update lights the capability up.
//!
//! Two copies of this would be two answers to "what does this project declare", which is exactly
//! the question a person is asking when they open a pane and see nothing.

use serde_json::Value;

use crate::recordings::Fail;

/// One request about a project, with everything the answer needs and nothing about who was asked.
pub struct Asked<'a> {
    pub root_id: &'a str,
    pub root_path: &'a str,
    /// The declaration this root was registered with, where it is not the default one.
    pub declaration_file: Option<&'a str>,
    pub path: &'a str,
    /// A POST's body. `/api/format-preview` and `/api/dashboard-capture` are asked with a JSON
    /// document, and name the root IN it rather than in a query string.
    pub data: &'a Value,
    /// `URLSearchParams#get`: the FIRST value of a repeated key.
    pub query: &'a dyn Fn(&str) -> Option<String>,
    /// `Object.fromEntries(query)`: the LAST. `/api/bytes` alone read its query as an object.
    pub query_last: &'a dyn Fn(&str) -> Option<String>,
    pub environment: &'a [(String, String)],
    /// The WORKSPACE's state directory, which is the one thing here that is not about the project.
    ///
    /// A plugin is declared in the checkout and switched on beside the state: the manifest travels
    /// with the project and the decision to run it does not (spec 152 decision 5). So the routes
    /// that read one need both, and this is where the asker says where its own state is.
    pub state_directory: &'a str,
    /// The device probes the asker keeps. One listing costs one probe per device, not one per
    /// action, and the cache's LIFE is the asker's — a door outlives a worker, and both are right.
    pub probes: &'a crate::devices::Probes,
}

/// Is this a route about a project? Stated as a table because it is the decision: a server that
/// answered one of these from anywhere else would answer about a project from a view of it.
pub fn owns(method: &str, path: &str) -> bool {
    matches!(
        (method, path),
        ("GET", "/api/formats")
            | ("GET", "/api/recordings")
            | ("GET", "/api/recording")
            | ("GET", "/api/dashboard")
            | ("GET", "/api/devices")
            | ("GET", "/api/game-config")
            | ("GET", "/api/tracker")
            | ("GET", "/api/bytes")
            | ("GET", "/api/worktrees")
            | ("GET", "/api/conversations")
            | ("POST", "/api/format-preview")
            | ("POST", "/api/dashboard-capture")
            /* The plugin routes, here for this module's own reason: BOTH servers answer them and
               neither may forward them. A door with no backend is the whole workspace and answers
               everything; a worker's retained host predates plugins entirely. A copy in either one
               is a Plugins page that works at one address and is empty at the other. */
            | ("GET", "/api/extensions")
            | ("POST", "/api/extension-toggle")
            | ("GET", "/api/plugin-tools")
            | ("GET", "/api/plugin-instructions")
            | ("POST", "/api/plugin-call")
            | ("POST", "/api/plugin-configure")
    )
}

/// Does this route need the asker's STATE directory as well as the project's path?
///
/// Only the plugin routes do, and one asker pays for it: a worker learns its host's state directory
/// by asking it, which is a round trip. So it is fetched where it is needed rather than before every
/// route that reads a project.
pub fn needs_state_directory(path: &str) -> bool {
    matches!(
        path,
        "/api/extensions"
            | "/api/extension-toggle"
            | "/api/plugin-tools"
            | "/api/plugin-instructions"
            | "/api/plugin-call"
            | "/api/plugin-configure"
    )
}

/// Does this project's tracker answer from here at all?
///
/// Only the LOCAL one is Rust: the remote providers need a network client and F154 owns that
/// decision. A remote tracker is said so about rather than answered half of.
pub fn local_tracker(root_path: &str, declaration_file: Option<&str>) -> bool {
    crate::declaration::read(root_path, declaration_file)
        .get("tracker")
        .and_then(|block| block.get("provider"))
        .and_then(Value::as_str)
        .unwrap_or("local")
        == "local"
}

/// The answer. Blocking — every one of these reads a filesystem and some of them run a command — so
/// a caller on an async runtime hands it to a blocking thread.
pub fn route(asked: &Asked) -> Result<Value, Fail> {
    let Asked { root_id, root_path, declaration_file, path, data, query, query_last, environment,
                state_directory, probes } = asked;
    let declared = || crate::declaration::read(root_path, *declaration_file);
    let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|since| since.as_millis() as i64).unwrap_or(0);
    let context = |controls: bool, refresh: bool| crate::devices::Context {
        root_id,
        root_path,
        environment,
        probes,
        refresh,
        refreshed: Default::default(),
        controls,
        now: &now,
    };
    match *path {
        "/api/formats" => {
            /* `listFormats`: the declaration, wearing the id of the root it was read for. */
            let mut listed = serde_json::Map::new();
            listed.insert("rootId".to_string(), serde_json::json!(root_id));
            if let Some(fields) = declared().as_object() {
                for (key, value) in fields {
                    listed.insert(key.clone(), value.clone());
                }
            }
            Ok(Value::Object(listed))
        }
        "/api/recordings" => crate::recordings::list(root_id, root_path, query("limit").as_deref()),
        /* The Plugins page. Core knows which plugins this checkout declares and which of them are
           switched on; what each one IS, and whether it can work, is the plugin's own answer, asked
           of the plugin (spec 152). Nothing in this module names one. */
        "/api/extensions" => Ok(crate::plugins::page(root_path, state_directory)),
        "/api/extension-toggle" => {
            let name = data.get("name").and_then(Value::as_str).unwrap_or_default();
            let Some(on) = data.get("enabled").and_then(Value::as_bool) else {
                return Err(Fail::with_status("A toggle needs `enabled` to be true or false.", 400));
            };
            if !crate::plugins::declared(root_path).iter().any(|manifest| manifest.name == name) {
                return Err(Fail::with_status(format!("There is no plugin named {name:?} in this project."), 404));
            }
            crate::plugins::set_enabled(state_directory, name, on).map_err(|e| Fail::with_status(e, 409))?;
            /* Answered with the page as it now stands, so a switch shows what the workspace decided
               rather than what the click hoped for. */
            Ok(crate::plugins::page(root_path, state_directory))
        }
        /* The tools the switched-on plugins offer, for an agent's tool list. A plugin over its own
           cap is REPORTED rather than quietly dropped: a tool that is missing should be a thing
           somebody can read about. */
        "/api/plugin-tools" => {
            let (tools, refusals) = crate::plugins::tools(root_path, state_directory);
            Ok(serde_json::json!({ "tools": tools, "refusals": refusals }))
        }
        /* What the switched-on plugins want every agent to know — how an agent learns a capability
           exists without anybody installing a skill to tell it (spec 152 decision 9). */
        "/api/plugin-instructions" => {
            let (text, refusals) = crate::plugins::instructions(root_path, state_directory);
            Ok(serde_json::json!({ "instructions": text, "refusals": refusals }))
        }
        /* Settings a person typed into the Plugins page, handed to the plugin that declared them.
           Core does not keep them and is never told what a secret is; the plugin describes itself
           again afterwards, which is where "set" comes from. */
        "/api/plugin-configure" => {
            let name = data.get("name").and_then(Value::as_str).unwrap_or_default();
            let values = data.get("values").cloned().unwrap_or(Value::Null);
            let manifest = crate::plugins::declared(root_path).into_iter().find(|m| m.name == name)
                .ok_or_else(|| Fail::with_status(format!("There is no plugin named {name:?} in this project."), 404))?;
            crate::plugins::configure(&manifest, &values, root_path, state_directory)
                .map_err(|error| Fail::with_status(error, 409))?;
            Ok(crate::plugins::page(root_path, state_directory))
        }
        /* One call to a switched-on plugin's tool. The namespace is what routes it, and a plugin
           that is off is simply not routable. */
        "/api/plugin-call" => {
            let tool = data.get("tool").and_then(Value::as_str).unwrap_or_default();
            let arguments = data.get("arguments").cloned().unwrap_or(Value::Null);
            let (manifest, short) = crate::plugins::route(root_path, state_directory, tool)
                .ok_or_else(|| Fail::with_status(format!(
                    "{tool} is not offered: either no plugin declares it, or the one that does is \
                     switched off in Plugins."), 404))?;
            crate::plugins::call(&manifest, &short, &arguments, root_path, state_directory)
                .map_err(|error| Fail::with_status(error, 409))
        }

        "/api/dashboard" => Ok(crate::dashboard::dashboard_actions(&context(false, false), &declared())),
        "/api/devices" => {
            /* The Devices tab asks for the controls bound to each box; a caller that only wants to
               know which boxes answer asks the same route without them. */
            Ok(crate::dashboard::project_devices(&context(true, query("refresh").as_deref() == Some("1")), &declared()))
        }
        "/api/game-config" => crate::games::inspect_game(&context(false, false), &declared(), query("gameId").as_deref()),
        "/api/tracker" => Ok(crate::tracker::project_tracker(root_id, root_path, &declared())),
        /* A window of a file's own bytes. The query is handed over as it arrived — `Number('')` is 0
           and an absent parameter is not an empty one — because that is what `readBytes` was given. */
        "/api/bytes" => {
            let mut window = serde_json::Map::new();
            window.insert("path".into(), serde_json::json!(query("path").unwrap_or_default()));
            for name in ["offset", "length"] {
                if let Some(value) = query(name) {
                    window.insert(name.into(), serde_json::json!(value));
                }
            }
            /* `Object.fromEntries` keeps the LAST of a repeated key where `get` keeps the first. */
            for name in ["offset", "length", "path"] {
                if let Some(value) = query_last(name) {
                    window.insert(name.into(), serde_json::json!(value));
                }
            }
            crate::preview::read_bytes(root_id, root_path, &Value::Object(window))
        }
        /* What git already knows about this root's repository (F190, spec 134). Read-only. */
        "/api/worktrees" => crate::worktrees::worktrees(root_path, environment),
        /* The conversations each agent CLI already holds for this root (F210, spec 140). On demand
           and never on a timer: codex partitions its store by DATE, so answering "which of these
           belong to this project" means opening the head of every candidate. */
        "/api/conversations" => {
            let home = environment
                .iter()
                .find(|(key, _)| key == "HOME")
                .map(|(_, value)| std::path::PathBuf::from(value))
                .unwrap_or_default();
            crate::conversations::stores(&home, root_path, 30)
        }
        "/api/format-preview" => crate::preview::format_preview(root_path, &declared(), data, environment),
        /* The one project route that WRITES. */
        "/api/dashboard-capture" => {
            crate::capture::capture(&context(false, false), &declared(), data.get("actionId").and_then(Value::as_str))
        }
        _ => crate::recordings::read(
            root_id,
            root_path,
            &query("id").unwrap_or_default(),
            query("artifact").as_deref(),
            query("offset").as_deref(),
            query("limit").as_deref(),
            query("maxCharacters").as_deref(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /* The table is the decision. A route that is NOT about a project must not be answered from a
       project's declaration, and one that is must never be forwarded to a host that may predate it. */
    #[test]
    fn a_project_route_is_a_method_and_a_path_together() {
        assert!(owns("GET", "/api/game-config"));
        assert!(owns("GET", "/api/tracker"));
        assert!(owns("POST", "/api/dashboard-capture"));
        assert!(!owns("GET", "/api/dashboard-capture"), "the capture is a POST");
        assert!(!owns("POST", "/api/dashboard"), "and the listing is a GET");
        /* The workspace's own, which are not a project's. */
        for path in ["/api/state", "/api/feed", "/api/token", "/api/terminal", "/api/stop", "/api/desktops"] {
            assert!(!owns("GET", path), "{path}");
            assert!(!owns("POST", path), "{path}");
        }
        /* And the one that WRITES a task, which is `red_project::tasks`' and goes through the
           token gate rather than through here. */
        assert!(!owns("POST", "/api/task"));
    }

    /* Only the LOCAL tracker answers from here: the remote providers need a network client, and a
       server that answered half of one would report "no tasks" for a project that has plenty. */
    #[test]
    fn only_a_local_tracker_is_answered_here() {
        let at = std::env::temp_dir().join(format!("red-project-serve-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&at);
        std::fs::create_dir_all(&at).expect("a directory");
        let path = at.to_string_lossy().to_string();
        /* A project that declares nothing has the local one. */
        assert!(local_tracker(&path, None));
        std::fs::create_dir_all(at.join(".rengine")).expect("a declaration directory");
        std::fs::write(at.join(".rengine/project.json"), r#"{"contract":5,"project":"x","formats":[{"id":"text","title":"Text","match":["*.txt"],"modes":["raw"],"default":"raw"}],"tracker":{"provider":"local"}}"#).expect("written");
        assert!(local_tracker(&path, None));
        std::fs::write(at.join(".rengine/project.json"), r#"{"contract":5,"project":"x","formats":[{"id":"text","title":"Text","match":["*.txt"],"modes":["raw"],"default":"raw"}],"tracker":{"provider":"linear","team":"KOH"}}"#).expect("written");
        assert!(!local_tracker(&path, None), "a remote tracker is said so about, not answered half of");
        /* A declaration the project itself cannot read is not a remote tracker: a broken document
           answers `local` and the local backend says what is wrong with it, rather than a server
           deciding it belongs to a provider it could not name. */
        std::fs::write(at.join(".rengine/project.json"), "not json at all").expect("written");
        assert!(local_tracker(&path, None));
        let _ = std::fs::remove_dir_all(&at);
    }
}
