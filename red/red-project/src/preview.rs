//! Running a command a project declared over one of its files, and handing back raw bytes
//! (F156, spec 117 and the format registry).
//!
//! These are the two things a viewer needs that the declaration alone cannot answer: what a
//! project's own producer says about one of its files, and the bytes themselves. A preview that
//! will not run is what a person sees INSTEAD of their file, so each refusal is the whole
//! explanation and is compared word for word against what the JavaScript said.
//!
//! Output is not trusted. A text preview must be UTF-8 without NUL; a tree must be one JSON object
//! of the shape the viewer draws, checked node by node with its own bounds, because a `size` that
//! is not a whole non-negative number is not a file and a tree deep enough to recurse on is not a
//! preview.

use std::path::Path;

use serde_json::{json, Value};

use crate::command;
use crate::recordings::Fail;
use crate::rules::object;

pub const MAX_RAW_WINDOW: u64 = 64 * 1024;
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
const MAX_TREE_DEPTH: usize = 64;
const MAX_TREE_NODES: usize = 200_000;
const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_MAX_BYTES: usize = 4 * 1024 * 1024;

fn refuse(message: impl Into<String>, status: u16) -> Fail {
    Fail { message: message.into(), status: Some(status) }
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// The same glob rule the rest of the declaration uses, on the file's own name.
pub fn match_format<'a>(formats: &'a [Value], name: &str) -> Option<&'a Value> {
    let base = name.rsplit('/').next().unwrap_or(name);
    formats.iter().find(|format| {
        format
            .get("match")
            .and_then(Value::as_array)
            .map(|globs| globs.iter().filter_map(Value::as_str).any(|glob| matches_name(glob, base)))
            .unwrap_or(false)
    })
}

/// A file-name glob: `*`, `?` and character classes are the declaration's, and a name has no
/// directory left in it by the time it reaches here.
fn matches_name(pattern: &str, name: &str) -> bool {
    glob(&pattern.to_ascii_lowercase(), &name.to_ascii_lowercase())
}

fn glob(pattern: &str, value: &str) -> bool {
    let mut characters = pattern.chars();
    match characters.next() {
        None => value.is_empty(),
        Some('*') => {
            let after = characters.as_str();
            value
                .char_indices()
                .map(|(index, _)| index)
                .chain(std::iter::once(value.len()))
                .any(|index| glob(after, &value[index..]))
        }
        Some('?') => {
            let mut rest = value.chars();
            rest.next().is_some() && glob(characters.as_str(), rest.as_str())
        }
        Some('[') => {
            let Some(end) = characters.as_str().find(']') else { return false };
            let set = &characters.as_str()[..end];
            let after = &characters.as_str()[end + 1..];
            let (negated, set) = match set.strip_prefix('!') {
                Some(rest) => (true, rest),
                None => (false, set),
            };
            let mut rest = value.chars();
            match rest.next() {
                Some(character) => set.contains(character) != negated && glob(after, rest.as_str()),
                None => false,
            }
        }
        Some(literal) => {
            let mut rest = value.chars();
            rest.next() == Some(literal) && glob(characters.as_str(), rest.as_str())
        }
    }
}

fn decode(bytes: &[u8]) -> Option<String> {
    if bytes.len() > MAX_TEXT_BYTES || bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes.to_vec()).ok()
}

/// `Math.min(offset, len)`-style window over what a command produced.
fn window_of(bytes: &[u8], offset: u64, length: u64) -> Result<Value, Fail> {
    let start = offset.min(bytes.len() as u64) as usize;
    let take = length.min(MAX_RAW_WINDOW).min((bytes.len() - start) as u64) as usize;
    let slice = &bytes[start..start + take];
    Ok(object(vec![
        ("offset", json!(offset)),
        ("length", json!(slice.len())),
        ("hex", json!(hex(slice))),
    ]))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A node the viewer will draw, or the one refusal a bad tree gets however it is bad.
fn sanitize(node: &Value, depth: usize, nodes: &mut usize) -> Result<Value, Fail> {
    let bad = || refuse("Preview output is not one JSON tree object.", 502);
    let Some(object_node) = node.as_object() else { return Err(bad()) };
    let (Some(dirs), Some(files)) = (object_node.get("dirs").and_then(Value::as_array), object_node.get("files").and_then(Value::as_array)) else {
        return Err(bad());
    };
    if depth > MAX_TREE_DEPTH {
        return Err(bad());
    }
    *nodes += 1 + files.len();
    if *nodes > MAX_TREE_NODES {
        return Err(refuse("Preview tree exceeds 200,000 nodes.", 413));
    }
    let mut children = Vec::new();
    for child in dirs {
        children.push(sanitize(child, depth + 1, nodes)?);
    }
    let mut kept = Vec::new();
    for file in files {
        let size = file.get("size").and_then(Value::as_i64);
        let (name, at) = (file.get("name").and_then(Value::as_str), file.get("path").and_then(Value::as_str));
        match (name, at, size) {
            (Some(name), Some(at), Some(size)) if size >= 0 => {
                kept.push(object(vec![("name", json!(name)), ("path", json!(at)), ("size", json!(size))]))
            }
            _ => return Err(bad()),
        }
    }
    Ok(object(vec![
        ("name", json!(object_node.get("name").and_then(Value::as_str).unwrap_or(""))),
        ("dirs", json!(children)),
        ("files", json!(kept)),
    ]))
}

fn run_declared(root_path: &str, spec: &Value, file: Option<&str>, entry: Option<&str>, environment: &[(String, String)]) -> Result<command::Run, Fail> {
    let argv: Vec<String> = spec
        .get("command")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    let mut argument = item.as_str().unwrap_or_default().to_string();
                    /* `${file}` is the ABSOLUTE path, re-confined immediately before the spawn:
                       a producer is handed the file, not a path it would have to resolve itself
                       against a working directory it does not control. */
                    if let Some(file) = file {
                        argument = argument.replace("${file}", file);
                    }
                    if let Some(entry) = entry {
                        argument = argument.replace("${entry}", entry);
                    }
                    argument
                })
                .collect()
        })
        .unwrap_or_default();
    let timeout = spec.get("timeoutMs").and_then(Value::as_u64).unwrap_or(DEFAULT_TIMEOUT_MS);
    let bytes = spec.get("maxBytes").and_then(Value::as_u64).unwrap_or(DEFAULT_MAX_BYTES as u64) as usize;
    command::run(Path::new(root_path), &argv, environment, timeout, bytes).map_err(|failed| refuse(failed.message, failed.status))
}

/// What a project's own producer says about one of its files.
pub fn format_preview(root_path: &str, declared: &Value, data: &Value, environment: &[(String, String)]) -> Result<Value, Fail> {
    if declared.get("declared").and_then(Value::as_bool) != Some(true) {
        return Err(refuse("This project does not declare formats in .rengine/project.json.", 415));
    }
    if let Some(said) = declared.get("error").and_then(Value::as_str) {
        return Err(refuse(said, 415));
    }
    let asked = text(data, "path");
    let (absolute, relative) = red_store::store::resolve_in_root(root_path, asked, false).map_err(Fail::from_store)?;
    if !std::fs::metadata(&absolute).map(|meta| meta.is_file()).unwrap_or(false) {
        return Err(refuse("Previews require a regular file.", 415));
    }
    let formats: Vec<Value> = declared.get("formats").and_then(Value::as_array).cloned().unwrap_or_default();
    let format = match data.get("formatId").and_then(Value::as_str) {
        Some(wanted) => formats.iter().find(|format| text(format, "id") == wanted).ok_or_else(|| refuse("Unknown formatId for this project.", 404))?,
        None => match_format(&formats, &relative).ok_or_else(|| {
            refuse(format!("No registered format matches {}.", relative.rsplit('/').next().unwrap_or(&relative)), 415)
        })?,
    };
    let base = vec![
        ("format", json!(text(format, "id"))),
        ("title", json!(text(format, "title"))),
        ("path", json!(relative)),
    ];
    if let Some(entry) = data.get("entry") {
        let named = entry.as_str().filter(|named| !named.is_empty() && named.chars().count() <= 4096 && !named.contains('\0'));
        let Some(named) = named else { return Err(refuse("Entry must be a bounded string.", 400)) };
        let Some(spec) = format.get("entry").filter(|spec| spec.is_object()) else {
            return Err(refuse(format!("Format {} declares no entry command.", text(format, "id")), 415));
        };
        let run = run_declared(root_path, spec, Some(&absolute), Some(named), environment)?;
        let decoded = decode(&run.stdout);
        let mut fields = vec![("kind", json!("entry"))];
        fields.extend(base);
        fields.push(("entry", json!(named)));
        fields.push(("command", json!(run.argv)));
        fields.push(("durationMs", json!(run.duration_ms as u64)));
        fields.push(("size", json!(run.stdout.len())));
        fields.push(("sha256", json!(red_store::store::sha256_hex(&run.stdout))));
        if let Some(decoded) = decoded {
            fields.push(("text", json!(decoded)));
        }
        let (offset, length) = window_bounds(data)?;
        fields.push(("window", window_of(&run.stdout, offset, length)?));
        return Ok(object(fields));
    }
    let Some(spec) = format.get("preview").filter(|spec| spec.is_object()) else {
        return Err(refuse(format!("Format {} declares no preview command.", text(format, "id")), 415));
    };
    let run = run_declared(root_path, spec, Some(&absolute), None, environment)?;
    let kind = text(spec, "kind").to_string();
    let mut fields = vec![("kind", json!(kind))];
    fields.extend(base);
    fields.push(("command", json!(run.argv)));
    fields.push(("durationMs", json!(run.duration_ms as u64)));
    fields.push(("bytes", json!(run.stdout.len())));
    if text(spec, "kind") == "text" {
        if run.stdout.len() > MAX_TEXT_BYTES {
            return Err(refuse("Preview text exceeds 2 MiB.", 413));
        }
        let Some(decoded) = decode(&run.stdout) else {
            return Err(refuse("Preview output is not UTF-8 text without NUL.", 502));
        };
        fields.push(("text", json!(decoded)));
        return Ok(object(fields));
    }
    let parsed: Value =
        serde_json::from_slice(&run.stdout).map_err(|_| refuse("Preview output is not one JSON tree object.", 502))?;
    let mut nodes = 0;
    fields.push(("tree", sanitize(&parsed, 0, &mut nodes)?));
    Ok(object(fields))
}

/// `Number(value)` then `Number.isSafeInteger(value) && value >= 0`.
///
/// A route hands this whatever it received: `/api/bytes` is a query string, so an offset and a
/// length arrive as TEXT — `Number('')` is 0 and `Number('1e1')` is 10 — while
/// `/api/format-preview` is a JSON body and they arrive as numbers. What a route cannot deliver — a
/// boolean, an array — refuses here rather than following `Number()` into coercions this project
/// does not rely on, and so does a hexadecimal spelling. The record is
/// `orchestrator/tests/preview-corpus.mjs`.
fn as_window(value: &Value) -> Option<u64> {
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    let number = match value {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse::<f64>().ok()?
            }
        }
        _ => return None,
    };
    ((0.0..=MAX_SAFE_INTEGER).contains(&number) && number.fract() == 0.0).then_some(number as u64)
}

/// The offset and the length a window is asked for, refused in the one sentence the JS raised.
/// An ENTRY's window is bounded by the same rule the raw window is: defaulting a bad one to zero
/// would show a person the wrong bytes in place of the reason.
fn window_bounds(data: &Value) -> Result<(u64, u64), Fail> {
    let bad = || refuse("Byte window needs non-negative integer offset and length.", 400);
    let offset = match data.get("offset") {
        None | Some(Value::Null) => 0,
        Some(value) => as_window(value).ok_or_else(bad)?,
    };
    let length = match data.get("length") {
        None | Some(Value::Null) => MAX_RAW_WINDOW,
        Some(value) => as_window(value).ok_or_else(bad)?,
    };
    Ok((offset, length))
}

/// Whether the handle that was opened and the name that was re-resolved are the same file.
/// See sidecar: raw-read-confinement.
#[cfg(unix)]
fn same_file(opened: &std::fs::Metadata, current: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    opened.dev() == current.dev() && opened.ino() == current.ino()
}

#[cfg(not(unix))]
fn same_file(opened: &std::fs::Metadata, current: &std::fs::Metadata) -> bool {
    /* No stable identity for an open handle here; what both stats agree on is the next best thing. */
    opened.len() == current.len() && opened.modified().ok() == current.modified().ok()
}

/// A window of a file's own bytes, confined the way every declared path is.
pub fn read_bytes(root_id: &str, root_path: &str, data: &Value) -> Result<Value, Fail> {
    let (offset, length) = window_bounds(data)?;
    let asked = text(data, "path");
    let (absolute, relative) = red_store::store::resolve_in_root(root_path, asked, false).map_err(Fail::from_store)?;
    /* OPEN first, then describe the handle — not the name. See sidecar: raw-read-confinement. */
    let mut file = std::fs::File::open(&absolute).map_err(|error| refuse(format!("{error}"), 500))?;
    let info = file.metadata().map_err(|error| refuse(format!("{error}"), 500))?;
    if !info.is_file() {
        return Err(refuse("Raw view requires a regular file.", 415));
    }
    let (current_path, _) = red_store::store::resolve_in_root(root_path, asked, false).map_err(Fail::from_store)?;
    let current = std::fs::metadata(&current_path).map_err(|error| refuse(format!("{error}"), 500))?;
    if !same_file(&info, &current) {
        return Err(refuse("File changed during the read. Refresh to retry.", 409));
    }
    let size = info.len();
    let take = length.min(MAX_RAW_WINDOW).min(size.saturating_sub(offset.min(size)));
    let mut buffer = vec![0u8; take as usize];
    if take > 0 {
        use std::io::{Read, Seek, SeekFrom};
        file.seek(SeekFrom::Start(offset)).map_err(|error| refuse(format!("{error}"), 500))?;
        let mut read = 0;
        while read < buffer.len() {
            match file.read(&mut buffer[read..]) {
                Ok(0) | Err(_) => break,
                Ok(got) => read += got,
            }
        }
        buffer.truncate(read);
    }
    Ok(object(vec![
        ("rootId", json!(root_id)),
        ("path", json!(relative)),
        ("size", json!(size)),
        ("modified", json!(modified_ms(&info))),
        ("offset", json!(offset)),
        ("length", json!(buffer.len())),
        ("hex", json!(hex(&buffer))),
    ]))
}

/// `stat.mtimeMs` — milliseconds since the epoch, as JavaScript reports it.
fn modified_ms(info: &std::fs::Metadata) -> f64 {
    info.modified()
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn a_file_name_is_matched_by_the_globs_a_format_declares() {
        let formats = vec![
            json!({ "id": "packs", "match": ["*.pack", "*.PAK"] }),
            json!({ "id": "notes", "match": ["note?.txt"] }),
        ];
        assert_eq!(super::match_format(&formats, "deep/sample.pack").map(|f| f["id"].as_str().unwrap()), Some("packs"));
        /* Case-insensitively, and on the NAME: a directory called `pack` is not a match. */
        assert_eq!(super::match_format(&formats, "SAMPLE.PACK").map(|f| f["id"].as_str().unwrap()), Some("packs"));
        assert_eq!(super::match_format(&formats, "note1.txt").map(|f| f["id"].as_str().unwrap()), Some("notes"));
        assert!(super::match_format(&formats, "note12.txt").is_none());
        assert!(super::match_format(&formats, "readme.md").is_none());
        /* The glob is matched against the file's own name: a DIRECTORY that ends in a declared
           extension is not a file of that format. */
        assert!(super::match_format(&formats, "dir.pack/readme.md").is_none());
    }

    /// A `size` that is not a whole non-negative number is not a file, however deep it is.
    #[test]
    fn the_name_is_confined_to_the_handle_that_was_opened() {
        /* The race itself cannot be staged from outside the call, so the PREDICATE the 409 rests on
           is what is tested: two files behind one name are not one file. See sidecar:
           raw-read-confinement. */
        let directory = std::env::temp_dir().join(format!("red-project-same-file-{}", crate::uuid_like()));
        std::fs::create_dir_all(&directory).expect("a directory");
        std::fs::write(directory.join("a"), b"one").expect("a");
        std::fs::write(directory.join("b"), b"one").expect("b");
        let a = std::fs::metadata(directory.join("a")).expect("stat a");
        let again = std::fs::metadata(directory.join("a")).expect("stat a again");
        let b = std::fs::metadata(directory.join("b")).expect("stat b");
        assert!(super::same_file(&a, &again), "one file resolved twice is the same file");
        assert!(!super::same_file(&a, &b), "two files of equal size and content are not one file");
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn a_tree_node_the_viewer_cannot_draw_is_refused() {
        let mut nodes = 0;
        assert!(super::sanitize(&json!({ "name": "r", "dirs": [], "files": [{ "name": "a", "path": "a", "size": -1 }] }), 0, &mut nodes).is_err());
        let mut nodes = 0;
        assert!(super::sanitize(&json!({ "name": "r", "dirs": [], "files": [] }), 0, &mut nodes).is_ok());
        let mut nodes = 0;
        assert!(super::sanitize(&json!([]), 0, &mut nodes).is_err(), "an array is not a node");
    }
}
