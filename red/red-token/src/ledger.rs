//! One ledger per project root, persisted atomically as `token.json` in the runtime directory so a
//! replaced workspace worker resumes the same holder and the same absolute deadline.
//!
//! Every rule here is spec 095's or spec 103's, and every refusal is compared word for word against
//! the recorded transcript: the wording IS the interface, because it is what an agent reads when it
//! is told to stop.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::feed::{write_atomically, Feed, FEED_LIMIT};
use crate::{
    elapsed, printable, refuse, seconds, uuid_shaped, Alive, Clock, Contest, Contester, Holder, Identity, Known, Mint, Refused, Window,
    DEFAULT_WINDOW_MS, MAX_WINDOW_MS, MIN_WINDOW_MS,
};

const HISTORY: usize = 50;
const IDENTITIES: usize = 64;

type Watcher = Arc<dyn Fn(&Value) + Send + Sync>;

/// What the ledger persists. The field order is the order the JavaScript's object literal had, and
/// the transcript compares the file's bytes.
#[derive(Debug, Clone, Default)]
pub struct State {
    pub holder: Option<Holder>,
    pub contest: Option<Contest>,
    /// Insertion-ordered, because a JavaScript object is: an agent re-charged a cooldown keeps its
    /// place, and one charged for the first time goes at the end.
    pub cooldown: Vec<(String, String)>,
    pub sequence: i64,
    pub token_sequence: i64,
    pub identities: Vec<(String, Known)>,
    pub history: Vec<Value>,
}

impl State {
    pub fn to_json(&self, root_id: &str) -> Value {
        let mut out = serde_json::Map::new();
        out.insert("version".into(), json!(1));
        out.insert("rootId".into(), json!(root_id));
        out.insert("holder".into(), self.holder.as_ref().map_or(Value::Null, Holder::to_json));
        out.insert("contest".into(), self.contest.as_ref().map_or(Value::Null, Contest::to_json));
        out.insert("cooldown".into(), ordered(self.cooldown.iter().map(|(key, value)| (key.clone(), json!(value)))));
        out.insert("sequence".into(), json!(self.sequence));
        out.insert("tokenSequence".into(), json!(self.token_sequence));
        out.insert("identities".into(), ordered(self.identities.iter().map(|(key, value)| (key.clone(), value.to_json()))));
        out.insert("history".into(), Value::Array(self.history.clone()));
        Value::Object(out)
    }
}

fn ordered(entries: impl Iterator<Item = (String, Value)>) -> Value {
    let mut map = serde_json::Map::new();
    for (key, value) in entries {
        map.insert(key, value);
    }
    Value::Object(map)
}

pub struct Ledger {
    pub directory: PathBuf,
    pub root_id: String,
    pub feed: Feed,
    pub file: PathBuf,
    pub state: State,
    window_of: Window,
    alive: Alive,
    now: Clock,
    mint: Mint,
    watchers: Vec<(u64, Watcher)>,
    next_watcher: u64,
}

/// The desktop's side of a call: everything `ledger.desktop(action, {...})` took, with the one
/// difference a service forces — `lookup` was a function the worker passed in, and a function does
/// not cross a socket, so the caller resolves it first and passes what it found.
#[derive(Debug, Default, Clone)]
pub struct FromDesktop {
    pub contest_id: Option<String>,
    pub desktop_id: Option<String>,
    pub reason: String,
    pub agent_id: Option<String>,
    pub lookup: Option<Value>,
}

impl Ledger {
    pub fn open(directory: &Path, root_id: &str, window_of: Window, alive: Alive, now: Clock, mint: Mint) -> Result<Ledger, String> {
        std::fs::create_dir_all(directory).map_err(|error| format!("{} cannot be created: {error}", directory.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700));
        }
        let feed = Feed::open(directory, root_id, FEED_LIMIT, now.clone()).map_err(|error| format!("{} cannot be opened: {error}", directory.display()))?;
        let mut ledger = Ledger {
            directory: directory.to_path_buf(),
            root_id: root_id.to_string(),
            feed,
            file: directory.join("token.json"),
            state: State::default(),
            window_of,
            alive,
            now,
            mint,
            watchers: Vec::new(),
            next_watcher: 0,
        };
        ledger.load()?;
        Ok(ledger)
    }

    fn load(&mut self) -> Result<(), String> {
        let text = match std::fs::read_to_string(&self.file) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("{} cannot be read: {error}", self.file.display())),
        };
        let value: Value = serde_json::from_str(&text).map_err(|error| format!("{} is not JSON: {error}", self.file.display()))?;
        /* A ledger whose rootId is not this root is another project's arbitration, and opening it
           would hand this root's agents someone else's holder. */
        if value.get("version").and_then(Value::as_i64) != Some(1) || value.get("rootId").and_then(Value::as_str) != Some(self.root_id.as_str()) {
            return Err("Token ledger belongs to another project root.".into());
        }
        self.state = State {
            holder: value.get("holder").and_then(Holder::from_json),
            contest: value.get("contest").and_then(Contest::from_json),
            cooldown: value
                .get("cooldown")
                .and_then(Value::as_object)
                .map(|map| map.iter().filter_map(|(key, value)| value.as_str().map(|text| (key.clone(), text.to_string()))).collect())
                .unwrap_or_default(),
            sequence: value.get("sequence").and_then(Value::as_i64).unwrap_or(0),
            token_sequence: value.get("tokenSequence").and_then(Value::as_i64).unwrap_or(0),
            identities: value
                .get("identities")
                .and_then(Value::as_object)
                .map(|map| map.iter().filter_map(|(key, value)| Known::from_json(value).map(|known| (key.clone(), known))).collect())
                .unwrap_or_default(),
            history: value.get("history").and_then(Value::as_array).cloned().unwrap_or_default(),
        };
        Ok(())
    }

    /// One reading of the clock, in the shape every record here stores.
    pub fn at(&self) -> String {
        red_core::time::iso((self.now)())
    }

    pub fn now(&self) -> i64 {
        (self.now)()
    }

    pub fn persist(&self) {
        let _ = write_atomically(&self.file, &self.state.to_json(&self.root_id));
    }

    pub fn watch(&mut self, watcher: Watcher) -> u64 {
        self.next_watcher += 1;
        self.watchers.push((self.next_watcher, watcher));
        self.next_watcher
    }

    pub fn unwatch(&mut self, id: u64) {
        self.watchers.retain(|(known, _)| *known != id);
    }

    pub fn window(&self) -> i64 {
        let value = (self.window_of)();
        if (MIN_WINDOW_MS..=MAX_WINDOW_MS).contains(&value) {
            value
        } else {
            DEFAULT_WINDOW_MS
        }
    }

    pub fn frame(&mut self, kind: &str, by: &Value, fields: &Value) -> Result<Value, String> {
        let frame = self.feed.emit(kind, by, fields)?;
        let sequence = frame.get("sequence").and_then(Value::as_i64).unwrap_or(0);
        self.state.sequence = sequence;
        if kind.starts_with("token.") {
            self.state.token_sequence = sequence;
        }
        self.state.history.push(json!({
            "sequence": sequence,
            "at": frame.get("at").cloned().unwrap_or(Value::Null),
            "type": kind,
            "by": by.clone(),
        }));
        if self.state.history.len() > HISTORY {
            self.state.history.drain(..self.state.history.len() - HISTORY);
        }
        /* One bad desktop never stops the others, so a watcher that panics is not this ledger's
           problem — but a panic here would poison the service's lock, so watchers are called with
           the status already computed and nothing of the ledger borrowed. */
        let snapshot = self.status(None);
        for (_, watcher) in self.watchers.clone() {
            watcher(&snapshot);
        }
        Ok(frame)
    }

    /// The identity is the agent's SESSION, not its process (spec 095, Identity): a resumed session
    /// is the same agentId under a new pid, so the hold stands and liveness follows the process that
    /// is running it now. Without this the resumed holder reads as gone and loses its own token.
    pub fn seen(&mut self, identity: Option<&Identity>) {
        let Some(identity) = identity else { return };
        let at = self.at();
        let first_seen_at = self
            .state
            .identities
            .iter()
            .find(|(key, _)| key == &identity.agent_id)
            .map(|(_, known)| known.first_seen_at.clone())
            .unwrap_or_else(|| at.clone());
        let known = Known {
            agent_id: identity.agent_id.clone(),
            label: identity.label.clone(),
            pid: identity.pid,
            first_seen_at,
            last_seen_at: at,
        };
        match self.state.identities.iter_mut().find(|(key, _)| key == &identity.agent_id) {
            Some(entry) => entry.1 = known,
            None => self.state.identities.push((identity.agent_id.clone(), known)),
        }
        if let (Some(pid), Some(holder)) = (identity.pid, self.state.holder.as_mut()) {
            if holder.agent_id == identity.agent_id && holder.pid != Some(pid) {
                holder.pid = Some(pid);
            }
        }
        if self.state.identities.len() > IDENTITIES {
            /* Stable, and a stamp that will not parse compares equal — which is V8's answer to a
               comparator that returns NaN, and keeps such an entry where it was. */
            let mut order: Vec<usize> = (0..self.state.identities.len()).collect();
            order.sort_by(|left, right| {
                let stamp = |index: &usize| red_core::time::parse(&self.state.identities[*index].1.last_seen_at);
                match (stamp(left), stamp(right)) {
                    (Some(a), Some(b)) => a.cmp(&b),
                    _ => std::cmp::Ordering::Equal,
                }
            });
            let doomed: Vec<String> = order
                .iter()
                .take(self.state.identities.len() - IDENTITIES)
                .map(|index| self.state.identities[*index].0.clone())
                .collect();
            self.state.identities.retain(|(key, _)| !doomed.contains(key));
        }
    }

    pub fn gone(&self, holder: Option<&Holder>) -> bool {
        holder.and_then(|holder| holder.pid).is_some_and(|pid| pid > 0 && !(self.alive)(pid))
    }

    /// Applied before every read and every call: the deadline that passed while nobody was looking,
    /// and the holder whose process left, resolve here rather than waiting for a timer to fire.
    pub fn settle(&mut self) -> bool {
        let now = self.now();
        let mut changed = false;
        let expired: Vec<String> = self
            .state
            .cooldown
            .iter()
            .filter(|(_, until)| !red_core::time::parse(until).is_some_and(|stamp| stamp > now))
            .map(|(agent_id, _)| agent_id.clone())
            .collect();
        if !expired.is_empty() {
            self.state.cooldown.retain(|(agent_id, _)| !expired.contains(agent_id));
            changed = true;
        }
        if let Some(contest) = self.state.contest.clone() {
            if red_core::time::parse(&contest.deadline).is_some_and(|deadline| deadline <= now) {
                self.state.contest = None;
                let holder = contest.contester.holding(&self.at());
                self.state.holder = Some(holder.clone());
                let _ = self.frame("token.claimed", &json!({ "kind": "deadline" }), &json!({ "holder": holder.to_json(), "contestId": contest.id }));
                changed = true;
            }
        }
        if changed {
            self.persist();
        }
        changed
    }

    pub fn status(&self, caller: Option<&Identity>) -> Value {
        let now = self.now();
        let contest = self.state.contest.as_ref().map(|contest| {
            let mut out = contest.to_json();
            let remaining = red_core::time::parse(&contest.deadline).map(|deadline| red_core::time::seconds_from(deadline - now));
            out.as_object_mut().expect("an object").insert("secondsRemaining".into(), remaining.map_or(Value::Null, |value| json!(value)));
            out
        });
        let mut out = serde_json::Map::new();
        out.insert("rootId".into(), json!(self.root_id));
        out.insert("holder".into(), self.state.holder.as_ref().map_or(Value::Null, Holder::to_json));
        out.insert("window".into(), json!(self.window()));
        out.insert("contest".into(), contest.unwrap_or(Value::Null));
        out.insert(
            "holdsToken".into(),
            json!(caller.is_some_and(|caller| self.state.holder.as_ref().is_some_and(|holder| holder.agent_id == caller.agent_id))),
        );
        out.insert(
            "holderAlive".into(),
            match self.state.holder.as_ref() {
                Some(holder) => json!(!self.gone(Some(holder))),
                None => Value::Null,
            },
        );
        out.insert("cooldown".into(), ordered(self.state.cooldown.iter().map(|(key, value)| (key.clone(), json!(value)))));
        out.insert("identities".into(), Value::Array(self.state.identities.iter().map(|(_, known)| known.to_json()).collect()));
        out.insert("sequence".into(), json!(self.state.sequence));
        out.insert("tokenSequence".into(), json!(self.state.token_sequence));
        out.insert("feedCursor".into(), json!(self.feed.sequence));
        out.insert(
            "history".into(),
            Value::Array(self.state.history.iter().skip(self.state.history.len().saturating_sub(10)).cloned().collect()),
        );
        Value::Object(out)
    }

    pub fn segment(&self) -> Value {
        crate::segment_frame(&self.status(None))
    }

    /// Decision 5: refuse by name, attempt nothing. A free token is refused too, because holding is
    /// deliberate — token_contest claims a free token at once, and the claim is a frame everybody
    /// sees.
    pub fn refusal(&self, caller: Option<&Identity>, tool: Option<&str>) -> Option<String> {
        let named = tool.filter(|tool| !tool.is_empty()).map(|tool| format!("{tool} ")).unwrap_or_default();
        let caller = caller?;
        let Some(holder) = self.state.holder.as_ref() else {
            return Some(format!(
                "The project token for this root is free, and {named}needs it. Nothing was attempted. Call token_contest: a free token is claimed at once."
            ));
        };
        if holder.agent_id == caller.agent_id {
            return None;
        }
        let tail = match self.state.contest.as_ref() {
            Some(contest) => format!("; {} already has one open until {}.", contest.contester.label, contest.deadline),
            None => "; the holder or the person at the desktop may reject it, otherwise the token transfers to you at the deadline.".to_string(),
        };
        Some(format!(
            "The project token is held by {} ({}) since {} ({} ago), and {named}needs it. Nothing was attempted. Call token_contest to open a {} window{tail}",
            holder.label,
            holder.agent_id,
            holder.since,
            elapsed(&holder.since, self.now()),
            seconds(self.window()),
        ))
    }

    pub fn contest(&mut self, caller: &Identity, reason: &str) -> Result<Value, Refused> {
        self.settle();
        self.seen(Some(caller));
        let holder = self.state.holder.clone();
        if holder.as_ref().is_some_and(|holder| holder.agent_id == caller.agent_id) {
            self.persist();
            return Ok(json!({
                "state": "held",
                "holder": holder.expect("a holder").to_json(),
                "detail": "This agent already holds the token.",
            }));
        }
        let now = self.now();
        if let Some((_, until)) = self.state.cooldown.iter().find(|(agent_id, _)| agent_id == &caller.agent_id) {
            if let Some(stamp) = red_core::time::parse(until).filter(|stamp| *stamp > now) {
                return Err(refuse(
                    format!(
                        "This agent's contest was rejected and it cannot contest again until {until} ({} from now).",
                        seconds(stamp - now)
                    ),
                    409,
                ));
            }
        }
        if let Some(open) = self.state.contest.as_ref() {
            return Err(refuse(
                format!(
                    "{} ({}) already has a contest open until {}. Wait for it to resolve.",
                    open.contester.label, open.contester.agent_id, open.deadline
                ),
                409,
            ));
        }
        let contester = Contester::from(caller);
        if holder.is_none() || self.gone(holder.as_ref()) {
            let by = match holder.as_ref() {
                Some(_) => json!({ "kind": "holder-gone" }),
                None => json!({ "kind": "agent", "agentId": caller.agent_id, "label": caller.label }),
            };
            let taken = contester.holding(&self.at());
            self.state.holder = Some(taken.clone());
            let mut fields = serde_json::Map::new();
            fields.insert("holder".into(), taken.to_json());
            if let Some(previous) = holder.as_ref() {
                fields.insert("previousHolder".into(), previous.to_json());
            }
            let kind = by.get("kind").and_then(Value::as_str).unwrap_or_default().to_string();
            self.frame("token.claimed", &by, &Value::Object(fields)).map_err(|message| refuse(message, 500))?;
            self.persist();
            return Ok(json!({ "state": "claimed", "holder": taken.to_json(), "by": kind }));
        }
        let opened_at = self.at();
        /* The window a contest was opened under travels with it: the deadline is fixed at this
           instant, and so is the cooldown a rejection of it costs. Changing the preference
           re-times nothing. */
        let window_ms = self.window();
        let contest = Contest {
            id: (self.mint)(),
            contester: contester.clone(),
            opened_at,
            window_ms: Some(window_ms),
            deadline: red_core::time::iso(now + window_ms),
            reason: printable(Some(reason), 200),
        };
        self.state.contest = Some(contest.clone());
        let holder = holder.expect("a holder");
        self.frame(
            "token.contested",
            &json!({ "kind": "agent", "agentId": caller.agent_id, "label": caller.label }),
            &json!({
                "contestId": contest.id,
                "contester": contester.to_json(),
                "holder": holder.to_json(),
                "deadline": contest.deadline,
                "reason": contest.reason,
            }),
        )
        .map_err(|message| refuse(message, 500))?;
        self.persist();
        Ok(json!({ "state": "pending", "contestId": contest.id, "deadline": contest.deadline, "holder": holder.to_json() }))
    }

    pub fn reject(&mut self, caller: &Identity, reason: &str) -> Result<Value, Refused> {
        self.settle();
        self.seen(Some(caller));
        let Some(contest) = self.state.contest.clone() else {
            return Err(refuse("No contest is open on this root.", 409));
        };
        if !self.state.holder.as_ref().is_some_and(|holder| holder.agent_id == caller.agent_id) {
            return Err(refuse(self.refusal(Some(caller), Some("token_reject")).unwrap_or_default(), 409));
        }
        let by = json!({ "kind": "agent", "agentId": caller.agent_id, "label": caller.label });
        self.settle_rejection(&contest, &by, reason, true)
    }

    /// `cooldown: false` is the assign case (spec 103 decision 5): the person at the desktop handing
    /// the token to a chosen agent settles the open contest rather than leaving it to time out, and
    /// the contester did nothing wrong, so it is not charged the window a refusal costs.
    pub fn settle_rejection(&mut self, contest: &Contest, by: &Value, reason: &str, cooldown: bool) -> Result<Value, Refused> {
        let until = red_core::time::iso(self.now() + contest.window_ms.unwrap_or_else(|| self.window()));
        self.state.contest = None;
        if cooldown {
            let agent_id = contest.contester.agent_id.clone();
            match self.state.cooldown.iter_mut().find(|(key, _)| key == &agent_id) {
                Some(entry) => entry.1 = until.clone(),
                None => self.state.cooldown.push((agent_id, until.clone())),
            }
        }
        let said = printable(Some(reason), 200);
        let holder = self.state.holder.as_ref().map_or(Value::Null, Holder::to_json);
        let cooldown_until = if cooldown { json!(until) } else { Value::Null };
        self.frame(
            "token.rejected",
            by,
            &json!({
                "contestId": contest.id,
                "contester": contest.contester.to_json(),
                "holder": holder,
                "reason": if said.is_empty() { "no reason given".to_string() } else { said },
                "cooldownUntil": cooldown_until.clone(),
            }),
        )
        .map_err(|message| refuse(message, 500))?;
        self.persist();
        Ok(json!({
            "state": "rejected",
            "contestId": contest.id,
            "cooldownUntil": cooldown_until,
            "holder": self.state.holder.as_ref().map_or(Value::Null, Holder::to_json),
        }))
    }

    /// A release under an open contest is that contest answered, not a token left lying free: the
    /// contester would otherwise wait out a window for a token nobody holds, and could not even
    /// re-contest, because a second contest is refused while one is open.
    pub fn release(&mut self, caller: &Identity) -> Result<Value, Refused> {
        self.settle();
        self.seen(Some(caller));
        if !self.state.holder.as_ref().is_some_and(|holder| holder.agent_id == caller.agent_id) {
            return Err(refuse(self.refusal(Some(caller), Some("token_release")).unwrap_or_default(), 409));
        }
        let holder = self.state.holder.clone().expect("a holder");
        if let Some(contest) = self.state.contest.clone() {
            self.state.contest = None;
            let taken = contest.contester.holding(&self.at());
            self.state.holder = Some(taken.clone());
            self.frame(
                "token.claimed",
                &json!({ "kind": "release", "agentId": holder.agent_id, "label": holder.label }),
                &json!({ "holder": taken.to_json(), "previousHolder": holder.to_json(), "contestId": contest.id }),
            )
            .map_err(|message| refuse(message, 500))?;
            self.persist();
            return Ok(json!({
                "state": "claimed",
                "holder": taken.to_json(),
                "previousHolder": holder.to_json(),
                "contestId": contest.id,
                "by": "release",
            }));
        }
        self.state.holder = None;
        self.frame(
            "token.released",
            &json!({ "kind": "agent", "agentId": caller.agent_id, "label": caller.label }),
            &json!({ "holder": holder.to_json() }),
        )
        .map_err(|message| refuse(message, 500))?;
        self.persist();
        Ok(json!({ "state": "free", "previousHolder": holder.to_json() }))
    }

    /// Decision 6: the person at the desktop is never gated. These five are that person's acts —
    /// `assign` is spec 103 decision 5's "Hold token for that agent", the human's grant made from
    /// the Tasks pane rather than from a contest that agent had to open first.
    pub fn desktop(&mut self, action: &str, request: &FromDesktop) -> Result<Value, Refused> {
        self.settle();
        let named = printable(request.desktop_id.as_deref(), 64);
        let by = json!({ "kind": "desktop", "desktopId": if named.is_empty() { "desktop".to_string() } else { named } });
        let contest = self.state.contest.clone();
        if action == "assign" {
            let agent_id = request.agent_id.clone().filter(|id| uuid_shaped(id));
            let Some(agent_id) = agent_id else {
                return Err(refuse("Name the agent to assign the token to.", 400));
            };
            /* The ledger's own registry first, then the conversations this project remembers,
               because an agent the Tasks pane can list may not have called anything on this root
               yet. */
            let known = self
                .state
                .identities
                .iter()
                .find(|(key, _)| key == &agent_id)
                .map(|(_, known)| known.to_json())
                .or_else(|| request.lookup.clone().filter(|value| !value.is_null()));
            let Some(known) = known else {
                return Err(refuse(
                    format!("No agent {agent_id} is known on this root: the ledger has seen none by that id, and no conversation this project remembers carries it."),
                    404,
                ));
            };
            /* An open contest is answered rather than left running against a holder it can no
               longer reach; the contester is charged nothing, because the desktop moved the token,
               not it. */
            if let Some(contest) = contest.as_ref() {
                self.settle_rejection(contest, &by, "the token was assigned from the desktop", false)?;
            }
            let previous = self.state.holder.clone();
            let label = printable(known.get("label").and_then(Value::as_str), 64);
            let holder = Holder {
                agent_id: agent_id.clone(),
                label: if label.is_empty() { "agent".into() } else { label },
                pid: known.get("pid").and_then(Value::as_i64).filter(|pid| *pid > 0),
                since: self.at(),
            };
            self.state.holder = Some(holder.clone());
            let mut fields = serde_json::Map::new();
            fields.insert("holder".into(), holder.to_json());
            if let Some(previous) = previous.as_ref() {
                fields.insert("previousHolder".into(), previous.to_json());
            }
            self.frame("token.claimed", &by, &Value::Object(fields)).map_err(|message| refuse(message, 500))?;
            self.persist();
            let mut answer = serde_json::Map::new();
            answer.insert("state".into(), json!("claimed"));
            answer.insert("holder".into(), holder.to_json());
            if let Some(previous) = previous.as_ref() {
                answer.insert("previousHolder".into(), previous.to_json());
            }
            answer.insert("by".into(), json!("desktop"));
            return Ok(Value::Object(answer));
        }
        if action == "reject" || action == "grant" {
            let Some(open) = contest.as_ref() else {
                return Err(refuse("No contest is open on this root.", 409));
            };
            match request.contest_id.as_deref().filter(|id| !id.is_empty()) {
                None => return Err(refuse(format!("Name the contest to {action}: the open one is {}.", open.id), 400)),
                Some(named) if named != open.id => return Err(refuse("That contest is no longer the open one.", 409)),
                Some(_) => {}
            }
        }
        if action == "reject" {
            return self.settle_rejection(&contest.expect("an open contest"), &by, &request.reason, true);
        }
        if action == "grant" {
            let contest = contest.expect("an open contest");
            self.state.contest = None;
            let taken = contest.contester.holding(&self.at());
            self.state.holder = Some(taken.clone());
            self.frame("token.claimed", &by, &json!({ "holder": taken.to_json(), "contestId": contest.id })).map_err(|message| refuse(message, 500))?;
            self.persist();
            return Ok(json!({ "state": "claimed", "holder": taken.to_json(), "by": "desktop" }));
        }
        if action == "revoke" || action == "free" {
            let Some(holder) = self.state.holder.clone() else {
                return Err(refuse("Nobody holds the token on this root.", 409));
            };
            self.state.holder = None;
            let kind = if action == "revoke" { "token.revoked" } else { "token.released" };
            self.frame(kind, &by, &json!({ "holder": holder.to_json() })).map_err(|message| refuse(message, 500))?;
            self.persist();
            return Ok(json!({ "state": "free", "previousHolder": holder.to_json() }));
        }
        Err(refuse("Choose reject, grant, assign, revoke or free.", 400))
    }
}
