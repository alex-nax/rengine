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
    let Asked { root_id, root_path, declaration_file, path, data, query, query_last, environment, probes } = asked;
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
