//! What the editor pane and a connected CLI both read (F158, spec 129; spec 133, spec 102).
//!
//! Two children, and the relationship between them is the point. `red-lsp-serve` holds the language
//! servers a project DECLARES — one process per project root, started the first time a file under
//! it is asked about, so a workspace with three projects open does not run three toolchains nobody
//! looked at. `red-ide serve` is the bridge a CLI connects to, and when that CLI asks for
//! diagnostics the bridge asks back here, because **the editor pane and `getDiagnostics` read one
//! store**: a file cannot be broken for one of them and fine for the other (D3).
//!
//! Both belong to the WORKER rather than to the state directory. A replaced worker starts its own,
//! exactly as the JavaScript did: a language server is a process somebody's editing session owns,
//! not a workspace fact that outlives it.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::pipe::{Answering, Pipe};

/// `$RENGINE_RED_LSP_SERVE` / `$RENGINE_RED_IDE`, then this checkout's debug or release build.
///
/// Named rather than guessed: a missing binary is a sentence a person can act on, and the fallback
/// order is the JavaScript's.
pub fn binary(variable: &str, name: &str) -> Result<String, String> {
    if let Some(declared) = std::env::var(variable).ok().filter(|value| !value.is_empty()) {
        if Path::new(&declared).exists() {
            return Ok(declared);
        }
        return Err(format!("{variable} names {declared}, which does not exist."));
    }
    let checkout = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.ancestors().nth(4).map(Path::to_path_buf))
        .ok_or_else(|| format!("cannot find {name}: this binary is nowhere it recognises."))?;
    for profile in ["debug", "release"] {
        let candidate = checkout.join("red/target").join(profile).join(name);
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }
    Err(format!("The {name} binary is required (run: cargo build, or set {variable})."))
}

/// The language servers serving one project.
pub struct Servers {
    pipe: Arc<Pipe>,
}

impl Servers {
    /// Start the client for one root and hand it the servers that root declares. The declaration
    /// goes first and is awaited, so nothing is asked of a client that has not been told what it
    /// runs — a `diagnostics` before the declaration would answer for no servers at all.
    pub fn start(root_path: &str, declared: &Value) -> Result<Servers, String> {
        let binary = binary("RENGINE_RED_LSP_SERVE", "red-lsp-serve")?;
        let pipe = Pipe::spawn(&binary, &[root_path.to_string()], None)?;
        let servers = declared.get("languageServers").cloned().unwrap_or_else(|| json!([]));
        pipe.call("declare", json!([servers]))?;
        Ok(Servers { pipe })
    }

    /// What the servers have said about one file, and the version a poller compares against.
    pub fn diagnostics(&self, uri: &str) -> Result<Value, String> {
        self.pipe.call("diagnostics", json!([uri]))
    }

    /// The buffer the person is looking at, not the file on disk: the desktop sends what it holds
    /// and that is what the servers are told, so a diagnostic describes the unsaved edit.
    pub fn open(&self, file: &str, text: &str) -> Result<Value, String> {
        self.pipe.call("open", json!([file, text]))
    }

    pub fn stop(&self) {
        let _ = self.pipe.call("stop", json!([]));
        self.pipe.end();
    }
}

/// One set of language servers per root, started the first time a file under it is asked about.
#[derive(Default)]
pub struct PerRoot {
    held: Mutex<HashMap<String, Arc<Servers>>>,
}

impl PerRoot {
    pub fn new() -> PerRoot {
        PerRoot::default()
    }

    pub fn of(&self, root_id: &str, root_path: &str, declared: &Value) -> Result<Arc<Servers>, String> {
        if let Some(held) = self.held.lock().expect("servers").get(root_id) {
            return Ok(held.clone());
        }
        /* Started OUTSIDE the lock: starting a toolchain can take a moment, and a second project
           asking about its own files meanwhile has nothing to do with this one. */
        let started = Arc::new(Servers::start(root_path, declared)?);
        let mut held = self.held.lock().expect("servers");
        Ok(held.entry(root_id.to_string()).or_insert(started).clone())
    }

    /// Everything the servers of every root have said about one file, which is what a connected CLI
    /// asks for: it names a file, not a project.
    pub fn about(&self, uri: &str) -> Value {
        let held: Vec<Arc<Servers>> = self.held.lock().expect("servers").values().cloned().collect();
        let mut items = Vec::new();
        for servers in held {
            if let Some(found) = servers.diagnostics(uri).ok().and_then(|answer| answer.get("items").cloned()) {
                items.extend(found.as_array().cloned().unwrap_or_default());
            }
        }
        Value::Array(items)
    }

    pub fn stop(&self) {
        for (_, servers) in std::mem::take(&mut *self.held.lock().expect("servers")) {
            servers.stop();
        }
    }
}

/// The bridge a CLI connects to, and what it published.
pub struct Bridge {
    pipe: Arc<Pipe>,
    pub published: bool,
    pub port: Option<u64>,
    pub reason: Option<String>,
}

impl Bridge {
    /// Start one for this worker. `answering` is how the bridge reaches back for diagnostics, and
    /// passing `None` tells it so — a bridge that claimed the capability and then refused every ask
    /// would offer a CLI a feature that never works.
    pub fn start(options: Value, answering: Option<Answering>) -> Result<Bridge, String> {
        let binary = binary("RENGINE_RED_IDE", "red-ide")?;
        let answers = answering.is_some();
        let pipe = Pipe::spawn(&binary, &["serve".to_string()], answering)?;
        let mut options = options;
        options["diagnostics"] = json!(answers);
        let answer = pipe.call("start", json!([options]))?;
        Ok(Bridge {
            published: answer.get("published") == Some(&Value::Bool(true)),
            port: answer.get("port").and_then(Value::as_u64),
            reason: answer.get("reason").and_then(Value::as_str).map(str::to_string),
            pipe,
        })
    }

    /// A fact about the editor: which file, which range. Deliberate in the other direction from a
    /// mention, and the CLI treats the two differently.
    pub fn selection(&self, value: Value) -> Result<Value, String> {
        self.pipe.call("selection", json!([value]))
    }

    /// The person pressed a button that says so.
    pub fn mention(&self, value: Value) -> Result<Value, String> {
        self.pipe.call("mention", json!([value]))
    }

    pub fn close(&self) {
        let _ = self.pipe.call("close", json!([]));
        self.pipe.end();
    }
}

/// How many clients a delivery reached, as the route answers it. A bridge that published nothing
/// delivered to nobody, and says 0 rather than refusing: the desktop reports a selection on every
/// cursor move and a refusal there would be a refusal a person sees constantly.
pub fn delivered(answer: Result<Value, String>) -> Value {
    match answer {
        Ok(value) if value.is_number() => value,
        Ok(value) => value.get("delivered").cloned().unwrap_or(json!(0)),
        Err(_) => json!(0),
    }
}

/// The file a route is about: a root's path and a path within it, as every other route names one.
pub fn file_in(root_path: &str, asked: Option<&str>) -> String {
    /* `path.join(root, '')` is the root, with no trailing separator: a caller that named no path is
       asking about the project itself, and Rust's `join("")` would answer about a directory that
       does not exist by that name. */
    match asked.filter(|path| !path.is_empty()) {
        Some(path) => Path::new(root_path).join(path).to_string_lossy().to_string(),
        None => root_path.to_string(),
    }
}

/// `pathToFileURL`, from the one implementation of it — `red-lsp` keys its store by the same call.
pub fn uri_for(file: &str) -> String {
    red_core::text::file_uri(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_binary_nobody_has_is_named_rather_than_guessed_at() {
        let refused = binary("RENGINE_A_VARIABLE_NOBODY_SET", "no-such-binary").expect_err("refused");
        assert!(refused.contains("no-such-binary"), "{refused}");
        assert!(refused.contains("RENGINE_A_VARIABLE_NOBODY_SET"), "it says how to point at one: {refused}");

        /* And one that is declared but not there says WHICH path was named, because the variable is
           usually the thing that is wrong. */
        std::env::set_var("RENGINE_A_VARIABLE_POINTING_NOWHERE", "/nowhere/at/all");
        let named = binary("RENGINE_A_VARIABLE_POINTING_NOWHERE", "red-ide").expect_err("refused");
        assert!(named.contains("/nowhere/at/all"), "{named}");
        std::env::remove_var("RENGINE_A_VARIABLE_POINTING_NOWHERE");
    }

    /* This crate asks `red-lsp` for a key `red-lsp` computed, so what matters here is that the two
       are the SAME call. The characters themselves are `red_core::text`'s to get right. */
    #[test]
    fn a_file_is_asked_about_by_the_key_the_store_computed() {
        assert_eq!(uri_for("/work/project/src/main.rs"), red_core::text::file_uri("/work/project/src/main.rs"));
        assert_eq!(
            uri_for("/w/~notes/a b.rs"),
            red_lsp::servers::uri_for(std::path::Path::new("/w/~notes/a b.rs")),
            "the editor pane and the store reach one entry, whatever is in the path"
        );
    }

    #[test]
    fn a_route_names_a_file_by_its_root_and_a_path_within_it() {
        assert_eq!(file_in("/work/project", Some("src/main.rs")), "/work/project/src/main.rs");
        /* A caller that named no path is asking about the project itself, which is not a file and
           is answered as one rather than refused — the JavaScript's `path.join(root, '')`. */
        assert_eq!(file_in("/work/project", None), "/work/project");
    }

    /* A selection is reported on every cursor move, so "nobody is connected" is an ANSWER rather
       than a refusal: a person would otherwise see one constantly. */
    #[test]
    fn a_delivery_that_reached_nobody_is_a_count_rather_than_a_refusal() {
        assert_eq!(delivered(Ok(json!(3))), json!(3));
        assert_eq!(delivered(Ok(json!({ "delivered": 2 }))), json!(2));
        assert_eq!(delivered(Ok(json!({}))), json!(0));
        assert_eq!(delivered(Err("the bridge went away.".to_string())), json!(0));
    }
}
