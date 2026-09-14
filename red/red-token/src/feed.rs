//! One retained ring per project root, beside that root's ledger.
//!
//! Frames are lifecycle only: this file never sees a PTY byte, because the only producer that reads
//! the host's stream discards everything that is not a session transition (spec 095, decision 7).
//!
//! The ring is why F157 is a service rather than a client (spec 132): `frames` and `sequence` live
//! in memory and the whole ring is rewritten on every emit, so a second writer in another process
//! would not see the tail and would hand a monitor a sequence it had already read.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::Clock;

pub const FEED_LIMIT: usize = 1000;

/// The frame types this ring accepts. Spec 103 decision 9 put the task writes and the spawns here,
/// so the holder's monitor sees the task system move rather than only the processes it starts.
pub const TYPES: &[&str] = &[
    "token.claimed",
    "token.contested",
    "token.rejected",
    "token.released",
    "token.revoked",
    "game.started",
    "game.ended",
    "device-action.started",
    "device-action.ended",
    "capture.started",
    "capture.committed",
    "workspace.updated",
    "task.added",
    "task.updated",
    "agent.spawned",
];

pub fn known_type(name: &str) -> bool {
    TYPES.contains(&name)
}

/// One temporary per write, not one per process: two writes to the same file in flight in one
/// process shared a name, the first rename moved the bytes both had written into place and the
/// second failed `ENOENT`, throwing away that write and the answer with it. The pid stays the first
/// component because the retirement check reads it off these names to learn which processes wrote a
/// ledger directory (spec 095, Retirement).
static WRITES: Mutex<u32> = Mutex::new(0);

pub fn write_atomically(filename: &Path, value: &Value) -> std::io::Result<()> {
    let ordinal = {
        let mut writes = WRITES.lock().expect("write counter");
        *writes = (*writes + 1) % 0xff_ffff;
        base36(*writes)
    };
    let temporary = filename.with_file_name(format!(
        "{}.{}.{ordinal}.tmp",
        filename.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    let written = std::fs::write(&temporary, value.to_string()).and_then(|()| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(&temporary, filename)
    });
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written
}

/// `Number.prototype.toString(36)`.
fn base36(mut value: u32) -> String {
    if value == 0 {
        return "0".into();
    }
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while value > 0 {
        out.push(digits[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("ascii")
}

type Listener = Arc<dyn Fn(&Value) + Send + Sync>;

pub struct Feed {
    pub directory: PathBuf,
    pub root_id: String,
    pub limit: usize,
    pub file: PathBuf,
    pub frames: Vec<Value>,
    pub sequence: i64,
    now: Clock,
    listeners: Vec<(u64, Listener)>,
    next_listener: u64,
}

impl Feed {
    pub fn open(directory: &Path, root_id: &str, limit: usize, now: Clock) -> std::io::Result<Feed> {
        std::fs::create_dir_all(directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700));
        }
        let mut feed = Feed {
            directory: directory.to_path_buf(),
            root_id: root_id.to_string(),
            limit,
            file: directory.join("feed.json"),
            frames: Vec::new(),
            sequence: 0,
            now,
            listeners: Vec::new(),
            next_listener: 0,
        };
        feed.load();
        Ok(feed)
    }

    /// A ring that will not parse is an empty ring, not an error: the JavaScript returned from
    /// `load` on anything but a readable document of the right version, and a worker that refused
    /// to start over a damaged feed would be refusing to arbitrate over a log.
    fn load(&mut self) {
        let Ok(text) = std::fs::read_to_string(&self.file) else { return };
        let Ok(value) = serde_json::from_str::<Value>(&text) else { return };
        if value.get("version").and_then(Value::as_i64) != Some(1) {
            return;
        }
        let Some(frames) = value.get("frames").and_then(Value::as_array) else { return };
        let kept: Vec<Value> = frames
            .iter()
            .filter(|frame| {
                frame.get("type").and_then(Value::as_str).is_some_and(known_type) && frame.get("sequence").and_then(Value::as_i64).is_some()
            })
            .cloned()
            .collect();
        self.frames = kept.split_at(kept.len().saturating_sub(self.limit)).1.to_vec();
        self.sequence = self.frames.last().and_then(|frame| frame.get("sequence")).and_then(Value::as_i64).unwrap_or(0);
    }

    /// Sequence continues from the persisted tail, so a replaced worker never rewinds a monitor's
    /// cursor and never repeats a number a monitor has already seen.
    pub fn emit(&mut self, kind: &str, by: &Value, fields: &Value) -> Result<Value, String> {
        if !known_type(kind) {
            return Err(format!("Unknown feed frame type {kind}."));
        }
        self.sequence += 1;
        let mut frame = serde_json::Map::new();
        frame.insert("sequence".into(), json!(self.sequence));
        frame.insert("at".into(), json!(red_core::time::iso((self.now)())));
        frame.insert("rootId".into(), json!(self.root_id));
        frame.insert("type".into(), json!(kind));
        frame.insert("by".into(), by.clone());
        if let Some(extra) = fields.as_object() {
            for (name, value) in extra {
                frame.insert(name.clone(), value.clone());
            }
        }
        let frame = Value::Object(frame);
        self.frames.push(frame.clone());
        if self.frames.len() > self.limit {
            self.frames.drain(..self.frames.len() - self.limit);
        }
        self.persist();
        for (_, listener) in &self.listeners {
            listener(&frame);
        }
        Ok(frame)
    }

    /// A write that fails is swallowed, as the JavaScript's `.catch(() => {})` swallowed it: the
    /// ring is a log, and losing the disk copy of one frame must not fail the call that wrote it.
    pub fn persist(&self) {
        let document = json!({ "version": 1, "rootId": self.root_id, "frames": self.frames });
        let _ = write_atomically(&self.file, &document);
    }

    /// What a monitor resumes with. `retainedFrom` is the ring's own first frame rather than the
    /// first one answered, because that is the number that tells a monitor it missed something.
    pub fn after(&self, cursor: i64, limit: usize) -> Value {
        let frames: Vec<Value> = self
            .frames
            .iter()
            .filter(|frame| frame.get("sequence").and_then(Value::as_i64).unwrap_or(0) > cursor)
            .take(limit)
            .cloned()
            .collect();
        json!({
            "cursor": self.sequence,
            "retainedFrom": self.frames.first().and_then(|frame| frame.get("sequence")).and_then(Value::as_i64).unwrap_or(self.sequence),
            "frames": frames,
        })
    }

    pub fn subscribe(&mut self, listener: Listener) -> u64 {
        self.next_listener += 1;
        self.listeners.push((self.next_listener, listener));
        self.next_listener
    }

    pub fn unsubscribe(&mut self, id: u64) {
        self.listeners.retain(|(known, _)| *known != id);
    }

    /// The pids that wrote this directory, read off the temporaries left behind — the retirement
    /// check's question (spec 095), answered where the naming rule lives.
    pub fn writers(directory: &Path) -> BTreeSet<u32> {
        let mut pids = BTreeSet::new();
        let Ok(entries) = std::fs::read_dir(directory) else { return pids };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".tmp") {
                continue;
            }
            if let Some(pid) = name.split('.').nth(2).and_then(|part| part.parse::<u32>().ok()) {
                pids.insert(pid);
            }
        }
        pids
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clock(millis: i64) -> Clock {
        Arc::new(move || millis)
    }

    #[test]
    fn a_frame_type_outside_the_allowlist_is_refused() {
        let directory = std::env::temp_dir().join(format!("red-token-feed-{}", crate::uuid_v4()));
        let mut feed = Feed::open(&directory, "root", FEED_LIMIT, clock(1_789_387_200_000)).expect("a feed");
        assert!(feed.emit("pty.byte", &json!({}), &json!({})).is_err());
        assert!(feed.emit("token.claimed", &json!({ "kind": "agent" }), &json!({})).is_ok());
        let _ = std::fs::remove_dir_all(&directory);
    }

    /// The ring's first frame, not the answer's: a monitor learns it missed something from this.
    #[test]
    fn a_cursor_answers_from_the_rings_own_first_frame() {
        let directory = std::env::temp_dir().join(format!("red-token-feed-{}", crate::uuid_v4()));
        let mut feed = Feed::open(&directory, "root", 3, clock(1_789_387_200_000)).expect("a feed");
        for _ in 0..5 {
            feed.emit("task.added", &json!({ "kind": "agent" }), &json!({})).expect("a frame");
        }
        let answer = feed.after(4, 100);
        assert_eq!(answer["cursor"], json!(5));
        assert_eq!(answer["retainedFrom"], json!(3), "three frames are retained, so the ring starts at 3");
        assert_eq!(answer["frames"].as_array().expect("frames").len(), 1);
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn the_ring_survives_the_process_that_wrote_it() {
        let directory = std::env::temp_dir().join(format!("red-token-feed-{}", crate::uuid_v4()));
        {
            let mut feed = Feed::open(&directory, "root", FEED_LIMIT, clock(1_789_387_200_000)).expect("a feed");
            feed.emit("token.claimed", &json!({ "kind": "agent" }), &json!({ "holder": null })).expect("a frame");
        }
        let feed = Feed::open(&directory, "root", FEED_LIMIT, clock(1_789_387_200_000)).expect("a feed");
        assert_eq!(feed.sequence, 1, "a replaced worker continues the sequence rather than rewinding it");
        let _ = std::fs::remove_dir_all(&directory);
    }

    /* KI-065, ported with the naming rule it is about. The JavaScript named its temporary after the
       writing PROCESS, so two writes to one file in flight in one process shared it: the first
       rename moved the bytes both had written into place and the second failed `ENOENT ... rename`,
       throwing away that write and, through the callers that awaited it, the answer with it. */
    #[test]
    fn two_writes_to_one_file_at_once_both_land_and_the_file_is_one_of_them_whole() {
        let directory = std::env::temp_dir().join(format!("red-token-atomic-{}", crate::uuid_v4()));
        std::fs::create_dir_all(&directory).expect("a directory");
        let file = directory.join("preferences.json");
        let padding = "x".repeat(64 * 1024);
        let written: Vec<std::thread::JoinHandle<std::io::Result<()>>> = (0..8)
            .map(|ordinal| {
                let (file, padding) = (file.clone(), padding.clone());
                std::thread::spawn(move || super::write_atomically(&file, &json!({ "write": ordinal, "pad": padding })))
            })
            .collect();
        for handle in written {
            handle.join().expect("the writer finished").expect("no write is thrown away by another write of the same file");
        }
        let stored: Value = serde_json::from_str(&std::fs::read_to_string(&file).expect("the file")).expect("one whole value, not a mixture of two");
        assert_eq!(stored["pad"].as_str().map(str::len), Some(64 * 1024));
        let left: Vec<String> = std::fs::read_dir(&directory)
            .expect("the directory")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(left.is_empty(), "no temporary is left behind: {left:?}");
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn base36_counts_the_way_javascript_prints_it() {
        assert_eq!(super::base36(0), "0");
        assert_eq!(super::base36(35), "z");
        assert_eq!(super::base36(36), "10");
    }
}
