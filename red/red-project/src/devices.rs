//! What a project's declared devices are, and whether each one answers (F155, spec 082, contract 4).
//!
//! A probe is **reachability, never launchability**: a green ssh probe still cannot create a GL
//! context in a logon session without a window station, which is why remote launching stays with
//! the project's own script. Bounded and side-effect-light rather than read-only, because `adb`
//! starts its own daemon.
//!
//! Every sentence here is read by a person in the Devices tab, and every one of them is compared
//! word for word against `tests/devices-corpus.json` — the answers the JavaScript gave,
//! recorded before it was replaced.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::command;
use crate::rules::object;

pub const LOCAL: &str = "local";
pub const PROBE_TTL_MS: i64 = 15_000;
pub const PROBE_TIMEOUT_MS: u64 = 5_000;
pub const PROBE_MAX_BYTES: usize = 64 * 1024;
const CACHE_LIMIT: usize = 256;

/// The implicit local device, always offered so a consumer never has to declare it to bind to it
/// or to see it listed; a declared one wins, so its own title is used.
pub fn this_machine() -> Value {
    json!({ "id": LOCAL, "kind": LOCAL, "title": "This machine" })
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn label(device: &Value) -> String {
    format!("{} ({})", text(device, "title"), text(device, "id"))
}

pub fn is_local(device: &Value) -> bool {
    text(device, "kind") == LOCAL
}

pub fn declared_devices(declared: &Value) -> Vec<Value> {
    let records: Vec<Value> = declared.get("devices").and_then(Value::as_array).cloned().unwrap_or_default();
    if records.iter().any(|device| text(device, "id") == LOCAL) {
        records
    } else {
        std::iter::once(this_machine()).chain(records).collect()
    }
}

pub fn device_for(declared: &Value, id: Option<&str>) -> Option<Value> {
    let wanted = id.unwrap_or(LOCAL);
    declared_devices(declared).into_iter().find(|device| text(device, "id") == wanted)
}

/// value or env; an env that is unset or empty is a named reason, never a spawn with an empty
/// argument and never one with the placeholder left in.
fn resolve_value(node: Option<&Value>, field: &str, environment: &[(String, String)]) -> Result<String, String> {
    let Some(node) = node.filter(|node| node.is_object()) else {
        return Err(format!("it declares no {field}"));
    };
    if let Some(value) = node.get("value") {
        let literal = value.as_str().unwrap_or_default();
        return if literal.is_empty() { Err(format!("its {field} is empty")) } else { Ok(literal.to_string()) };
    }
    let key = text(node, "env");
    match environment.iter().find(|(name, _)| name == key) {
        None => Err(format!("{key} is not set in the workspace environment")),
        Some((_, raw)) if raw.is_empty() => Err(format!("{key} is empty in the workspace environment")),
        Some((_, raw)) => Ok(raw.clone()),
    }
}

/// A file inside the project root, by the same confinement every declared path gets.
pub fn present(root_path: &str, relative: &str) -> bool {
    red_store::store::resolve_in_root(root_path, relative, false).is_ok()
}

/// An executable of that name on this machine's PATH.
pub fn on_path(name: &str, environment: &[(String, String)]) -> bool {
    let key = environment.iter().find(|(key, _)| key.eq_ignore_ascii_case("PATH"));
    let Some((_, paths)) = key else { return false };
    let extensions: Vec<&str> = if cfg!(windows) { vec![".EXE", ".CMD", ".BAT"] } else { vec![""] };
    let separator = if cfg!(windows) { ';' } else { ':' };
    for directory in paths.split(separator).filter(|part| !part.is_empty()) {
        for extension in &extensions {
            let candidate = Path::new(directory).join(format!("{name}{extension}"));
            if executable(&candidate) {
                return true;
            }
        }
    }
    false
}

fn executable(file: &Path) -> bool {
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

struct Cached {
    at: i64,
    value: Value,
}

/// The probe cache, held by whoever is long-lived enough to have one.
///
/// A TTL alone would not help a dashboard: its actions resolve one device many times, so this is
/// what makes one listing cost one probe per device rather than one per action. It belongs to the
/// process — red-host's, or one run of the CLI — because a probe's result is about a moment, and a
/// cache on disk shared by two processes could not coalesce the probes they start at once.
pub struct Probes {
    entries: Mutex<HashMap<String, Cached>>,
    /// Where this cache outlives its process, when the caller has somewhere to keep it.
    ///
    /// A long-lived host keeps its probes in memory and joins the ones already in flight. A CLI
    /// invocation cannot join anything — but without somewhere to write them, opening the Devices
    /// tab and then pressing a button on it would probe the same unreachable box twice, and wait
    /// out its timeout twice, where the JavaScript probed once. Two invocations racing can still
    /// both probe; one extra probe is the cost of not being one process, and it is bounded.
    file: Option<std::path::PathBuf>,
}

impl Default for Probes {
    fn default() -> Self {
        Probes { entries: Mutex::new(HashMap::new()), file: None }
    }
}

impl Probes {
    /// The cache a caller keeps between runs. A file that will not parse is an empty cache, never
    /// an error: a probe result is an optimisation, and refusing to answer because a cache was
    /// damaged would make it a dependency.
    pub fn kept_at(file: &Path) -> Probes {
        let mut entries = HashMap::new();
        if let Some(stored) = std::fs::read_to_string(file).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()) {
            if let Some(map) = stored.as_object() {
                for (key, entry) in map {
                    if let Some(at) = entry.get("at").and_then(Value::as_i64) {
                        entries.insert(key.clone(), Cached { at, value: entry.get("value").cloned().unwrap_or(Value::Null) });
                    }
                }
            }
        }
        Probes { entries: Mutex::new(entries), file: Some(file.to_path_buf()) }
    }

    /// Write what this run learned, for the next one. Only entries still inside the TTL, so the
    /// file cannot grow without bound on a workspace whose devices keep changing.
    pub fn keep(&self, now: i64) {
        let Some(file) = self.file.as_ref() else { return };
        let entries = self.entries.lock().expect("probe cache");
        let mut document = serde_json::Map::new();
        for (key, entry) in entries.iter().filter(|(_, entry)| now - entry.at < PROBE_TTL_MS) {
            document.insert(key.clone(), json!({ "at": entry.at, "value": entry.value }));
        }
        if let Some(parent) = file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = crate::write_atomically(file, &Value::Object(document));
    }

    pub fn forget(&self) {
        self.entries.lock().expect("probe cache").clear();
    }

    fn get(&self, key: &str, now: i64) -> Option<Value> {
        let entries = self.entries.lock().expect("probe cache");
        entries.get(key).filter(|entry| now - entry.at < PROBE_TTL_MS).map(|entry| entry.value.clone())
    }

    fn put(&self, key: &str, now: i64, value: &Value) {
        let mut entries = self.entries.lock().expect("probe cache");
        entries.insert(key.to_string(), Cached { at: now, value: value.clone() });
        if entries.len() > CACHE_LIMIT {
            let oldest: Vec<String> = {
                let mut ordered: Vec<(&String, i64)> = entries.iter().map(|(key, entry)| (key, entry.at)).collect();
                ordered.sort_by_key(|(_, at)| *at);
                ordered.iter().take(entries.len() - CACHE_LIMIT).map(|(key, _)| (*key).clone()).collect()
            };
            for key in oldest {
                entries.remove(&key);
            }
        }
    }

    fn forget_one(&self, key: &str) {
        self.entries.lock().expect("probe cache").remove(key);
    }
}

/// Everything a device question depends on that is not the declaration: the environment the
/// workspace holds, the clock, and the probes already taken.
pub struct Context<'a> {
    pub root_id: &'a str,
    pub root_path: &'a str,
    pub environment: &'a [(String, String)],
    pub probes: &'a Probes,
    pub refresh: bool,
    /// The keys this CALL has already re-probed.
    ///
    /// `refresh` means "ask again", once — not "ask again every time you are asked", and not once
    /// per process either. The JavaScript got the first by NOT passing its options into the
    /// dashboard resolution it triggered, so only the devices listing's own per-device calls
    /// refreshed. Said here instead, because it is a property of the word rather than of who
    /// happened to forward an argument — and it belongs to the CALL, not to the cache: a long-lived
    /// door that remembered "already refreshed" across requests would serve a second refresh from
    /// the very cache it was asked to bypass, which is a person pressing Refresh and being shown
    /// the same stale answer.
    pub refreshed: Mutex<std::collections::HashSet<String>>,
    /// Whether the devices listing carries the controls and targets bound to each device.
    ///
    /// The JavaScript decided this by whether the caller handed it a `resolve` function; there is
    /// nothing to hand in now, so the caller says so instead. It stays a choice because the payload
    /// is bigger with them, and a caller that only wants to know which boxes answer should not have
    /// to carry every button bound to each one.
    pub controls: bool,
    pub now: &'a dyn Fn() -> i64,
}

impl Context<'_> {
    fn stamp(&self) -> String {
        red_core::time::iso((self.now)())
    }
}

fn base_of(device: &Value) -> Vec<(&'static str, Value)> {
    vec![
        ("id", json!(text(device, "id"))),
        ("kind", json!(text(device, "kind"))),
        ("title", json!(text(device, "title"))),
    ]
}

fn unreachable(device: &Value, at: &str, issues: Vec<String>) -> Value {
    let mut fields = base_of(device);
    fields.push(("reachable", json!(false)));
    fields.push(("checkedAt", json!(at)));
    fields.push(("issues", json!(issues)));
    object(fields)
}

fn strings<'a>(device: &'a Value, key: &str) -> Vec<&'a str> {
    device.get(key).and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).collect()).unwrap_or_default()
}

fn probe(context: &Context<'_>, device: &Value, argv: &[String]) -> Value {
    let timeout = device.get("probeTimeoutMs").and_then(Value::as_u64).unwrap_or(PROBE_TIMEOUT_MS);
    match command::run(Path::new(context.root_path), argv, context.environment, timeout, PROBE_MAX_BYTES) {
        Ok(_) => json!({ "reachable": true, "checkedAt": context.stamp(), "issues": [] }),
        Err(failed) => {
            /* The runner already names the exit status and the first stderr line, or the timeout;
               this only changes whose failure it was and drops the trailing stop. */
            let reason = failed.message.strip_prefix("Command ").map(|rest| format!("the probe {rest}")).unwrap_or(failed.message);
            let reason = reason.trim_end_matches([' ', '.', '\t', '\n', '\r']);
            json!({
                "reachable": false,
                "checkedAt": context.stamp(),
                "issues": [format!("{} is not reachable: {reason}.", label(device))],
            })
        }
    }
}

/// Reachability for one device, with its local prerequisites checked first.
pub fn device_status(context: &Context<'_>, device: &Value) -> Value {
    let at = context.stamp();
    let mut issues = Vec::new();
    /* requires and tools are LOCAL by definition even on a remote device, and are checked first:
       there is no point probing an ssh device when ssh is not installed. */
    for name in strings(device, "requires") {
        if !present(context.root_path, name) {
            issues.push(format!("{} needs {name}, which is missing here.", label(device)));
        }
    }
    for name in strings(device, "tools") {
        if !on_path(name, context.environment) {
            issues.push(format!("{} needs {name} on this machine's PATH.", label(device)));
        }
    }
    if !issues.is_empty() {
        return unreachable(device, &at, issues);
    }
    let declared_probe = device.get("probe").and_then(Value::as_array).cloned();
    let Some(declared_probe) = declared_probe.filter(|_| !is_local(device)) else {
        let mut fields = base_of(device);
        fields.push(("reachable", json!(true)));
        fields.push(("checkedAt", json!(at)));
        fields.push(("issues", json!([])));
        return object(fields);
    };
    let mut values: Vec<(&str, String)> = Vec::new();
    for field in ["host", "selector"] {
        let named = declared_probe.iter().any(|argument| argument.as_str().is_some_and(|text| text.contains(&format!("${{{field}}}"))));
        if !named {
            continue;
        }
        match resolve_value(device.get(field), field, context.environment) {
            Err(missing) => return unreachable(device, &at, vec![format!("{} is not reachable: {missing}.", label(device))]),
            Ok(value) => values.push((field, value)),
        }
    }
    let argv: Vec<String> = declared_probe
        .iter()
        .map(|argument| {
            let mut text = argument.as_str().unwrap_or_default().to_string();
            for (field, value) in &values {
                text = text.replace(&format!("${{{field}}}"), value);
            }
            text
        })
        .collect();
    if argv.iter().any(|argument| argument.contains("${")) {
        return unreachable(device, &at, vec![format!("{} is not reachable: its probe has an unresolved placeholder.", label(device))]);
    }
    /* NUL-separated so no component can forge a boundary; the argv and the timeout are in the key,
       so editing the declaration or the environment variable invalidates the entry. */
    let key = [
        context.root_id.to_string(),
        text(device, "id").to_string(),
        serde_json::to_string(&argv).unwrap_or_default(),
        device.get("probeTimeoutMs").and_then(Value::as_u64).unwrap_or(PROBE_TIMEOUT_MS).to_string(),
    ]
    .join("\u{0}");
    if context.refresh && context.refreshed.lock().expect("refreshed keys").insert(key.clone()) {
        context.probes.forget_one(&key);
    }
    let now = (context.now)();
    let result = match context.probes.get(&key, now) {
        Some(cached) => cached,
        None => {
            let taken = probe(context, device, &argv);
            context.probes.put(&key, now, &taken);
            taken
        }
    };
    let mut fields = base_of(device);
    for name in ["reachable", "checkedAt", "issues"] {
        fields.push((leaked(name), result.get(name).cloned().unwrap_or(Value::Null)));
    }
    object(fields)
}

/// `object()` takes `&'static str`; these three names are literals and this keeps them so.
fn leaked(name: &str) -> &'static str {
    match name {
        "reachable" => "reachable",
        "checkedAt" => "checkedAt",
        _ => "issues",
    }
}

/// The failing half is named, and both halves are reported: a reachable device with a missing local
/// file reports the file.
pub fn target_availability(context: &Context<'_>, declared: &Value, target: Option<&Value>) -> (Option<Value>, Vec<Value>) {
    let named = target.and_then(|target| target.get("device"));
    let Some(device) = device_for(declared, named.and_then(Value::as_str)) else {
        let quoted = named.map(|value| value.to_string()).unwrap_or_else(|| "undefined".into());
        return (None, vec![json!({ "type": "device", "name": format!("Unknown device {quoted} for this project.") })]);
    };
    let status = device_status(context, &device);
    let reachable = status.get("reachable").and_then(Value::as_bool).unwrap_or(false);
    let missing = if reachable {
        Vec::new()
    } else {
        status
            .get("issues")
            .and_then(Value::as_array)
            .map(|issues| issues.iter().map(|name| json!({ "type": "device", "name": name })).collect())
            .unwrap_or_default()
    };
    (Some(status), missing)
}

fn bound_to(target: &Value, id: &str) -> bool {
    target.get("device").and_then(Value::as_str).unwrap_or(LOCAL) == id
}

/// The games and dashboard actions a device carries.
pub fn bound_targets(declared: &Value, id: &str) -> (Vec<Value>, Vec<Value>) {
    let games = declared
        .get("games")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter(|game| bound_to(game, id)).map(|game| game.get("id").cloned().unwrap_or(Value::Null)).collect())
        .unwrap_or_default();
    let actions = declared
        .get("dashboard")
        .and_then(|dashboard| dashboard.get("groups"))
        .and_then(Value::as_array)
        .map(|groups| {
            groups
                .iter()
                .flat_map(|group| group.get("actions").and_then(Value::as_array).cloned().unwrap_or_default())
                .filter(|action| bound_to(action, id))
                .map(|action| action.get("id").cloned().unwrap_or(Value::Null))
                .collect()
        })
        .unwrap_or_default();
    (games, actions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_local_device_is_offered_until_it_is_declared() {
        let none = json!({});
        assert_eq!(declared_devices(&none).len(), 1, "a project with no devices still has this machine");
        let declared = json!({ "devices": [{ "id": "local", "kind": "local", "title": "The workstation" }] });
        assert_eq!(text(&declared_devices(&declared)[0], "title"), "The workstation", "and a declared one wins its own title");
        let remote = json!({ "devices": [{ "id": "box", "kind": "ssh", "title": "Box" }] });
        assert_eq!(declared_devices(&remote).len(), 2, "the implicit local is prepended, never replaced");
        assert_eq!(text(&device_for(&remote, None).expect("a device"), "id"), LOCAL, "and an unbound target resolves to it");
    }

    /// The cache the JavaScript kept in memory, kept across processes instead — because a CLI
    /// invocation cannot join a probe already in flight, and opening the Devices tab and then
    /// pressing a button on it would otherwise wait out an unreachable box's timeout twice.
    #[test]
    fn a_probe_is_not_taken_twice_inside_the_ttl_and_a_refresh_takes_it_anyway() {
        let root = std::env::temp_dir().join(format!("red-project-probes-{}", crate::uuid_like()));
        std::fs::create_dir_all(root.join("tools")).expect("a directory");
        let script = root.join("tools/probe-count.sh");
        std::fs::write(&script, "#!/bin/bash\nprintf \"x\" >> probe-count.txt\nexit 0\n").expect("a script");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("executable");
        }
        let device = json!({ "id": "counted-box", "kind": "ssh", "title": "Counted box", "probe": ["tools/probe-count.sh"] });
        let root_path = root.to_string_lossy().into_owned();
        let file = root.join("probes.json");
        let runs = || std::fs::read_to_string(root.join("probe-count.txt")).map(|text| text.len()).unwrap_or(0);
        let at = 1_789_387_200_000i64;
        let now = move || at;
        let once = |refresh: bool| {
            let probes = Probes::kept_at(&file);
            let environment: Vec<(String, String)> = Vec::new();
            let context = Context { root_id: "r", root_path: &root_path, environment: &environment, probes: &probes, refresh, refreshed: Default::default(), controls: false, now: &now };
            let answer = device_status(&context, &device);
            probes.keep(at);
            answer
        };
        let first = once(false);
        assert_eq!(first["reachable"], json!(true));
        assert_eq!(runs(), 1);
        let second = once(false);
        assert_eq!(runs(), 1, "a second check inside the TTL is served from the cache, in another process");
        assert_eq!(second["checkedAt"], first["checkedAt"], "and reports when it was actually checked");
        let refreshed = once(true);
        assert_eq!(runs(), 2, "an explicit refresh asks again");
        assert_eq!(refreshed["reachable"], json!(true));

        /* And asks again the NEXT time too. The set of keys a refresh has already dropped belongs to
           the call, not to the cache: red-host keeps one cache for as long as it runs, so a set kept
           beside it would mark every device on the first Refresh and serve the second from the very
           cache it was asked to bypass — a person pressing Refresh and being shown the same stale
           answer. Invisible to a CLI, which gets a fresh cache per call, and invisible to a corpus,
           because both answers are well-formed; the desktop gate found it. */
        let long_lived = Probes::kept_at(&file);
        let environment: Vec<(String, String)> = Vec::new();
        let mut taken = Vec::new();
        for _ in 0..2 {
            let context = Context {
                root_id: "r", root_path: &root_path, environment: &environment, probes: &long_lived,
                refresh: true, refreshed: Default::default(), controls: false, now: &now,
            };
            taken.push(device_status(&context, &device));
        }
        assert_eq!(runs(), 4, "two refreshes through one long-lived cache are two probes");
        assert_eq!(taken.len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An env that is unset or empty is a named reason, never a spawn with an empty argument.
    #[test]
    fn a_value_is_declared_or_named_in_the_environment() {
        let environment = vec![("SET".to_string(), "yes".to_string()), ("EMPTY".to_string(), String::new())];
        assert_eq!(resolve_value(Some(&json!({ "value": "literal" })), "host", &environment), Ok("literal".into()));
        assert_eq!(resolve_value(Some(&json!({ "value": "" })), "host", &environment), Err("its host is empty".into()));
        assert_eq!(resolve_value(Some(&json!({ "env": "SET" })), "host", &environment), Ok("yes".into()));
        assert_eq!(resolve_value(Some(&json!({ "env": "EMPTY" })), "host", &environment), Err("EMPTY is empty in the workspace environment".into()));
        assert_eq!(resolve_value(Some(&json!({ "env": "GONE" })), "host", &environment), Err("GONE is not set in the workspace environment".into()));
        assert_eq!(resolve_value(None, "selector", &environment), Err("it declares no selector".into()));
    }
}
