//! Plugins with a service facet (F232, charter D75, spec 152).
//!
//! Core's whole knowledge of a plugin is here, and it is deliberately thin: read the manifests, know
//! which are switched on, invoke a service, and merge the tools of the ones that are on — **capped**.
//! What a plugin *does* is the plugin's business, and nothing in this file names one.
//!
//! The reason this file exists at all is a correction: the first attempt wired a specific plugin's
//! route into the worker and its tool into red-mcp's captured declaration, which made it a core
//! feature with a switch on it. A plugin has to be able to bring a capability without core learning
//! its name.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// Spec 152 decision 3. A tool list that grows without bound costs every agent context on every
/// call, so the growth is bounded here rather than by everyone's restraint.
pub const TOOLS_PER_PLUGIN: usize = 4;
pub const TOOLS_IN_TOTAL: usize = 16;

/// Where a plugin keeps everything of its own. Core reads exactly one file in here.
pub fn plugin_state(state_directory: &str, name: &str) -> PathBuf {
    Path::new(state_directory).join("plugins").join(name)
}

fn enabled_marker(state_directory: &str, name: &str) -> PathBuf {
    plugin_state(state_directory, name).join("enabled")
}

/// Is this plugin switched on? Off unless a person turned it on: a workspace that has never heard of
/// a plugin behaves exactly as it did before.
pub fn enabled(state_directory: &str, name: &str) -> bool {
    enabled_marker(state_directory, name).exists()
}

pub fn set_enabled(state_directory: &str, name: &str, on: bool) -> Result<(), String> {
    let directory = plugin_state(state_directory, name);
    std::fs::create_dir_all(&directory).map_err(|e| format!("cannot make {}: {e}", directory.display()))?;
    let marker = enabled_marker(state_directory, name);
    if on {
        std::fs::write(&marker, "on\n").map_err(|e| format!("cannot switch {name} on: {e}"))
    } else {
        match std::fs::remove_file(&marker) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("cannot switch {name} off: {error}")),
        }
    }
}

/// One declared plugin, as its manifest says it is.
#[derive(Clone, Debug)]
pub struct Manifest {
    pub name: String,
    pub title: String,
    pub description: String,
    pub root: PathBuf,
    pub service: Option<Value>,
}

impl Manifest {
    fn read(path: &Path, root: &Path) -> Option<Manifest> {
        let text = std::fs::read_to_string(path).ok()?;
        let value: Value = serde_json::from_str(&text).ok()?;
        let name = value.get("name")?.as_str()?.to_string();
        // A name is an identifier: it becomes a directory under the state directory and a prefix on
        // every tool the plugin offers, so anything that could escape either is not a name.
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
            return None;
        }
        Some(Manifest {
            title: value.get("title").and_then(Value::as_str).unwrap_or(&name).to_string(),
            description: value.get("description").and_then(Value::as_str).unwrap_or_default().to_string(),
            name,
            root: root.to_path_buf(),
            service: value.get("service").cloned(),
        })
    }

    /// The tools this plugin offers, namespaced and capped. Refused BY NAME over the cap rather than
    /// truncated: a plugin whose fourth tool silently vanished would be a bug nobody could see.
    pub fn tools(&self) -> Result<Vec<Value>, String> {
        let Some(service) = &self.service else { return Ok(Vec::new()) };
        let declared = service.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
        if declared.len() > TOOLS_PER_PLUGIN {
            return Err(format!(
                "the plugin {} declares {} tools and a plugin may declare at most {}. \
                 Refused rather than trimmed, because a tool that silently vanished would be worse.",
                self.name, declared.len(), TOOLS_PER_PLUGIN));
        }
        let mut tools = Vec::new();
        for tool in declared {
            let Some(short) = tool.get("name").and_then(Value::as_str) else { continue };
            let mut offered = tool.clone();
            // Namespaced, so an agent reading its list can see which plugin put each one there and
            // two plugins cannot collide over a good name.
            offered["name"] = json!(format!("{}.{}", self.name, short));
            if let Some(object) = offered.as_object_mut() { object.remove("command"); }
            tools.push(offered);
        }
        Ok(tools)
    }

    fn command_for(&self, tool: &str) -> Option<(Vec<String>, String)> {
        let service = self.service.as_ref()?;
        let program = service.get("command")?.as_array()?.iter()
            .filter_map(|part| part.as_str().map(str::to_string)).collect::<Vec<_>>();
        if program.is_empty() { return None; }
        let subcommand = service.get("tools")?.as_array()?.iter()
            .find(|declared| declared.get("name").and_then(Value::as_str) == Some(tool))?
            .get("command")?.as_str()?.to_string();
        Some((program, subcommand))
    }
}

/// Every plugin declared in this checkout. A manifest that will not parse is skipped rather than
/// fatal: one broken plugin is not a reason for the page to be empty.
pub fn declared(project_root: &str) -> Vec<Manifest> {
    let plugins = Path::new(project_root).join("plugins");
    let Ok(entries) = std::fs::read_dir(&plugins) else { return Vec::new() };
    let mut found: Vec<Manifest> = entries.filter_map(|entry| {
        let directory = entry.ok()?.path();
        if !directory.is_dir() { return None; }
        Manifest::read(&directory.join("plugin.json"), &directory)
    }).collect();
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

/// What the Plugins page renders. Core says whether it is on; the plugin says whether it can work,
/// in its own words, and core does not second-guess it.
pub fn page(project_root: &str, state_directory: &str) -> Value {
    let mut rows = Vec::new();
    for manifest in declared(project_root) {
        let on = enabled(state_directory, &manifest.name);
        let mut row = json!({
            "name": manifest.name,
            "title": manifest.title,
            "description": manifest.description,
            "enabled": on,
            "hasService": manifest.service.is_some(),
            "tools": manifest.tools().map(|tools| tools.len()).unwrap_or(0),
        });
        // Asking the plugin to describe itself costs a process, so it is asked only when it is on.
        if on {
            match describe(&manifest, project_root, state_directory) {
                Ok(said) => { row["detail"] = said.get("detail").cloned().unwrap_or(Value::Null);
                              row["ready"] = said.get("ready").cloned().unwrap_or(json!(true));
                              row["usage"] = said.get("usage").cloned().unwrap_or(Value::Null); }
                Err(error) => { row["detail"] = json!(error); row["ready"] = json!(false); }
            }
        }
        rows.push(row);
    }
    json!({ "extensions": rows })
}

/// Ask a plugin's service to describe itself.
pub fn describe(manifest: &Manifest, project_root: &str, state_directory: &str) -> Result<Value, String> {
    let service = manifest.service.as_ref().ok_or_else(|| format!("{} has no service", manifest.name))?;
    let program = service.get("command").and_then(Value::as_array)
        .map(|parts| parts.iter().filter_map(|p| p.as_str().map(str::to_string)).collect::<Vec<_>>())
        .unwrap_or_default();
    let describe = service.get("describe").and_then(Value::as_str).unwrap_or("status").to_string();
    if program.is_empty() { return Err(format!("{} declares no service command", manifest.name)); }
    invoke(&program, &describe, &[], project_root, state_directory, &manifest.name)
}

/// Call one of a plugin's tools. `tool` is the SHORT name; the namespace was stripped by the caller
/// that matched it.
pub fn call(manifest: &Manifest, tool: &str, arguments: &Value,
            project_root: &str, state_directory: &str) -> Result<Value, String> {
    let (program, subcommand) = manifest.command_for(tool)
        .ok_or_else(|| format!("{} has no tool {tool}", manifest.name))?;
    let mut flags = Vec::new();
    if let Some(object) = arguments.as_object() {
        for (key, value) in object {
            // Only scalars cross: an argument that is an object or an array is a way to smuggle a
            // document into a command line, and every declared parameter here is an identifier.
            let text = match value {
                Value::String(text) => text.clone(),
                Value::Number(number) => number.to_string(),
                Value::Bool(flag) => flag.to_string(),
                _ => continue,
            };
            flags.push(format!("--{key}"));
            flags.push(text);
        }
    }
    invoke(&program, &subcommand, &flags, project_root, state_directory, &manifest.name)
}

/// Run the service once and read one JSON object off its stdout.
fn invoke(program: &[String], subcommand: &str, flags: &[String],
          project_root: &str, state_directory: &str, name: &str) -> Result<Value, String> {
    let executable = Path::new(project_root).join(&program[0]);
    if !executable.exists() {
        return Err(format!("the {name} plugin's service is not built: {} is not there.",
                           executable.display()));
    }
    let plugin_state = plugin_state(state_directory, name);
    let mut command = std::process::Command::new(&executable);
    command.args(&program[1..]).arg(subcommand)
        .arg("--state").arg(&plugin_state)
        .args(flags)
        .current_dir(project_root)
        // Nothing ambient: a service is given its own state directory and the arguments it was
        // declared with, and inherits no environment it was not handed (spec 152 decision 8).
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .stdin(std::process::Stdio::null());
    let output = command.output().map_err(|e| format!("cannot run the {name} plugin's service: {e}"))?;
    if !output.status.success() {
        let said = String::from_utf8_lossy(&output.stderr);
        return Err(said.lines().next().unwrap_or("the plugin's service refused").to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(text.trim())
        .map_err(|_| format!("the {name} plugin's service did not answer with JSON"))
}

/// Every tool the switched-on plugins offer, namespaced and capped in total.
pub fn tools(project_root: &str, state_directory: &str) -> (Vec<Value>, Vec<String>) {
    let mut offered = Vec::new();
    let mut refusals = Vec::new();
    for manifest in declared(project_root) {
        if !enabled(state_directory, &manifest.name) { continue; }
        match manifest.tools() {
            Ok(tools) => {
                if offered.len() + tools.len() > TOOLS_IN_TOTAL {
                    refusals.push(format!(
                        "{} is switched on but its tools are not offered: {} plugin tools is the \
                         limit, and adding them would pass it.", manifest.name, TOOLS_IN_TOTAL));
                    continue;
                }
                offered.extend(tools);
            }
            Err(refusal) => refusals.push(refusal),
        }
    }
    (offered, refusals)
}

/// Find the plugin a namespaced tool belongs to, and the short name it knows itself by.
pub fn route(project_root: &str, state_directory: &str, namespaced: &str)
             -> Option<(Manifest, String)> {
    let (plugin, tool) = namespaced.split_once('.')?;
    let manifest = declared(project_root).into_iter().find(|m| m.name == plugin)?;
    if !enabled(state_directory, &manifest.name) { return None; }
    manifest.command_for(tool)?;
    Some((manifest, tool.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(tag: &str) -> (String, String) {
        let base = std::env::temp_dir().join(format!("rengine-plugins-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("project");
        let state = base.join("state");
        std::fs::create_dir_all(root.join("plugins").join("demo")).expect("root");
        std::fs::create_dir_all(&state).expect("state");
        std::fs::write(root.join("plugins").join("demo").join("plugin.json"), json!({
            "name": "demo", "title": "A demo",
            "service": { "command": ["bin/demo"], "tools": [
                { "name": "ask", "command": "ask", "description": "d", "inputSchema": { "type": "object" } }] }
        }).to_string()).expect("manifest");
        (root.to_str().expect("utf8").to_string(), state.to_str().expect("utf8").to_string())
    }

    #[test]
    fn a_plugin_is_off_until_a_person_turns_it_on() {
        let (root, state) = workspace("toggle");
        assert!(!enabled(&state, "demo"), "absent means off");
        assert!(tools(&root, &state).0.is_empty(), "and a switched-off plugin offers no tools");

        set_enabled(&state, "demo", true).expect("on");
        assert!(enabled(&state, "demo"));
        let (offered, refusals) = tools(&root, &state);
        assert_eq!(offered.len(), 1, "its tool is offered once it is on");
        assert!(refusals.is_empty());

        set_enabled(&state, "demo", false).expect("off");
        assert!(tools(&root, &state).0.is_empty(), "and stops being offered when it is off again");
        // Off twice is not an error: a page that double-clicks must not produce a failure.
        set_enabled(&state, "demo", false).expect("off again");
    }

    #[test]
    fn a_tool_is_namespaced_by_its_plugin() {
        let (root, state) = workspace("namespace");
        set_enabled(&state, "demo", true).expect("on");
        let (offered, _) = tools(&root, &state);
        assert_eq!(offered[0]["name"], "demo.ask", "so an agent can see where it came from");
        assert!(offered[0].get("command").is_none(), "and the plugin's private wiring is not offered");
    }

    #[test]
    fn a_plugin_over_the_cap_is_refused_by_name_rather_than_trimmed() {
        let (root, state) = workspace("cap");
        let many: Vec<Value> = (0..TOOLS_PER_PLUGIN + 1).map(|i| json!({
            "name": format!("t{i}"), "command": "x", "description": "d",
            "inputSchema": { "type": "object" } })).collect();
        std::fs::write(Path::new(&root).join("plugins/demo/plugin.json"), json!({
            "name": "demo", "service": { "command": ["bin/demo"], "tools": many } }).to_string()).expect("write");
        set_enabled(&state, "demo", true).expect("on");

        let (offered, refusals) = tools(&root, &state);
        assert!(offered.is_empty(), "nothing is offered from a plugin over the cap");
        assert_eq!(refusals.len(), 1);
        assert!(refusals[0].contains("demo") && refusals[0].contains("at most"),
                "and the refusal names the plugin and the limit: {}", refusals[0]);
    }

    #[test]
    fn a_name_that_could_escape_a_directory_is_not_a_name() {
        let (root, _state) = workspace("names");
        for bad in ["../escape", "Demo", "with space", ""] {
            std::fs::write(Path::new(&root).join("plugins/demo/plugin.json"),
                           json!({ "name": bad }).to_string()).expect("write");
            assert!(declared(&root).is_empty(), "{bad:?} must not be read as a plugin");
        }
    }

    #[test]
    fn a_broken_manifest_does_not_empty_the_page() {
        let (root, state) = workspace("broken");
        let broken = Path::new(&root).join("plugins").join("wrecked");
        std::fs::create_dir_all(&broken).expect("dir");
        std::fs::write(broken.join("plugin.json"), "{ not json").expect("write");
        assert_eq!(declared(&root).len(), 1, "the good one survives the broken one");
        assert_eq!(page(&root, &state)["extensions"].as_array().expect("rows").len(), 1);
    }

    #[test]
    fn a_service_that_is_not_built_says_so_rather_than_failing_obscurely() {
        let (root, state) = workspace("unbuilt");
        set_enabled(&state, "demo", true).expect("on");
        let rows = page(&root, &state);
        let row = &rows["extensions"][0];
        assert_eq!(row["ready"], false);
        assert!(row["detail"].as_str().expect("detail").contains("not built"),
                "the page says what is wrong: {}", row["detail"]);
    }

    #[test]
    fn routing_finds_the_plugin_behind_a_namespaced_tool_and_only_while_it_is_on() {
        let (root, state) = workspace("route");
        assert!(route(&root, &state, "demo.ask").is_none(), "off means unroutable");
        set_enabled(&state, "demo", true).expect("on");
        let (manifest, tool) = route(&root, &state, "demo.ask").expect("routed");
        assert_eq!(manifest.name, "demo");
        assert_eq!(tool, "ask");
        assert!(route(&root, &state, "demo.nothing").is_none(), "an undeclared tool is not routable");
        assert!(route(&root, &state, "bare").is_none(), "and an unnamespaced name is not either");
    }
}
