//! red-store's state half (F169, F147a, spec 129, KI-091): WorkspaceStore ported from
//! orchestrator/server/store.mjs with byte-compatible on-disk behavior.
//!
//! Byte-parity rules that shaped this file:
//! - serde_json runs with preserve_order: JS object insertion order IS the on-disk key order,
//!   and `JSON.stringify(state, null, 2)` is what `serde_json::to_string_pretty` emits for the
//!   same ordered value (2-space indent, empty containers inline, no trailing newline).
//! - Mint and the clock are parameters, as in F168's composition: the corpus replay drives the
//!   store with the recorded placeholders and stamps.
//! - Raw fs errors carry JS-shaped messages ("ENOENT: no such file or directory, realpath
//!   '<path>'") because the corpus compares them; fail() errors carry their status.
//! - The id-shape for a conversation arrives as a function (the checker wires the shipped
//!   recipes' shapes; arbitrary recipe regexes are F170's decision, recorded in the evidence).

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

pub const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
pub const CONVERSATION_LIMIT: usize = 20;

const HIDDEN: [&str; 4] = [".git", "node_modules", ".cache", ".venv"];
const RECORDING: [(&str, i64, i64); 5] = [
    ("seconds", 5, 900),
    ("bytes", 4 * 1024 * 1024, 1024 * 1024 * 1024),
    ("fps", 1, 30),
    ("width", 160, 1280),
    ("quality", 30, 95),
];

#[derive(Debug)]
pub struct Fail {
    pub message: String,
    pub status: Option<u16>,
}

impl Fail {
    fn new(message: impl Into<String>, status: u16) -> Self {
        Fail { message: message.into(), status: Some(status) }
    }
    fn raw(message: impl Into<String>) -> Self {
        Fail { message: message.into(), status: None }
    }
}

type Result<T> = std::result::Result<T, Fail>;

fn enoent(syscall: &str, path: &str) -> Fail {
    Fail::raw(format!("ENOENT: no such file or directory, {syscall} '{path}'"))
}

// ---- the path spellings, lexically, exactly as Node's path.posix resolves them ----------------

fn js_normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            _ => parts.push(segment),
        }
    }
    let joined = parts.join("/");
    match (absolute, joined.is_empty()) {
        (true, true) => "/".to_string(),
        (true, false) => format!("/{joined}"),
        (false, true) => ".".to_string(),
        (false, false) => joined,
    }
}

fn js_resolve(base: &str, relative: &str) -> String {
    if relative.is_empty() {
        js_normalize(base)
    } else if relative.starts_with('/') {
        js_normalize(relative)
    } else {
        js_normalize(&format!("{base}/{relative}"))
    }
}

fn js_relative(from: &str, to: &str) -> String {
    if from == to {
        return String::new();
    }
    let from_parts: Vec<&str> = from.split('/').filter(|part| !part.is_empty()).collect();
    let to_parts: Vec<&str> = to.split('/').filter(|part| !part.is_empty()).collect();
    let mut common = 0;
    while common < from_parts.len() && common < to_parts.len() && from_parts[common] == to_parts[common] {
        common += 1;
    }
    let ups = vec![".."; from_parts.len() - common];
    ups.into_iter().chain(to_parts[common..].iter().copied()).collect::<Vec<_>>().join("/")
}

fn js_dirname(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        None => ".".to_string(),
        Some(0) => "/".to_string(),
        Some(index) => trimmed[..index].to_string(),
    }
}

fn js_basename(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or("").to_string()
}

fn within(root: &str, file: &str) -> bool {
    let rel = js_relative(root, file);
    rel != ".." && !rel.starts_with("../") && !rel.starts_with('/')
}

fn realpath(path: &str) -> Result<String> {
    fs::canonicalize(path)
        .map(|resolved| resolved.to_string_lossy().into_owned())
        .map_err(|_| enoent("realpath", path))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The conversation id shape a recipe declares, injected (see the module note).
#[derive(Clone, Copy, PartialEq)]
pub enum IdShape {
    Uuid,
    KimiSession,
}

pub fn id_shape_ok(shape: IdShape, id: &str) -> bool {
    match shape {
        IdShape::Uuid => uuid_shape(id),
        IdShape::KimiSession => {
            let body = id.get(8..).filter(|_| id[..8].eq_ignore_ascii_case("session_")).unwrap_or(id);
            uuid_shape(body) || ulid_shape(body)
        }
    }
}

fn uuid_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn ulid_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 26
        && bytes.iter().all(|byte| {
            matches!(byte.to_ascii_uppercase(), b'0'..=b'9' | b'A'..=b'H' | b'J'..=b'K' | b'M'..=b'N' | b'P'..=b'T' | b'V'..=b'Z')
        })
}

// ---- the store --------------------------------------------------------------------------------

pub struct Store {
    pub directory: PathBuf,
    pub filename: PathBuf,
    pub state: Value,
    pub now: Box<dyn Fn() -> i64>,
    /// The id minter (randomUUID in JS).
    pub mint: Box<dyn Fn() -> String>,
    /// The transient temp-name source — the same randomUUID in JS, separate here so a replay
    /// can keep its id sequence aligned while temp names stay unique and unobserved.
    pub temp: Box<dyn Fn() -> String>,
}

fn default_state() -> Value {
    // The constructor's own key order — the on-disk order JSON.stringify writes.
    json!({ "version": 1, "roots": [], "drafts": {}, "layout": null, "preferences": {}, "conversations": {} })
}

impl Store {
    pub fn open(directory: &Path) -> Result<Self> {
        fs::create_dir_all(directory).map_err(|error| Fail::raw(error.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(directory, fs::Permissions::from_mode(0o700));
        }
        let filename = directory.join("workspace.json");
        let state = match fs::read_to_string(&filename) {
            Ok(text) => {
                let state: Value = serde_json::from_str(&text).map_err(|error| Fail::raw(error.to_string()))?;
                let damaged = state.get("version") != Some(&json!(1))
                    || !state.get("roots").is_some_and(Value::is_array)
                    || !state.get("drafts").is_some_and(Value::is_object);
                if damaged {
                    return Err(Fail::new("Unsupported or damaged workspace state. Preserve the file before repairing it.", 500));
                }
                state
            }
            Err(_) => default_state(),
        };
        Ok(Store {
            directory: directory.to_path_buf(),
            filename,
            state,
            now: Box::new(|| 0),
            mint: Box::new(|| "00000000-0000-4000-8000-000000000000".to_string()),
            temp: Box::new(|| "00000000-0000-4000-8000-000000000000".to_string()),
        })
    }

    pub fn persist(&self) -> Result<()> {
        let bytes = serde_json::to_string_pretty(&self.state).map_err(|error| Fail::raw(error.to_string()))?;
        let temp = format!("{}.{}.tmp", self.filename.display(), (self.temp)());
        {
            use std::os::unix::fs::PermissionsExt;
            fs::write(&temp, &bytes).map_err(|error| Fail::raw(error.to_string()))?;
            let _ = fs::set_permissions(&temp, fs::Permissions::from_mode(0o600));
        }
        let outcome = fs::rename(&temp, &self.filename);
        if outcome.is_err() {
            let _ = fs::remove_file(&temp);
        }
        outcome.map_err(|error| Fail::raw(error.to_string()))
    }

    pub fn add_root(&mut self, directory: &str, declaration_file: Option<&str>) -> Result<Value> {
        if !directory.starts_with('/') {
            return Err(Fail::new("Choose an absolute project directory.", 400));
        }
        let resolved = realpath(directory)?;
        let is_directory = fs::metadata(&resolved).map(|meta| meta.is_dir()).unwrap_or(false);
        if !is_directory {
            return Err(Fail::new("Project root must be a directory.", 400));
        }
        let declaration = match declaration_file {
            Some(file) => {
                if !file.starts_with('/') {
                    return Err(Fail::new("Choose an absolute declaration file.", 400));
                }
                let resolved_file = realpath(file)?;
                let is_file = fs::metadata(&resolved_file).map(|meta| meta.is_file()).unwrap_or(false);
                if !is_file {
                    return Err(Fail::new("Declaration must be a file.", 400));
                }
                Some(resolved_file)
            }
            None => None,
        };
        let roots = self.state.get_mut("roots").and_then(Value::as_array_mut).expect("state.roots");
        if let Some(existing) = roots.iter_mut().find(|root| root.get("path").and_then(Value::as_str) == Some(resolved.as_str())) {
            if let Some(file) = declaration {
                let current = existing.get("declarationFile").and_then(Value::as_str);
                if current != Some(file.as_str()) {
                    if let Some(bound) = current {
                        return Err(Fail::new(
                            format!("Project is already bound to declaration {bound}. Use that file or a separate workspace state."),
                            409,
                        ));
                    }
                    existing.as_object_mut().expect("a root is an object").insert("declarationFile".to_string(), json!(file));
                    let snapshot = existing.clone();
                    self.persist()?;
                    return Ok(snapshot);
                }
            }
            return Ok(existing.clone());
        }
        let mut root = Map::new();
        root.insert("id".to_string(), json!((self.mint)()));
        root.insert("path".to_string(), json!(resolved));
        root.insert("name".to_string(), json!(js_basename(&resolved)));
        if let Some(file) = declaration {
            root.insert("declarationFile".to_string(), json!(file));
        }
        let root = Value::Object(root);
        self.state.get_mut("roots").and_then(Value::as_array_mut).expect("state.roots").push(root.clone());
        self.persist()?;
        Ok(root)
    }

    pub fn root(&self, id: &str) -> Result<Value> {
        self.state
            .get("roots")
            .and_then(Value::as_array)
            .and_then(|roots| roots.iter().find(|root| root.get("id").and_then(Value::as_str) == Some(id)))
            .cloned()
            .ok_or_else(|| Fail::new("Unknown project root.", 404))
    }

    pub fn resolve(&self, root_id: &str, relative: &str, allow_missing: bool) -> Result<(String, String)> {
        let root = self.root(root_id)?;
        let root_path = root.get("path").and_then(Value::as_str).expect("a root has a path");
        resolve_in_root(root_path, relative, allow_missing)
    }

    pub fn list(&self, root_id: &str, relative: &str, hidden: bool) -> Result<Value> {
        let (absolute, rel) = self.resolve(root_id, relative, false)?;
        let mut entries: Vec<(String, bool, bool)> = Vec::new(); // (name, is_dir, is_symlink)
        let read = fs::read_dir(&absolute).map_err(|error| Fail::raw(error.to_string()))?;
        for entry in read {
            let entry = entry.map_err(|error| Fail::raw(error.to_string()))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !hidden && HIDDEN.contains(&name.as_str()) {
                continue;
            }
            let file_type = entry.file_type().map_err(|error| Fail::raw(error.to_string()))?;
            entries.push((name, file_type.is_dir(), file_type.is_symlink()));
        }
        // Directories first, then by name. localeCompare and codepoint order part ways over case
        // and punctuation classes the corpus does not use; recorded in the evidence for F170.
        entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let truncated = entries.len() > 2000;
        let shown: Vec<(String, bool, bool)> = entries.into_iter().take(2000).collect();
        let directories = shown.iter().filter(|(_, is_dir, _)| *is_dir).count();
        let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        if directories <= 100 {
            for (name, _, _) in shown.iter().filter(|(_, is_dir, _)| *is_dir) {
                let child = format!("{absolute}/{name}");
                if let Ok(children) = fs::read_dir(&child) {
                    let count = children
                        .filter_map(std::result::Result::ok)
                        .filter(|entry| hidden || !HIDDEN.contains(&entry.file_name().to_string_lossy().as_ref()))
                        .count();
                    counts.insert(name.clone(), count);
                }
            }
        }
        let mut out = Vec::new();
        for (name, is_dir, is_symlink) in shown {
            let mut entry = Map::new();
            entry.insert("name".to_string(), json!(name));
            entry.insert("path".to_string(), json!(if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") }));
            entry.insert("directory".to_string(), json!(is_dir));
            entry.insert("symlink".to_string(), json!(is_symlink));
            if let Some(count) = counts.get(&name) {
                entry.insert("children".to_string(), json!(count));
            }
            out.push(Value::Object(entry));
        }
        Ok(json!({ "path": rel, "truncated": truncated, "entries": out }))
    }

    pub fn read_text(&self, root_id: &str, relative: &str) -> Result<Value> {
        let (absolute, rel) = self.resolve(root_id, relative, false)?;
        let info = fs::metadata(&absolute).map_err(|_| enoent("stat", &absolute))?;
        if !info.is_file() || info.len() > MAX_TEXT_BYTES {
            return Err(Fail::new("Text editor supports files up to 2 MiB.", 400));
        }
        let bytes = fs::read(&absolute).map_err(|_| enoent("open", &absolute))?;
        if bytes.contains(&0) {
            return Err(Fail::new("Binary file cannot be opened as text.", 400));
        }
        let text = String::from_utf8(bytes.clone()).map_err(|_| Fail::new("File is not valid UTF-8 text.", 400))?;
        // TextDecoder consumes a leading BOM rather than emitting it; `bom` reports it separately.
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text).to_string();
        let crlf = text.contains("\r\n");
        let bare_cr = text.match_indices('\r').any(|(index, _)| text.as_bytes().get(index + 1) != Some(&b'\n'));
        if bare_cr || (crlf && text.replace("\r\n", "").contains('\n')) {
            return Err(Fail::new("Mixed or legacy line endings require an external editor.", 400));
        }
        let bom = bytes.starts_with(&[239, 187, 191]);
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            info.permissions().mode()
        };
        #[cfg(not(unix))]
        let mode = 0o100644u32;
        let mut out = Map::new();
        out.insert("rootId".to_string(), json!(root_id));
        out.insert("path".to_string(), json!(rel));
        out.insert("text".to_string(), json!(text));
        out.insert("version".to_string(), json!(sha256_hex(&bytes)));
        out.insert("eol".to_string(), json!(if crlf { "\r\n" } else { "\n" }));
        out.insert("bom".to_string(), json!(bom));
        out.insert("mode".to_string(), json!(mode));
        out.insert("draft".to_string(), self.get_draft(root_id, &rel));
        Ok(Value::Object(out))
    }

    fn draft_key(root_id: &str, file: &str) -> String {
        json!([root_id, file]).to_string()
    }

    pub fn get_draft(&self, root_id: &str, relative: &str) -> Value {
        self.state
            .get("drafts")
            .and_then(|drafts| drafts.get(Self::draft_key(root_id, relative)))
            .cloned()
            .unwrap_or(Value::Null)
    }

    pub fn put_draft(&mut self, draft: &Value) -> Result<Value> {
        let text = draft.get("text").and_then(Value::as_str).unwrap_or("");
        if !draft.get("text").is_some_and(Value::is_string) || text.len() > MAX_TEXT_BYTES as usize {
            return Err(Fail::new("Draft exceeds the 2 MiB text limit.", 400));
        }
        let base_version = draft.get("baseVersion").cloned().unwrap_or(Value::Null);
        if !base_version.is_null() && !base_version.is_string() {
            return Err(Fail::new("Draft requires its base file version.", 400));
        }
        let root_id = draft.get("rootId").and_then(Value::as_str).unwrap_or("").to_string();
        let path = draft.get("path").and_then(Value::as_str).unwrap_or("");
        let (_, rel) = self.resolve(&root_id, path, true)?;
        let mut record = Map::new();
        record.insert("rootId".to_string(), json!(root_id));
        record.insert("path".to_string(), json!(rel));
        record.insert("text".to_string(), json!(text));
        record.insert("baseVersion".to_string(), base_version);
        record.insert("updatedAt".to_string(), json!((self.now)()));
        let record = Value::Object(record);
        self.state
            .get_mut("drafts")
            .and_then(Value::as_object_mut)
            .expect("state.drafts")
            .insert(Self::draft_key(&root_id, &rel), record.clone());
        self.persist()?;
        Ok(record)
    }

    pub fn discard_draft(&mut self, root_id: &str, relative: &str) -> Result<()> {
        self.root(root_id)?;
        self.state
            .get_mut("drafts")
            .and_then(Value::as_object_mut)
            .expect("state.drafts")
            .remove(&Self::draft_key(root_id, relative));
        self.persist()
    }

    pub fn save_text(&mut self, draft: &Value) -> Result<Value> {
        let root_id = draft.get("rootId").and_then(Value::as_str).unwrap_or("");
        let relative = draft.get("path").and_then(Value::as_str).unwrap_or("");
        let text = draft.get("text").and_then(Value::as_str).unwrap_or("");
        if !draft.get("text").is_some_and(Value::is_string) || text.len() > MAX_TEXT_BYTES as usize {
            return Err(Fail::new("Text exceeds the 2 MiB limit.", 400));
        }
        let version = draft.get("version").cloned().unwrap_or(Value::Null);
        let (absolute, rel) = self.resolve(root_id, relative, true)?;
        let current = match self.read_text(root_id, &rel) {
            Ok(current) => Some(current),
            Err(error) if error.status.is_none() && error.message.starts_with("ENOENT") => None,
            Err(error) => return Err(error),
        };
        let current_version = current.as_ref().and_then(|current| current.get("version").cloned()).unwrap_or(Value::Null);
        if current_version != version {
            return Err(Fail::new("File changed on disk. Reload or resolve the conflict before saving.", 409));
        }
        let eol = current.as_ref().and_then(|current| current.get("eol")).and_then(Value::as_str).unwrap_or("\n");
        let normalized = if eol == "\n" { text.replace("\r\n", "\n") } else { text.replace("\r\n", "\n").replace('\n', eol) };
        let bom = current.as_ref().and_then(|current| current.get("bom")).and_then(Value::as_bool).unwrap_or(false);
        let bytes = format!("{}{}", if bom { "\u{feff}" } else { "" }, normalized);
        let temp = format!("{}/.rengine-save-{}", js_dirname(&absolute), (self.temp)());
        #[cfg(unix)]
        let mode = current
            .as_ref()
            .and_then(|current| current.get("mode"))
            .and_then(Value::as_u64)
            .map(|mode| mode as u32)
            .unwrap_or(0o644);
        #[cfg(not(unix))]
        let mode = 0o644u32;
        {
            use std::os::unix::fs::PermissionsExt;
            fs::write(&temp, &bytes).map_err(|error| Fail::raw(error.to_string()))?;
            let _ = fs::set_permissions(&temp, fs::Permissions::from_mode(mode & 0o777));
        }
        let latest = fs::read(&absolute).map(|bytes| sha256_hex(&bytes)).map_err(|_| enoent("open", &absolute));
        let latest = match latest {
            Ok(latest) => Some(latest),
            Err(error) if error.message.starts_with("ENOENT") => None,
            Err(error) => {
                let _ = fs::remove_file(&temp);
                return Err(error);
            }
        };
        if latest.as_deref() != version.as_str() {
            let _ = fs::remove_file(&temp);
            return Err(Fail::new("File changed on disk during Save. Your draft is preserved.", 409));
        }
        fs::rename(&temp, &absolute).map_err(|error| {
            let _ = fs::remove_file(&temp);
            Fail::raw(error.to_string())
        })?;
        self.discard_draft(root_id, &rel)?;
        self.read_text(root_id, &rel)
    }

    pub fn save_layout(&mut self, layout: &Value) -> Result<()> {
        if !layout.is_object() || serde_json::to_string(layout).map(|text| text.len()).unwrap_or(usize::MAX) > 1024 * 1024 {
            return Err(Fail::new("Invalid workspace layout.", 400));
        }
        *self.state.get_mut("layout").expect("state.layout") = layout.clone();
        self.persist()
    }

    pub fn list_conversations(&self, root_id: &str) -> Value {
        let all = self.state.get("conversations").cloned().unwrap_or_else(|| json!({}));
        if !all.is_object() {
            return json!([]);
        }
        all.get(root_id).and_then(Value::as_array).cloned().unwrap_or_else(Vec::new).into()
    }

    pub fn record_conversation(&mut self, root_id: &str, input: &Value, shape: IdShape) -> Result<Value> {
        let conversation = input.get("conversation").and_then(Value::as_str).unwrap_or("").to_string();
        let agent = input.get("agent").and_then(Value::as_str);
        let shaped = if agent.is_some() { id_shape_ok(shape, &conversation) } else { uuid_shape(&conversation) };
        if conversation.is_empty() || !shaped {
            return Err(Fail::new(
                "An agent conversation must be a UUID rEngine minted, or a session id in the shape the named CLI resumes by.",
                400,
            ));
        }
        if let Some(name) = agent {
            if name.len() > 256 {
                return Err(Fail::new("Invalid agent name for a conversation.", 400));
            }
        }
        let task = input.get("task").cloned();
        if let Some(task) = &task {
            if !task.is_null() && (!task.is_string() || task.as_str().is_some_and(|key| key.is_empty() || key.len() > 128)) {
                return Err(Fail::new("A conversation task is the key of one task row.", 400));
            }
        }
        self.root(root_id)?;
        if !self.state.get("conversations").is_some_and(Value::is_object) {
            *self.state.get_mut("conversations").expect("state.conversations") = json!({});
        }
        let conversations = self.state.get_mut("conversations").and_then(Value::as_object_mut).expect("state.conversations");
        let list = conversations.get(root_id).and_then(Value::as_array).cloned().unwrap_or_default();
        let now = (self.now)();
        let mut entry = match list.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(conversation.as_str())) {
            Some(found) => found.as_object().expect("an entry is an object").clone(),
            None => {
                let mut fresh = Map::new();
                fresh.insert("id".to_string(), json!(conversation));
                fresh.insert("startedAt".to_string(), json!(now));
                fresh
            }
        };
        entry.insert("lastSeenAt".to_string(), json!(now));
        if let Some(name) = agent {
            entry.insert("agent".to_string(), json!(name));
        }
        match &task {
            Some(Value::Null) => {
                entry.remove("task");
            }
            Some(value) => {
                entry.insert("task".to_string(), value.clone());
            }
            None => {}
        }
        let entry = Value::Object(entry);
        let mut next = vec![entry.clone()];
        next.extend(list.iter().filter(|item| item.get("id").and_then(Value::as_str) != entry.get("id").and_then(Value::as_str)).cloned());
        next.truncate(CONVERSATION_LIMIT);
        conversations.insert(root_id.to_string(), Value::Array(next));
        self.persist()?;
        Ok(entry)
    }

    pub fn preferences(&mut self, values: &Value) -> Result<Value> {
        let Some(patch) = values.as_object() else {
            return Err(Fail::new("Invalid preferences.", 400));
        };
        let get = |key: &str| patch.get(key);
        if let Some(agent) = get("agent") {
            if !agent.is_string() || agent.as_str().is_some_and(|value| value.len() > 256) {
                return Err(Fail::new("Invalid agent preference.", 400));
            }
        }
        if let Some(vim) = get("vim") {
            if !vim.is_boolean() {
                return Err(Fail::new("Invalid Vim preference.", 400));
            }
        }
        for key in ["theme", "syntax", "explorer"] {
            if let Some(value) = get(key) {
                let valid = value.as_str().is_some_and(|text| {
                    let bytes = text.as_bytes();
                    !bytes.is_empty() && bytes.len() <= 64 && bytes[0].is_ascii_lowercase()
                        && bytes.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
                });
                if !valid {
                    return Err(Fail::new(format!("Invalid {key} preference."), 400));
                }
            }
        }
        if let Some(hue) = get("accentHue") {
            let valid = hue.as_f64().is_some_and(|value| value.is_finite() && (0.0..360.0).contains(&value));
            if !valid {
                return Err(Fail::new("Invalid accent hue preference.", 400));
            }
        }
        if let Some(recording) = get("recording") {
            let Some(table) = recording.as_object() else {
                return Err(Fail::new("Invalid recording preference.", 400));
            };
            for (name, value) in table {
                let Some((_, low, high)) = RECORDING.iter().find(|(key, _, _)| key == name) else {
                    return Err(Fail::new(format!("Invalid recording preference key {name}."), 400));
                };
                let valid = value.as_i64().is_some_and(|number| number >= *low && number <= *high)
                    && !value.is_f64();
                if !valid {
                    return Err(Fail::new(
                        format!("Invalid recording preference {name}; expected an integer between {low} and {high}."),
                        400,
                    ));
                }
            }
        }
        if let Some(themes) = get("themes") {
            let Some(table) = themes.as_object() else {
                return Err(Fail::new("Invalid project theme preference.", 400));
            };
            if table.len() > 64 {
                return Err(Fail::new("Too many project themes.", 400));
            }
            for (root, name) in table {
                if root.len() > 64 || !name.is_string() || name.as_str().is_some_and(|value| value.len() > 64) {
                    return Err(Fail::new("Invalid project theme preference.", 400));
                }
            }
        }
        let mut preferences = self.state.get("preferences").and_then(Value::as_object).cloned().unwrap_or_default();
        for key in ["agent", "vim", "theme", "syntax", "explorer", "accentHue"] {
            if let Some(value) = get(key) {
                preferences.insert(key.to_string(), value.clone());
            }
        }
        for key in ["themes", "recording"] {
            if let Some(value) = get(key).and_then(Value::as_object) {
                let mut merged = preferences.get(key).and_then(Value::as_object).cloned().unwrap_or_default();
                for (name, entry) in value {
                    merged.insert(name.clone(), entry.clone());
                }
                preferences.insert(key.to_string(), Value::Object(merged));
            }
        }
        *self.state.get_mut("preferences").expect("state.preferences") = Value::Object(preferences);
        self.persist()?;
        Ok(self.state.get("preferences").cloned().expect("state.preferences"))
    }
}

pub fn resolve_in_root(root_path: &str, relative: &str, allow_missing: bool) -> Result<(String, String)> {
    if relative.contains('\0') || relative.starts_with('/') {
        return Err(Fail::new("Use a path relative to its project root.", 400));
    }
    let target = js_resolve(root_path, relative);
    if !within(root_path, &target) {
        return Err(Fail::new("File is outside the selected project root.", 403));
    }
    let resolved = match realpath(&target) {
        Ok(resolved) => resolved,
        Err(error) => {
            if !allow_missing {
                return Err(error);
            }
            let parent = realpath(&js_dirname(&target))?;
            format!("{parent}/{}", js_basename(&target))
        }
    };
    if !within(root_path, &resolved) {
        return Err(Fail::new("Symlink points outside the selected project root.", 403));
    }
    Ok((resolved.clone(), js_relative(root_path, &resolved)))
}
