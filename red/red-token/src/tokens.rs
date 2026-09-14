//! The per-root ledgers a workspace serves, plus the one workspace preference the ledger reads.
//!
//! The host's preference store allowlists its keys and silently drops the ones it does not know, so
//! `tokenWindowMs` is kept here, beside the ledgers, and merged into the state the worker answers.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::feed::write_atomically;
use crate::ledger::Ledger;
use crate::{refuse, uuid_shaped, Alive, Clock, Mint, Refused, Window, DEFAULT_WINDOW_MS, MAX_WINDOW_MS, MIN_WINDOW_MS};

pub struct Tokens {
    pub directory: PathBuf,
    pub file: PathBuf,
    /// Shared with every ledger this opens, because the ledger reads the window at the moment it
    /// opens a contest rather than at the moment it was constructed.
    pub preferences: Arc<Mutex<serde_json::Map<String, Value>>>,
    ledgers: BTreeMap<String, Ledger>,
    alive: Alive,
    now: Clock,
    mint: Mint,
}

fn window_of(preferences: &serde_json::Map<String, Value>) -> i64 {
    preferences
        .get("tokenWindowMs")
        .and_then(Value::as_i64)
        .filter(|value| (MIN_WINDOW_MS..=MAX_WINDOW_MS).contains(value))
        .unwrap_or(DEFAULT_WINDOW_MS)
}

impl Tokens {
    pub fn open(directory: &Path, alive: Alive, now: Clock, mint: Mint) -> Result<Tokens, String> {
        let directory = directory.join("tokens");
        std::fs::create_dir_all(&directory).map_err(|error| format!("{} cannot be created: {error}", directory.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700));
        }
        let file = directory.join("preferences.json");
        /* A preferences file that will not parse is no preferences at all, exactly as the
           JavaScript swallowed ENOENT and a SyntaxError: the window falls back to its default and
           the workspace still arbitrates. */
        let preferences = std::fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        Ok(Tokens {
            directory,
            file,
            preferences: Arc::new(Mutex::new(preferences)),
            ledgers: BTreeMap::new(),
            alive,
            now,
            mint,
        })
    }

    fn persist(&self) {
        let document = Value::Object(self.preferences.lock().expect("preferences lock").clone());
        let _ = write_atomically(&self.file, &document);
    }

    pub fn window(&self) -> i64 {
        window_of(&self.preferences.lock().expect("preferences lock"))
    }

    /// The generation a replaced workspace worker announces. It lives beside the window because
    /// both are workspace-wide rather than per root, and both have to survive the worker that reads
    /// them.
    pub fn bump_generation(&mut self) -> i64 {
        let next = {
            let mut preferences = self.preferences.lock().expect("preferences lock");
            let next = preferences.get("generation").and_then(Value::as_i64).unwrap_or(0) + 1;
            preferences.insert("generation".into(), json!(next));
            next
        };
        self.persist();
        next
    }

    pub fn set_window(&mut self, value: Option<i64>) -> Result<Value, Refused> {
        let Some(value) = value.filter(|value| (MIN_WINDOW_MS..=MAX_WINDOW_MS).contains(value)) else {
            return Err(refuse(
                format!("Invalid tokenWindowMs preference; expected an integer between {MIN_WINDOW_MS} and {MAX_WINDOW_MS}."),
                400,
            ));
        };
        self.preferences.lock().expect("preferences lock").insert("tokenWindowMs".into(), json!(value));
        self.persist();
        /* Nothing is re-armed: an open contest carries the window it opened under, its deadline is
           an absolute wall time, and the next contest is the first to use the new length. */
        Ok(Value::Object(self.preferences.lock().expect("preferences lock").clone()))
    }

    pub fn preferences(&self) -> Value {
        Value::Object(self.preferences.lock().expect("preferences lock").clone())
    }

    fn window_reader(&self) -> Window {
        let preferences = self.preferences.clone();
        Arc::new(move || window_of(&preferences.lock().expect("preferences lock")))
    }

    pub fn ledger(&mut self, root_id: &str) -> Result<&mut Ledger, Refused> {
        if !uuid_shaped(root_id) {
            return Err(refuse("Unknown project root.", 404));
        }
        if !self.ledgers.contains_key(root_id) {
            let ledger = Ledger::open(
                &self.directory.join(root_id),
                root_id,
                self.window_reader(),
                self.alive.clone(),
                self.now.clone(),
                self.mint.clone(),
            )
            .map_err(|message| refuse(message, 500))?;
            self.ledgers.insert(root_id.to_string(), ledger);
        }
        Ok(self.ledgers.get_mut(root_id).expect("the ledger just opened"))
    }

    /// The roots this process has opened, for the callers that walk every ring.
    pub fn opened(&self) -> Vec<String> {
        self.ledgers.keys().cloned().collect()
    }
}
