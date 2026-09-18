//! What THIS project asked for: `plugins/jev/flows.json` (spec 153 decisions 2, 3, 6).
//!
//! The plugin is a library of flows and no project wants all of them. A project declares the subset
//! it enables and, for each, the files that flow reads — because the corpus is the part that is not
//! shared: one project keeps antipatterns in a document of their own and has 1,394 features,
//! another has neither.
//!
//! Two rules do the work here:
//!
//! **A source is declared, never discovered.** A flow with no declared source is not enabled rather
//! than falling back to a guess about where a project keeps its lessons. A guess that is right four
//! times out of five is worse than a refusal, because the fifth answers confidently about the wrong
//! file.
//!
//! **A declared path stays inside the project.** `..`, an absolute path, and a symlink that leaves
//! the root are all refused by name. The flow reads its own sources (spec 151), so this is the only
//! place a path is accepted at all, and it is the place to be strict.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// How a flow is reached. The split is about cost: a sweep is 2,477 requests and a dollar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    /// A per-item judgement an agent calls.
    Tool,
    /// A corpus sweep a person starts and watches.
    Action,
}

impl Surface {
    pub fn as_str(&self) -> &'static str {
        match self { Surface::Tool => "tool", Surface::Action => "action" }
    }
    fn parse(text: &str) -> Option<Surface> {
        match text { "tool" => Some(Surface::Tool), "action" => Some(Surface::Action), _ => None }
    }
}

/// One flow a project enabled, with its sources already checked.
#[derive(Clone, Debug)]
pub struct Flow {
    pub name: String,
    pub surface: Surface,
    /// Source key → path relative to the project root, verified to exist and to stay inside it.
    pub sources: BTreeMap<String, PathBuf>,
    /// Whatever else the flow's own declaration carried: a taxonomy, a regex, a level list.
    pub settings: Value,
}

impl Flow {
    /// One source by the key the registry named, or a refusal that says which flow wanted it.
    pub fn source(&self, key: &str) -> Result<&Path, String> {
        self.sources.get(key).map(PathBuf::as_path)
            .ok_or_else(|| format!("the {} flow declares no {key:?} source", self.name))
    }

    pub fn setting(&self, key: &str) -> Option<&Value> {
        self.settings.get(key)
    }

    pub fn report(&self) -> Value {
        json!({
            "name": self.name,
            "surface": self.surface.as_str(),
            "sources": self.sources.iter()
                .map(|(key, path)| (key.clone(), json!(path.display().to_string())))
                .collect::<serde_json::Map<_, _>>(),
        })
    }
}

/// The state directory this run was given, remembered so a runner does not have to be handed it
/// through every signature. Set once at startup from `--state`, which is core's to supply.
static STATE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

pub fn remember_state(directory: &str) {
    let _ = STATE.set(directory.to_string());
}

pub fn state_directory() -> Result<String, String> {
    STATE.get().cloned().ok_or_else(|| "this run was given no state directory".to_string())
}

/// Where a project's declaration lives, relative to the project root.
///
/// The service runs with the project root as its working directory (spec 152 decision 8), so this
/// is resolved against that rather than against anything ambient.
pub const DECLARATION: &str = "plugins/jev/flows.json";

/// Accept a declared path only if it stays inside the project and is really there.
///
/// Both halves matter. The first is the security half; the second is the honesty half — a flow
/// enabled against a file nobody wrote would fail at the moment somebody relied on it, which is the
/// worst moment to find out.
fn declared_path(project_root: &Path, flow: &str, key: &str, named: &str) -> Result<PathBuf, String> {
    if named.is_empty() || named.contains("..") || Path::new(named).is_absolute() {
        return Err(format!(
            "the {flow} flow's {key:?} source {named:?} is not a path inside this project: a source \
             is named relative to the project root"));
    }
    let path = project_root.join(named);
    // canonicalize resolves symlinks, so a link pointing out of the tree is caught here rather than
    // being followed at read time.
    let inside = path.canonicalize()
        .map_err(|e| format!("the {flow} flow's {key:?} source {named:?} cannot be read: {e}"))?;
    let root = project_root.canonicalize()
        .map_err(|e| format!("cannot resolve the project root {}: {e}", project_root.display()))?;
    if !inside.starts_with(&root) {
        return Err(format!("the {flow} flow's {key:?} source {named:?} leaves the project"));
    }
    Ok(PathBuf::from(named))
}

/// Read a project's declaration. An absent file is no flows rather than an error: a project that
/// never asked for any is not misconfigured.
pub fn declared(project_root: &Path) -> Result<Vec<Flow>, String> {
    let path = project_root.join(DECLARATION);
    let Ok(text) = std::fs::read_to_string(&path) else { return Ok(Vec::new()) };
    let document: Value = serde_json::from_str(&text)
        .map_err(|e| format!("{} is not JSON: {e}", path.display()))?;
    let listed = document.get("flows").and_then(Value::as_array).cloned().unwrap_or_default();

    let mut flows: Vec<Flow> = Vec::new();
    for entry in listed {
        let name = entry.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
        let known = crate::registry::find(&name)
            .ok_or_else(|| format!("{name:?} is not a flow this plugin has"))?;
        if flows.iter().any(|flow| flow.name == name) {
            return Err(format!("the {name} flow is declared twice"));
        }
        // The registry's own surface is the default; a project may make a tool into an action, and
        // deliberately NOT the other way — a sweep is an action because of what it costs, and that
        // is not a project's call to reverse.
        let surface = match entry.get("surface").and_then(Value::as_str) {
            None => known.surface,
            Some(text) => {
                let asked = Surface::parse(text)
                    .ok_or_else(|| format!("the {name} flow's surface {text:?} is not tool or action"))?;
                if asked == Surface::Tool && known.surface == Surface::Action {
                    return Err(format!(
                        "the {name} flow is a corpus sweep and cannot be offered to an agent as a \
                         tool: {}", known.cost));
                }
                asked
            }
        };

        let given = entry.get("sources").and_then(Value::as_object).cloned().unwrap_or_default();
        let mut sources = BTreeMap::new();
        for key in known.sources {
            let named = given.get(*key).and_then(Value::as_str).ok_or_else(|| format!(
                "the {name} flow needs a {key:?} source and this project declares none. A source is \
                 declared rather than discovered: guessing where a project keeps its corpus is right \
                 until it is confidently wrong."))?;
            sources.insert((*key).to_string(), declared_path(project_root, &name, key, named)?);
        }
        for key in given.keys() {
            if !known.sources.contains(&key.as_str()) {
                return Err(format!("the {name} flow reads no {key:?} source"));
            }
        }
        let settings = entry.get("settings").cloned().unwrap_or(json!({}));
        flows.push(Flow { name, surface, sources, settings });
    }
    Ok(flows)
}

/// One flow by name, only if this project enabled it.
pub fn enabled(project_root: &Path, name: &str) -> Result<Flow, String> {
    declared(project_root)?.into_iter().find(|flow| flow.name == name).ok_or_else(|| format!(
        "this project has not enabled the {name} flow. Its flows are declared in {DECLARATION}."))
}

/// What core offers an agent: the tool-surface flows, as MCP tool declarations.
///
/// Namespacing and the cap are core's (spec 152), not this list's — it says what is on offer and
/// core decides how much of it an agent sees.
pub fn tools(project_root: &Path) -> Result<Vec<Value>, String> {
    let mut offered = Vec::new();
    for flow in declared(project_root)? {
        if flow.surface != Surface::Tool { continue; }
        let known = crate::registry::find(&flow.name).expect("declared() already resolved it");
        offered.push(json!({
            "name": flow.name,
            // The flow IS the subcommand, so core's own routing picks it: a single `run` would
            // lose which flow was asked for, because core hands a tool's arguments to its command
            // and not the tool's name.
            "command": flow.name,
            "description": known.description,
            "inputSchema": (known.schema)(),
        }));
    }
    Ok(offered)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(tag: &str, document: Value) -> PathBuf {
        let root = std::env::temp_dir().join(format!("jev-flows-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("plugins").join("jev")).expect("dirs");
        std::fs::create_dir_all(root.join("docs")).expect("docs");
        std::fs::write(root.join("docs").join("lessons-learned.md"), "## LL-1 — a lesson\n").expect("corpus");
        std::fs::write(root.join("features.json"), "{\"features\":[]}").expect("features");
        std::fs::write(root.join(DECLARATION), document.to_string()).expect("declaration");
        root
    }

    #[test]
    fn a_project_that_declared_nothing_has_no_flows_rather_than_a_fault() {
        let root = std::env::temp_dir().join(format!("jev-flows-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("root");
        assert!(declared(&root).expect("absent is fine").is_empty());
    }

    #[test]
    fn a_project_gets_exactly_the_subset_it_declared() {
        let root = project("subset", json!({ "flows": [
            { "name": "find", "sources": { "corpus": "docs/lessons-learned.md" } },
        ] }));
        let flows = declared(&root).expect("read");
        assert_eq!(flows.len(), 1);
        assert_eq!(flows[0].name, "find");
        assert_eq!(flows[0].surface, Surface::Tool);
        assert_eq!(tools(&root).expect("tools").len(), 1, "and that is what an agent is offered");
        assert!(enabled(&root, "align").is_err(), "a flow it did not enable is not reachable");
    }

    #[test]
    fn a_source_is_declared_rather_than_guessed() {
        let root = project("nosource", json!({ "flows": [{ "name": "find" }] }));
        let error = declared(&root).expect_err("refused");
        assert!(error.contains("needs a \"corpus\" source"), "{error}");
        assert!(error.contains("confidently wrong"), "and says why guessing is worse: {error}");
    }

    #[test]
    fn a_source_that_leaves_the_project_is_refused_by_name() {
        for bad in ["../../../etc/passwd", "/etc/passwd"] {
            let root = project("escape", json!({ "flows": [
                { "name": "find", "sources": { "corpus": bad } }] }));
            let error = declared(&root).expect_err("refused");
            assert!(error.contains("inside this project"), "{bad}: {error}");
        }
        // And one that is inside but is not there: enabled against a file nobody wrote fails at the
        // moment somebody relies on it, which is the worst moment to find out.
        let root = project("missing", json!({ "flows": [
            { "name": "find", "sources": { "corpus": "docs/nothing-here.md" } }] }));
        assert!(declared(&root).expect_err("refused").contains("cannot be read"));
    }

    #[test]
    fn a_sweep_cannot_be_turned_into_an_agent_tool() {
        let root = project("sweep", json!({ "flows": [
            { "name": "ki-sweep", "surface": "tool",
              "sources": { "issues": "docs/lessons-learned.md", "features": "features.json" } }] }));
        let error = declared(&root).expect_err("refused");
        assert!(error.contains("cannot be offered to an agent as a tool"), "{error}");
        // The other direction is a project's own call: making a tool into an action costs nothing.
        let root = project("toaction", json!({ "flows": [
            { "name": "find", "surface": "action", "sources": { "corpus": "docs/lessons-learned.md" } }] }));
        let flows = declared(&root).expect("read");
        assert_eq!(flows[0].surface, Surface::Action);
        assert!(tools(&root).expect("tools").is_empty(), "and it stops being offered as a tool");
    }

    #[test]
    fn an_unknown_flow_or_an_unread_source_is_refused_rather_than_ignored() {
        let root = project("unknown", json!({ "flows": [{ "name": "invent-a-flow" }] }));
        assert!(declared(&root).expect_err("refused").contains("is not a flow"));

        let root = project("extra", json!({ "flows": [
            { "name": "find", "sources": { "corpus": "docs/lessons-learned.md", "spare": "features.json" } }] }));
        let error = declared(&root).expect_err("refused");
        assert!(error.contains("reads no \"spare\" source"), "{error}");

        let root = project("twice", json!({ "flows": [
            { "name": "find", "sources": { "corpus": "docs/lessons-learned.md" } },
            { "name": "find", "sources": { "corpus": "docs/lessons-learned.md" } }] }));
        assert!(declared(&root).expect_err("refused").contains("declared twice"));
    }
}
