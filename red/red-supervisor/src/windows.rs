//! The project-window store, and the durable transport two agents exchange findings over
//! (F159, spec 144; spec 077).
//!
//! Six of the supervisor's thirteen routes are this module, and it is the half of the supervisor
//! with no process in it: a window is a row, a layout is a document the desktop hands back, and a
//! report is a letter addressed by which SIDE of a window sent it.
//!
//! **A window has two roots and a report always goes to the other one.** That is the whole
//! addressing rule, and every refusal here is a consequence of it: a root on neither side cannot
//! read the window, the originating agent may speak *as* the project it opened (and is then
//! answered in its own inbox, because the sender was the project side), and the project side may
//! never speak as the origin. Getting this backwards would deliver one team's findings to the other
//! team, which is why the direction is recorded rather than described.
//!
//! **A retry key is a promise, not a name.** The same key with the same content is the same report
//! — so a client that timed out and asked again gets one letter, not two — and the same key with
//! *different* content is refused rather than allowed to overwrite what the recipient may already
//! have read.
//!
//! Every answer here is judged against `tests/window-store-corpus.json`, which is what
//! `runtime/windows.mjs` said on the day this replaced it (F173).

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// Why an ask was refused, and the status the route answers with. Both are the JavaScript's, and
/// there is one of these for the whole crate.
pub use crate::Refused;

fn refuse<T>(message: &str, status: u16) -> Result<T, Refused> {
    Err(Refused { message: message.to_string(), status })
}

/// `String.prototype.length`, which counts UTF-16 code units rather than bytes.
///
/// Every bound here was written against that number, and a port that counted bytes would refuse a
/// summary of 1,100 accented characters that the JavaScript accepted — the same text, a different
/// answer, and no way for the person who wrote it to tell why.
fn units(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The size of a value as `JSON.stringify(value).length` measures it.
fn json_units(value: &Value) -> usize {
    units(&value.to_string())
}

/// JavaScript truthiness, for the one field that is read that way: `input.fromProject` guards the
/// permission check loosely and picks the sender strictly, and the two are not the same question.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(held)) => *held,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().is_some_and(|value| value != 0.0),
        Some(_) => true,
    }
}

fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

/// One state directory's windows and the reports sent across them.
pub struct Windows {
    filename: PathBuf,
    state: Value,
}

/// The store is 32MB of JSON at most. It is a durable transport rather than a log, so it fills
/// rather than rotating, and it says so by name instead of growing until something else notices.
const LIMIT: usize = 32 * 1024 * 1024;

impl Windows {
    /// Read the store, or start an empty one. A file that is not this shape is refused rather than
    /// migrated: it belongs to a version of this that knew something this one does not.
    pub fn open(directory: &Path) -> Result<Self, Refused> {
        let filename = directory.join("project-windows.json");
        let state = match std::fs::read_to_string(&filename) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(value) => value,
                Err(error) => return refuse(&format!("Unreadable project window store: {error}"), 500),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                json!({ "version": 1, "windows": [], "reports": [] })
            }
            Err(error) => return refuse(&format!("Unreadable project window store: {error}"), 500),
        };
        if state.get("version") != Some(&json!(1))
            || !state.get("windows").is_some_and(Value::is_array)
            || !state.get("reports").is_some_and(Value::is_array)
        {
            return refuse("Unsupported project window store.", 400);
        }
        Ok(Self { filename, state })
    }

    fn windows(&self) -> &Vec<Value> {
        self.state["windows"].as_array().expect("checked on open")
    }

    fn reports(&self) -> &Vec<Value> {
        self.state["reports"].as_array().expect("checked on open")
    }

    /// Apply a change to a COPY, and keep it only once it is on disk.
    ///
    /// The order is the point: a refusal leaves the store exactly as it was, and a store that could
    /// not be written is not a store that changed. Written to a neighbouring file and renamed, so a
    /// reader never sees half of one.
    fn write<T>(&mut self, action: impl FnOnce(&mut Value) -> Result<T, Refused>) -> Result<T, Refused> {
        let mut next = self.state.clone();
        let value = action(&mut next)?;
        let bytes = next.to_string();
        if bytes.len() > LIMIT {
            return refuse("Project window store is full; archive it before adding more data.", 409);
        }
        let temporary = self.filename.with_extension("json.tmp");
        if let Err(error) = write_private(&temporary, &bytes) {
            return refuse(&format!("Cannot write the project window store: {error}"), 500);
        }
        if let Err(error) = std::fs::rename(&temporary, &self.filename) {
            return refuse(&format!("Cannot write the project window store: {error}"), 500);
        }
        self.state = next;
        Ok(value)
    }

    /// The window with this id that this root is on a side of — or the refusal that says it is not
    /// linked, which is the same answer a root gets for a window that does not exist. Deliberately:
    /// the two are the same fact from where the caller stands, and distinguishing them would tell a
    /// stranger which window ids are real.
    fn own<'a>(windows: &'a [Value], root_id: &str, id: &str) -> Result<&'a Value, Refused> {
        windows
            .iter()
            .find(|window| {
                text(window.get("id")) == Some(id)
                    && [text(window.get("originRootId")), text(window.get("projectRootId"))].contains(&Some(root_id))
            })
            .ok_or_else(|| Refused { message: "Window is not linked to this project.".into(), status: 404 })
    }

    /// The windows this root is on either side of, without their layouts: a listing is a menu, and
    /// a layout is a document a desktop asks for by name.
    pub fn list(&self, root_id: &str) -> Value {
        Value::Array(
            self.windows()
                .iter()
                .filter(|window| {
                    [text(window.get("originRootId")), text(window.get("projectRootId"))].contains(&Some(root_id))
                })
                .map(|window| {
                    let mut listed = window.as_object().cloned().unwrap_or_default();
                    listed.shift_remove("layout");
                    Value::Object(listed)
                })
                .collect(),
        )
    }

    pub fn get(&self, root_id: &str, id: &str) -> Result<Value, Refused> {
        Self::own(self.windows(), root_id, id).cloned()
    }

    /// The window linking this origin, this project and this agent — the one it already has, or a
    /// new one. Three callers asking together get one window, because the triple IS the identity.
    pub fn create(
        &mut self,
        origin_root_id: &str,
        project: &Value,
        agent_id: &str,
        uuid: &dyn Fn() -> String,
        now: i64,
    ) -> Result<Value, Refused> {
        let project_root_id = text(project.get("id")).unwrap_or_default().to_string();
        let title = project.get("name").cloned().unwrap_or(Value::Null);
        self.write(move |data| {
            let windows = data["windows"].as_array_mut().expect("checked on open");
            if let Some(existing) = windows.iter().find(|window| {
                text(window.get("originRootId")) == Some(origin_root_id)
                    && text(window.get("projectRootId")) == Some(project_root_id.as_str())
                    && text(window.get("agentId")) == Some(agent_id)
            }) {
                return Ok(existing.clone());
            }
            if windows.len() >= 64 {
                return refuse("Project window limit reached.", 409);
            }
            let window = json!({
                "id": uuid(), "originRootId": origin_root_id, "projectRootId": project_root_id,
                "agentId": agent_id, "title": title, "createdAt": now, "layout": Value::Null,
            });
            windows.push(window.clone());
            Ok(window)
        })
    }

    /// The desktop's own layout document, saved by window id alone.
    ///
    /// Not root-scoped, and that is not an oversight: the desktop saving it is already holding the
    /// window, and the id is a v4 UUID nobody guesses. What IS checked is the shape and the size,
    /// because this is handed straight back to a native reader.
    pub fn layout(&mut self, id: &str, layout: &Value) -> Result<Value, Refused> {
        /* `typeof x === 'object'` in JavaScript, which an array satisfies: a layout may be a list
           of panes, and a check that demanded a map would refuse one the desktop writes today. */
        if layout.is_null() || !(layout.is_object() || layout.is_array()) || json_units(layout) > 1024 * 1024 {
            return refuse("Invalid project window layout.", 400);
        }
        let layout = layout.clone();
        self.write(move |data| {
            let windows = data["windows"].as_array_mut().expect("checked on open");
            let Some(window) = windows.iter_mut().find(|window| text(window.get("id")) == Some(id)) else {
                return refuse("Unknown project window.", 404);
            };
            window["layout"] = layout;
            Ok(json!({ "saved": true }))
        })
    }

    /// The layout a desktop reads back with its state. `null` for a window that has not saved one,
    /// which is an answer rather than a refusal — a fresh window has no layout and is not broken.
    pub fn state_layout(&self, id: &str) -> Result<Value, Refused> {
        match self.windows().iter().find(|window| text(window.get("id")) == Some(id)) {
            Some(window) => Ok(window.get("layout").cloned().unwrap_or(Value::Null)),
            None => refuse("Unknown project window.", 404),
        }
    }

    /// Send one finding across a window, to whichever side did not send it.
    pub fn report(&mut self, root_id: &str, input: &Value, now: i64) -> Result<Value, Refused> {
        let input = input.clone();
        self.write(move |data| {
            let windows = data["windows"].as_array().expect("checked on open").clone();
            let window_id = text(input.get("windowId")).unwrap_or_default();
            let window = Self::own(&windows, root_id, window_id)?;
            let origin = text(window.get("originRootId")).unwrap_or_default();
            let project = text(window.get("projectRootId")).unwrap_or_default();
            /* Speaking AS the project is strict — only the literal `true` — while the permission it
               needs is checked loosely, so a caller that sent something else is answered as itself
               and still cannot claim the origin's side. */
            let as_project = input.get("fromProject") == Some(&Value::Bool(true));
            let sender = if as_project { project } else { root_id };
            if truthy(input.get("fromProject")) && root_id != origin {
                return refuse("Only the originating agent may report its linked project findings.", 403);
            }
            let destination = if sender == origin { project } else { origin };

            let key = text(input.get("key"));
            let kind = text(input.get("kind"));
            let summary = text(input.get("summary"));
            /* `detail` and `evidence` default only when ABSENT: an explicit null is a caller saying
               something, and what it said is not a string. */
            let detail = match input.get("detail") {
                None => Some(""),
                held => text(held),
            };
            let evidence = match input.get("evidence") {
                None => Some(Vec::new()),
                Some(Value::Array(items)) => items
                    .iter()
                    .map(|item| item.as_str().map(str::to_string))
                    .collect::<Option<Vec<String>>>()
                    .filter(|items| items.len() <= 10 && items.iter().all(|item| units(item) <= 2048))
                    .map(|items| items.into_iter().collect()),
                Some(_) => None,
            };
            let (Some(key), Some(kind), Some(summary), Some(detail), Some(evidence)) = (key, kind, summary, detail, evidence) else {
                return refuse("Invalid integration report.", 400);
            };
            if key.is_empty()
                || units(key) > 128
                || !["issue", "status"].contains(&kind)
                || summary.trim().is_empty()
                || units(summary) > 2000
                || units(detail) > 16000
            {
                return refuse("Invalid integration report.", 400);
            }

            let content = json!({
                "windowId": window_id, "reportedByRootId": root_id, "senderRootId": sender,
                "destinationRootId": destination, "key": key, "kind": kind, "summary": summary,
                "detail": detail, "evidence": evidence,
            });
            let reports = data["reports"].as_array_mut().expect("checked on open");
            if let Some(existing) = reports.iter().find(|report| {
                text(report.get("windowId")) == Some(window_id)
                    && text(report.get("senderRootId")) == Some(sender)
                    && text(report.get("key")) == Some(key)
            }) {
                /* The retry key's promise: the same letter, or none. A key whose content changed is
                   refused rather than allowed to rewrite what the recipient may already have read. */
                if content.as_object().expect("an object").iter().any(|(name, value)| existing.get(name) != Some(value)) {
                    return refuse("Report retry key already has different content.", 409);
                }
                return Ok(json!({ "report": existing, "reused": true }));
            }
            if reports.len() >= 10000 {
                return refuse("Integration report limit reached; archive before adding reports.", 409);
            }
            let sequence = reports.last().and_then(|report| report.get("sequence")).and_then(Value::as_i64).unwrap_or(0) + 1;
            let mut report = content.as_object().cloned().unwrap_or_default();
            report.insert("sequence".into(), json!(sequence));
            report.insert("timestamp".into(), json!(now));
            let report = Value::Object(report);
            reports.push(report.clone());
            Ok(json!({ "report": report, "reused": false }))
        })
    }

    /// What this root has been sent, in sequence, from a cursor.
    ///
    /// `projectSide` is the originating agent reading the inbox of the project it opened — the one
    /// case where a caller reads letters addressed to another root, and it is allowed because that
    /// root is the project this very agent linked.
    pub fn inbox(&self, root_id: &str, options: &Value) -> Result<Value, Refused> {
        let after = match options.get("after") {
            None => 0,
            Some(value) => match value.as_i64().filter(|number| number.abs() <= 9_007_199_254_740_991) {
                Some(number) if number >= 0 => number,
                _ => return refuse("Invalid inbox cursor.", 400),
            },
        };
        let window = match text(options.get("windowId")) {
            Some(id) => Some(Self::own(self.windows(), root_id, id)?),
            None => None,
        };
        let project_side = truthy(options.get("projectSide"));
        let recipient = match (project_side, window) {
            (true, Some(window)) if text(window.get("originRootId")) == Some(root_id) => {
                text(window.get("projectRootId")).unwrap_or_default()
            }
            (true, _) => return refuse("Choose an originating project window for its project inbox.", 403),
            (false, _) => root_id,
        };
        let addressed = |report: &&Value| {
            text(report.get("destinationRootId")) == Some(recipient)
                && window.is_none_or(|window| report.get("windowId") == window.get("id"))
        };
        let taken: Vec<Value> = self
            .reports()
            .iter()
            .filter(|report| report.get("sequence").and_then(Value::as_i64).unwrap_or(0) > after)
            .filter(addressed)
            .take(100)
            .cloned()
            .collect();
        let cursor = taken.last().and_then(|report| report.get("sequence")).and_then(Value::as_i64).unwrap_or(after);
        let more = self
            .reports()
            .iter()
            .filter(|report| report.get("sequence").and_then(Value::as_i64).unwrap_or(0) > cursor)
            .any(|report| addressed(&report));
        Ok(json!({ "reports": taken, "cursor": cursor, "hasMore": more }))
    }
}

/// 0600, because a report carries whatever one team told another.
fn write_private(path: &Path, bytes: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
        file.write_all(bytes.as_bytes())?;
        file.sync_all()
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The record `runtime/windows.mjs` left behind (F173).
    ///
    /// It is a SEQUENCE against one store, not a set of independent answers, because most of what
    /// this module decides depends on what it was told before: a retry key is only a retry against
    /// an existing report, and an inbox cursor only means something against a sequence. So the
    /// replay is one store, one pass, in order — and a case that answered right for the wrong
    /// reason would have to have answered every case before it right too.
    fn recorded() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|red| red.parent())
            .expect("the checkout")
            .join("tests/window-store-corpus.json");
        serde_json::from_str(&std::fs::read_to_string(&path).expect("the recorded answers")).expect("a record")
    }

    /// `@big` and its siblings, as the record spells them: a recipe rather than a megabyte of `x`.
    fn expand(filler: &Value) -> Value {
        let times = filler["times"].as_u64().expect("a count") as usize;
        match (filler.get("repeat").and_then(Value::as_str), filler.get("each").and_then(Value::as_str)) {
            (Some(unit), _) => Value::String(unit.repeat(times)),
            (_, Some(prefix)) => Value::Array((0..times).map(|at| json!(format!("{prefix}{at}"))).collect()),
            _ => panic!("a filler is a repeat or an each"),
        }
    }

    /// `@1` is the id the first `create` minted, and `@big` is a filler: both are resolved on the
    /// way in, because a record carrying a random UUID or a megabyte of padding would be no record.
    fn resolve(value: &Value, minted: &[String], fillers: &Value) -> Value {
        match value {
            Value::String(text) => {
                if let Some(filler) = fillers.get(text.as_str()) {
                    return expand(filler);
                }
                match text.strip_prefix('@').and_then(|rest| rest.parse::<usize>().ok()) {
                    Some(at) => minted.get(at - 1).map(|id| json!(id)).unwrap_or_else(|| value.clone()),
                    None => value.clone(),
                }
            }
            Value::Array(items) => Value::Array(items.iter().map(|item| resolve(item, minted, fillers)).collect()),
            Value::Object(fields) => {
                Value::Object(fields.iter().map(|(name, item)| (name.clone(), resolve(item, minted, fillers))).collect())
            }
            other => other.clone(),
        }
    }

    /// And back again, so the answer can be compared with the record.
    fn fold(value: &Value, minted: &[String]) -> Value {
        match value {
            Value::String(text) => match minted.iter().position(|id| id == text) {
                Some(at) => json!(format!("@{}", at + 1)),
                None => value.clone(),
            },
            Value::Array(items) => Value::Array(items.iter().map(|item| fold(item, minted)).collect()),
            Value::Object(fields) => Value::Object(
                fields
                    .iter()
                    .map(|(name, item)| {
                        let folded = if ["createdAt", "timestamp"].contains(&name.as_str()) && item.is_number() {
                            json!("<time>")
                        } else {
                            fold(item, minted)
                        };
                        (name.clone(), folded)
                    })
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    fn answered(result: Result<Value, Refused>, minted: &[String]) -> Value {
        match result {
            Ok(value) => json!({ "value": fold(&value, minted) }),
            Err(Refused { message, status }) => json!({ "refused": message, "status": status }),
        }
    }

    #[test]
    fn the_store_answers_what_the_javascript_answered_case_for_case() {
        let record = recorded();
        let fillers = record["fillers"].clone();
        let directory = std::env::temp_dir().join(format!("red-window-store-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("a directory");
        let mut store = Windows::open(&directory).expect("an empty store");
        let mut minted: Vec<String> = Vec::new();
        let mut next = 0usize;
        /* The clocks are the record's own placeholder, so `now` is whatever it likes: every stamp
           is folded to `<time>` on both sides. What is NOT arbitrary is the id, which has to be a
           fresh one each time so the sequence numbering means something. */
        let mint = || {
            let count = std::cell::Cell::new(0u64);
            move || {
                count.set(count.get() + 1);
                format!("00000000-0000-4000-8000-{:012}", count.get())
            }
        };
        let uuid = mint();
        for case in record["cases"].as_array().expect("cases") {
            let name = case["name"].as_str().expect("a name");
            let op = resolve(&case["op"], &minted, &fillers);
            let call = op["call"].as_str().expect("a call");
            let result = match call {
                "create" => {
                    let made = store.create(
                        op["originRootId"].as_str().unwrap_or_default(),
                        &op["project"],
                        op["agentId"].as_str().unwrap_or_default(),
                        &uuid,
                        1_700_000_000_000,
                    );
                    if let Ok(window) = &made {
                        let id = window["id"].as_str().unwrap_or_default().to_string();
                        if !minted.contains(&id) {
                            minted.push(id);
                        }
                    }
                    made
                }
                "list" => Ok(store.list(op["rootId"].as_str().unwrap_or_default())),
                "get" => store.get(op["rootId"].as_str().unwrap_or_default(), op["id"].as_str().unwrap_or_default()),
                "layout" => store.layout(op["id"].as_str().unwrap_or_default(), &op["layout"]),
                "stateLayout" => store.state_layout(op["id"].as_str().unwrap_or_default()),
                "report" => store.report(op["rootId"].as_str().unwrap_or_default(), &op["input"], 1_700_000_000_000),
                "inbox" => store.inbox(op["rootId"].as_str().unwrap_or_default(), &op["options"]),
                other => panic!("unknown call {other}"),
            };
            assert_eq!(answered(result, &minted), case["answer"], "case {next}: {name}");
            next += 1;
        }
        assert!(next >= 45, "the whole record was replayed, not a prefix of it: {next}");
        std::fs::remove_dir_all(&directory).ok();
    }

    /// The store survives being reopened, because it is a DURABLE transport: an agent that reported
    /// a finding before a supervisor restart must still find it in the other side's inbox.
    #[test]
    fn what_was_written_is_there_after_the_supervisor_restarts() {
        let directory = std::env::temp_dir().join(format!("red-window-store-reopen-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("a directory");
        let uuid = || "00000000-0000-4000-8000-000000000001".to_string();
        let id = {
            let mut store = Windows::open(&directory).expect("an empty store");
            let window = store.create("origin", &json!({ "id": "project", "name": "Alpha" }), "agent", &uuid, 7).expect("a window");
            store
                .report("origin", &json!({ "windowId": window["id"], "key": "k", "kind": "issue", "summary": "A finding" }), 9)
                .expect("a report");
            window["id"].as_str().expect("an id").to_string()
        };
        let store = Windows::open(&directory).expect("the store again");
        assert_eq!(store.get("project", &id).expect("the window")["title"], json!("Alpha"));
        let inbox = store.inbox("project", &json!({})).expect("an inbox");
        assert_eq!(inbox["reports"].as_array().expect("reports").len(), 1);
        assert_eq!(inbox["cursor"], json!(1));
        std::fs::remove_dir_all(&directory).ok();
    }

    /// A refusal leaves the store exactly as it was. The write path applies a change to a COPY and
    /// keeps it only once it is on disk, and this is what that is for.
    #[test]
    fn a_refused_write_changes_nothing_on_disk() {
        let directory = std::env::temp_dir().join(format!("red-window-store-refused-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("a directory");
        let uuid = || "00000000-0000-4000-8000-000000000001".to_string();
        let mut store = Windows::open(&directory).expect("an empty store");
        let window = store.create("origin", &json!({ "id": "project", "name": "Alpha" }), "agent", &uuid, 7).expect("a window");
        let before = std::fs::read_to_string(directory.join("project-windows.json")).expect("the file");
        let refused = store
            .report("origin", &json!({ "windowId": window["id"], "key": "k", "kind": "note", "summary": "A finding" }), 9)
            .expect_err("refused");
        assert_eq!(refused.status, 400);
        assert_eq!(std::fs::read_to_string(directory.join("project-windows.json")).expect("the file"), before);
        assert_eq!(store.inbox("project", &json!({})).expect("an inbox")["reports"], json!([]));
        std::fs::remove_dir_all(&directory).ok();
    }

    /// The bound is UTF-16 code units, because that is what the JavaScript counted. A summary of
    /// 1,100 accented characters is 2,200 bytes and 1,100 units, and the two answers differ.
    #[test]
    fn a_bound_counts_what_javascript_counted() {
        assert_eq!(units("é"), 1, "one unit, two bytes");
        assert_eq!(units("😀"), 2, "a surrogate pair is two units, as `.length` reports it");
        let directory = std::env::temp_dir().join(format!("red-window-store-units-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("a directory");
        let uuid = || "00000000-0000-4000-8000-000000000001".to_string();
        let mut store = Windows::open(&directory).expect("an empty store");
        let window = store.create("origin", &json!({ "id": "project", "name": "Alpha" }), "agent", &uuid, 7).expect("a window");
        let accented = "é".repeat(2000);
        assert!(accented.len() > 2000, "it is past the bound in BYTES");
        let sent = store.report(
            "origin",
            &json!({ "windowId": window["id"], "key": "k", "kind": "issue", "summary": accented }),
            9,
        );
        assert!(sent.is_ok(), "and inside it in units, which is what the bound is: {sent:?}");
        std::fs::remove_dir_all(&directory).ok();
    }
}
