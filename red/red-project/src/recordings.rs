//! The committed-segment store the desktop's recorder writes (spec 081), read.
//!
//! Reading is a filesystem walk over one project root, which is why the workspace worker serves it
//! from its own checkout as readily as the host does — and why the implementation is here, where
//! both can ask it, instead of in a JavaScript module each of them imports.
//!
//! An incomplete recording is REPORTED rather than dropped: a commit that did not finish leaves a
//! directory with no manifest, and a listing that silently omitted it would tell a person their
//! recording never happened. Every count and dimension is the recorder's own — absent audio is
//! declared by the recorder, never inferred here (spec 081 decision 4).

use serde_json::{json, Map, Value};

pub const RECORDINGS: &str = ".cache/recordings";
pub const LIST_LIMIT: i64 = 200;
pub const LOG_CHARACTERS: i64 = 8000;
pub const LOG_MAX: i64 = 32000;
pub const PAGE: i64 = 200;
pub const PAGE_MAX: i64 = 1000;
const MAX_INDEX_BYTES: usize = 16 * 1024 * 1024;

/// A refusal carrying the status the JS route answered with.
#[derive(Debug, Clone)]
pub struct Fail {
    pub message: String,
    /// `None` where the JS answered `status: null`: a refusal from the store's own path resolution
    /// carries no route status, and inventing a 500 there would be this side making one up.
    pub status: Option<u16>,
}

impl Fail {
    fn new(message: impl Into<String>, status: u16) -> Fail {
        Fail { message: message.into(), status: Some(status) }
    }

    /// A refusal the store already worded, with whatever status it carried — including none.
    pub fn from_store(fail: red_store::store::Fail) -> Fail {
        Fail { message: fail.message, status: fail.status }
    }
}

type Result<T> = std::result::Result<T, Fail>;

fn is_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else { return false };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

fn checked(id: &str) -> Result<()> {
    if is_id(id) {
        Ok(())
    } else {
        Err(Fail::new("A recording id is one directory name minted by the recorder.", 400))
    }
}

/// `bounded` in the JS: a missing value takes the default, anything else is clamped, and something
/// that is not a number at all is refused by name rather than silently becoming one.
fn bounded(value: Option<&str>, fallback: i64, low: i64, high: i64) -> Result<i64> {
    let Some(text) = value.filter(|text| !text.is_empty()) else { return Ok(fallback) };
    let Ok(number) = text.parse::<f64>() else {
        return Err(Fail::new(format!("Expected a number, not {}.", json!(text)), 400));
    };
    if !number.is_finite() {
        return Err(Fail::new(format!("Expected a number, not {}.", json!(text)), 400));
    }
    Ok((number.trunc() as i64).clamp(low, high))
}

fn at(root: &str, relative: &str) -> std::path::PathBuf {
    let mut path = std::path::PathBuf::from(root);
    for part in RECORDINGS.split('/').chain(relative.split('/')).filter(|part| !part.is_empty()) {
        path.push(part);
    }
    path
}

fn present(root: &str, relative: &str) -> bool {
    std::fs::metadata(at(root, relative)).is_ok()
}

enum Read {
    Manifest(Value),
    Missing,
    Problem(String),
}

fn read_manifest(root: &str, id: &str) -> Read {
    let text = match std::fs::read_to_string(at(root, &format!("{id}/manifest.json"))) {
        Ok(text) => text,
        Err(_) => {
            /* No manifest is two different things, and the difference is what a reader is told: a
               recording that is not here at all, or one whose commit did not complete. */
            if !present(root, id) {
                return Read::Missing;
            }
            return Read::Problem(format!("Recording {id} has no manifest.json; the commit did not complete."));
        }
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Read::Problem(format!("Recording {id} has a manifest.json that is not valid JSON."));
    };
    if !value.is_object() {
        return Read::Problem(format!("Recording {id} has a manifest.json that is not an object."));
    }
    match value.get("version").and_then(Value::as_i64) {
        Some(1) => Read::Manifest(value),
        other => Read::Problem(format!(
            "Recording {id} has manifest version {}; this workspace reads version 1.",
            other.map(|value| value.to_string()).unwrap_or_else(|| {
                value.get("version").cloned().unwrap_or(Value::Null).to_string()
            })
        )),
    }
}

fn number(manifest: &Value, path: &[&str], fallback: i64) -> Value {
    let mut node = manifest;
    for key in path {
        match node.get(key) {
            Some(next) => node = next,
            None => return json!(fallback),
        }
    }
    if node.is_number() { node.clone() } else { json!(fallback) }
}

fn text(manifest: &Value, key: &str, fallback: &str) -> Value {
    match manifest.get(key) {
        Some(value) if value.is_string() => value.clone(),
        _ => json!(fallback),
    }
}

fn named(manifest: &Value, block: &str, key: &str, fallback: &str) -> String {
    manifest
        .get(block)
        .and_then(|node| node.get(key))
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

/// One listing entry: what the manifest says, plus whether the files it names are actually there.
fn entry_of(root: &str, id: &str, manifest: &Value) -> Value {
    let base = format!("{RECORDINGS}/{id}");
    let index = named(manifest, "video", "index", "keyframes.jsonl");
    let file = named(manifest, "log", "file", "log.jsonl");
    let frames = present(root, &format!("{id}/keyframes"));
    let listed = present(root, &format!("{id}/{index}"));
    let log = present(root, &format!("{id}/{file}"));
    json!({
        "id": id,
        "kind": text(manifest, "kind", "ring"),
        "game": text(manifest, "game", ""),
        "sessionId": text(manifest, "sessionId", ""),
        "title": text(manifest, "title", ""),
        "startedAt": text(manifest, "startedAt", ""),
        "endedAt": text(manifest, "endedAt", ""),
        "durationMs": number(manifest, &["durationMs"], 0),
        "bytes": number(manifest, &["bytes"], 0),
        "path": base,
        "artifacts": {
            "keyframes": {
                "count": number(manifest, &["video", "frames"], 0),
                "fps": number(manifest, &["video", "fps"], 0),
                "width": number(manifest, &["video", "width"], 0),
                "height": number(manifest, &["video", "height"], 0),
                "present": frames && listed,
                "directory": format!("{base}/keyframes"),
                "index": format!("{base}/{index}"),
            },
            "log": { "lines": number(manifest, &["log", "lines"], 0), "present": log, "file": format!("{base}/{file}") },
            /* Absent audio is declared by the recorder, never inferred here: a reader is told what
               is missing and which tool provides it (spec 081 decision 4). */
            "audio": manifest.get("audio").cloned().unwrap_or_else(|| json!({
                "present": false, "reason": "This manifest predates the audio slot."
            })),
        },
    })
}

fn jsonl(root: &str, id: &str, file: &str) -> Result<Vec<Value>> {
    let text = match std::fs::read_to_string(at(root, &format!("{id}/{file}"))) {
        Ok(text) => text,
        Err(_) => return Ok(Vec::new()),
    };
    /* The JavaScript compared `text.length`, which is UTF-16 code units. */
    if red_core::text::utf16_len(&text) > MAX_INDEX_BYTES {
        return Err(Fail::new(
            format!("Recording {id} has a {file} above the {MAX_INDEX_BYTES}-byte read limit."),
            413,
        ));
    }
    Ok(text.lines().filter(|line| !line.is_empty()).filter_map(|line| serde_json::from_str(line).ok()).collect())
}

/// `listRecordings`: newest first, because the id is a sortable UTC stamp.
pub fn list(root_id: &str, root: &str, limit: Option<&str>) -> Result<Value> {
    let limit = bounded(limit, LIST_LIMIT, 1, LIST_LIMIT)?;
    let mut names: Vec<String> = match std::fs::read_dir(at(root, "")) {
        Ok(entries) => entries
            .flatten()
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| is_id(name))
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    names.reverse();
    let shown: Vec<String> = names.iter().take(limit as usize).cloned().collect();
    let recordings: Vec<Value> = shown
        .iter()
        .map(|id| match read_manifest(root, id) {
            Read::Manifest(manifest) => entry_of(root, id, &manifest),
            /* Reported, not dropped: a directory the recorder left behind is still something the
               person made, and a listing that omitted it would say their recording never happened. */
            Read::Problem(problem) => json!({ "id": id, "path": format!("{RECORDINGS}/{id}"), "error": problem }),
            Read::Missing => json!({
                "id": id, "path": format!("{RECORDINGS}/{id}"),
                "error": format!("Recording {id} is no longer in this project."),
            }),
        })
        .collect();
    Ok(json!({
        "rootId": root_id,
        "path": RECORDINGS,
        "truncated": names.len() > shown.len(),
        "recordings": recordings,
    }))
}

/// `readRecording`: the manifest, a bounded log tail and a paged keyframe index of root-relative
/// paths — each artifact only if it was asked for.
pub fn read(
    root_id: &str,
    root: &str,
    id: &str,
    artifact: Option<&str>,
    offset: Option<&str>,
    limit: Option<&str>,
    max_characters: Option<&str>,
) -> Result<Value> {
    checked(id)?;
    let manifest = match read_manifest(root, id) {
        Read::Manifest(manifest) => manifest,
        Read::Missing => return Err(Fail::new(format!("Unknown recording {id} in this project."), 404)),
        Read::Problem(problem) => return Err(Fail::new(problem, 409)),
    };
    let base = format!("{RECORDINGS}/{id}");
    let artifact = artifact.filter(|value| !value.is_empty()).unwrap_or("all");
    if !["all", "manifest", "log", "keyframes"].contains(&artifact) {
        return Err(Fail::new("artifact must be all, manifest, log or keyframes.", 400));
    }
    let mut result = Map::new();
    result.insert("rootId".to_string(), json!(root_id));
    result.insert("id".to_string(), json!(id));
    result.insert("path".to_string(), json!(base));
    result.insert("manifest".to_string(), manifest.clone());
    result.insert("artifacts".to_string(), entry_of(root, id, &manifest)["artifacts"].clone());
    if artifact == "all" || artifact == "keyframes" {
        let offset = bounded(offset, 0, 0, 1_000_000)? as usize;
        let limit = bounded(limit, PAGE, 1, PAGE_MAX)? as usize;
        let entries = jsonl(root, id, &named(&manifest, "video", "index", "keyframes.jsonl"))?;
        let page: Vec<&Value> = entries.iter().skip(offset).take(limit).collect();
        result.insert(
            "keyframes".to_string(),
            json!(page
                .iter()
                .map(|entry| json!({
                    "path": format!("{base}/{}", entry.get("file").and_then(Value::as_str).unwrap_or_default()),
                    "atMs": entry.get("atMs").cloned().unwrap_or(Value::Null),
                    "wall": entry.get("wall").cloned().unwrap_or(Value::Null),
                    "sequence": entry.get("sequence").cloned().unwrap_or(Value::Null),
                    "bytes": entry.get("bytes").cloned().unwrap_or(Value::Null),
                }))
                .collect::<Vec<Value>>()),
        );
        result.insert("totalKeyframes".to_string(), json!(entries.len()));
        if offset + page.len() < entries.len() {
            result.insert("nextOffset".to_string(), json!(offset + page.len()));
        }
    }
    if artifact == "all" || artifact == "log" {
        let budget = bounded(max_characters, LOG_CHARACTERS, 1, LOG_MAX)? as usize;
        let entries = jsonl(root, id, &named(&manifest, "log", "file", "log.jsonl"))?;
        /* Backwards from the end: a log tail is the last thing that happened, and the budget is
           spent on the newest lines. One line over the budget is still kept when it is the only
           one, because an empty answer would say the recording logged nothing. */
        let mut kept: Vec<Value> = Vec::new();
        let mut used = 0usize;
        for entry in entries.iter().rev() {
            used += entry.get("text").and_then(Value::as_str).map(red_core::text::utf16_len).unwrap_or(0) + 1;
            if used > budget && !kept.is_empty() {
                break;
            }
            kept.insert(0, entry.clone());
            if used > budget {
                break;
            }
        }
        result.insert(
            "log".to_string(),
            json!({ "lines": kept, "truncated": kept.len() < entries.len(), "total": entries.len() }),
        );
    }
    Ok(Value::Object(result))
}
