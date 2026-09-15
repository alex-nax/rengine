//! What a launch leaves on the feed, and who it says asked for it (F158, spec 078, spec 095).
//!
//! A game pane is the one thing in this workspace that a person starts and then watches for minutes.
//! So the feed carries a PAIR for it — `game.started` when it runs, `game.ended` when it stops — and
//! the pair is what a monitor draws a session from. Everything here exists to make that pair
//! trustworthy under the two things that actually happen:
//!
//! **The host announces a new session before the launch call returns.** So who asked cannot be
//! looked up by session id at the moment the announcement arrives. Each launch queues its asker on
//! the ROOT first; the frame takes the oldest still-fresh entry, and a launch the host coalesced
//! onto a session that already existed takes its own entry back.
//!
//! **A worker can be replaced mid-game.** The open pairs are read back out of the ring rather than
//! kept in a lost map, so the `ended` half still lands and a `started` is never repeated.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{json, Value};

/// How long a queued asker stays fresh. Ten seconds is the JavaScript's: long enough for a launch
/// to come back, short enough that a queue entry never attaches to an unrelated later session.
pub const FRESH_MS: i64 = 10_000;

/// What the feed should be told about one session transition, if anything.
///
/// `kind` is the frame's own name, because two different pairs ride on one stream: a GAME a person
/// watches, and a device-bound dashboard ACTION — "deploying to the box" — whose session bounds it.
/// They are the same shape and a different sentence.
#[derive(Debug, Clone, PartialEq)]
pub enum Says {
    Started { kind: &'static str, by: Value, fields: Value },
    Ended { kind: &'static str, by: Value, fields: Value },
    Nothing,
}

/// A game this worker has announced and not yet closed.
#[derive(Debug, Clone, PartialEq)]
pub struct Open {
    pub root_id: String,
    pub game_id: Value,
    pub surface: Value,
    pub args: Value,
    pub by: Value,
}

/// Who asked for what, and what is still open.
#[derive(Default)]
pub struct Launches {
    /// Askers queued on a root, oldest first, because the session id is not known yet.
    queued: Mutex<HashMap<String, Vec<(Value, i64)>>>,
    /// The asker of a session, once there IS a session id to key by.
    of_session: Mutex<HashMap<String, Value>>,
    /// The games announced and not yet ended.
    open: Mutex<HashMap<String, Open>>,
    /// The device-bound dashboard actions running, and the frame each will close with. A pane that
    /// is a deploy to a box is the workspace touching something that is not this machine, and the
    /// pair is how a person sees it start and stop.
    devices: Mutex<HashMap<String, (String, Value, Value)>>,
}

impl Launches {
    pub fn new() -> Launches {
        Launches::default()
    }

    /// A launch is about to be asked for on this root, by this caller.
    pub fn queue(&self, root_id: &str, by: &Value, now: i64) {
        self.queued.lock().expect("queued").entry(root_id.to_string()).or_default().push((by.clone(), now));
    }

    /// The oldest still-fresh asker on this root, taken. Stale entries are dropped on the way past:
    /// a launch that failed left one behind, and it must never attach to a later session.
    pub fn next(&self, root_id: &str, now: i64) -> Option<Value> {
        let mut queued = self.queued.lock().expect("queued");
        let list = queued.get_mut(root_id)?;
        while !list.is_empty() {
            let (by, at) = list.remove(0);
            if now - at < FRESH_MS {
                return Some(by);
            }
        }
        None
    }

    /// The launch returned with a session. A session the host COALESCED onto one that was already
    /// running is not a new launch, so this asker takes its own queue entry back rather than
    /// leaving it to attach to somebody else's.
    pub fn landed(&self, root_id: &str, session_id: &str, by: &Value, already_running: bool, now: i64) {
        self.of_session.lock().expect("sessions").insert(session_id.to_string(), by.clone());
        if already_running {
            let _ = self.next(root_id, now);
        }
    }

    /// A device-bound action has started on this session, and will close with these fields.
    pub fn device_action(&self, session_id: &str, root_id: &str, by: &Value, fields: &Value) {
        self.devices
            .lock()
            .expect("devices")
            .insert(session_id.to_string(), (root_id.to_string(), by.clone(), fields.clone()));
    }

    /// One session transition from the host's own stream. The answer is what the feed should say.
    pub fn heard(&self, session: &Value, now: i64) -> Says {
        let Some(id) = session.get("id").and_then(Value::as_str) else { return Says::Nothing };
        let running = session.get("state").and_then(Value::as_str) == Some("running");
        /* A device action's pane stopping closes its pair FIRST, and it is checked before the game
           half because a pane is one or the other and this one has already been announced. */
        if !running {
            let pending = self.devices.lock().expect("devices").remove(id);
            if let Some((_, by, fields)) = pending {
                let mut closing = fields.as_object().cloned().unwrap_or_default();
                closing.insert("exitCode".to_string(), session.get("exitCode").cloned().unwrap_or(Value::Null));
                return Says::Ended { kind: "device-action.ended", by, fields: Value::Object(closing) };
            }
        }
        let open = self.open.lock().expect("open").get(id).cloned();
        /* A pane this worker never announced and is not a game is nothing to do with the feed —
           which is what makes "no PTY output on the feed" structural rather than a filter. */
        if open.is_none() && session.get("type").and_then(Value::as_str) != Some("game") {
            return Says::Nothing;
        }
        match (running, open) {
            (true, None) => {
                let root_id = session.get("rootId").and_then(Value::as_str).unwrap_or_default().to_string();
                let by = self
                    .of_session
                    .lock()
                    .expect("sessions")
                    .get(id)
                    .cloned()
                    .or_else(|| self.next(&root_id, now))
                    .unwrap_or_else(|| json!({ "kind": "workspace" }));
                let record = Open {
                    root_id: root_id.clone(),
                    game_id: session.get("game").cloned().unwrap_or(Value::Null),
                    surface: session.get("surface").cloned().unwrap_or(Value::Null),
                    args: session.get("args").cloned().unwrap_or_else(|| json!([])),
                    by: by.clone(),
                };
                self.open.lock().expect("open").insert(id.to_string(), record.clone());
                Says::Started {
                    kind: "game.started",
                    by,
                    fields: json!({ "sessionId": id, "gameId": record.game_id, "surface": record.surface, "args": record.args }),
                }
            }
            (false, Some(open)) => {
                self.open.lock().expect("open").remove(id);
                self.of_session.lock().expect("sessions").remove(id);
                Says::Ended {
                    kind: "game.ended",
                    by: open.by.clone(),
                    fields: json!({
                        "sessionId": id,
                        "gameId": open.game_id,
                        "surface": open.surface,
                        "args": open.args,
                        "exitCode": session.get("exitCode").cloned().unwrap_or(Value::Null),
                    }),
                }
            }
            _ => Says::Nothing,
        }
    }

    /// The root an open game belongs to, for a frame that has to be minted somewhere.
    pub fn root_of(&self, session_id: &str, session: &Value) -> String {
        session
            .get("rootId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| self.open.lock().expect("open").get(session_id).map(|open| open.root_id.clone()))
            .or_else(|| self.devices.lock().expect("devices").get(session_id).map(|(root, _, _)| root.clone()))
            .unwrap_or_default()
    }

    /// Read the open pairs back out of a root's ring, so a REPLACED worker inherits them.
    ///
    /// Without this the `ended` half of a game that was running when the worker was replaced never
    /// lands, and a monitor is left with a session that started and never stopped.
    pub fn inherit(&self, frames: &[Value]) {
        let mut open = self.open.lock().expect("open");
        let mut devices = self.devices.lock().expect("devices");
        for frame in frames {
            let Some(id) = frame.get("sessionId").and_then(Value::as_str) else { continue };
            match frame.get("type").and_then(Value::as_str) {
                Some("device-action.started") => {
                    devices.insert(
                        id.to_string(),
                        (
                            frame.get("rootId").and_then(Value::as_str).unwrap_or_default().to_string(),
                            frame.get("by").cloned().unwrap_or_else(|| json!({ "kind": "workspace" })),
                            json!({
                                "sessionId": id,
                                "actionId": frame.get("actionId").cloned().unwrap_or(Value::Null),
                                "deviceId": frame.get("deviceId").cloned().unwrap_or(Value::Null),
                                "kind": frame.get("kind").cloned().unwrap_or(Value::Null),
                            }),
                        ),
                    );
                }
                Some("device-action.ended") => {
                    devices.remove(id);
                }
                Some("game.started") => {
                    open.insert(
                        id.to_string(),
                        Open {
                            root_id: frame.get("rootId").and_then(Value::as_str).unwrap_or_default().to_string(),
                            game_id: frame.get("gameId").cloned().unwrap_or(Value::Null),
                            surface: frame.get("surface").cloned().unwrap_or(Value::Null),
                            args: frame.get("args").cloned().unwrap_or_else(|| json!([])),
                            by: frame.get("by").cloned().unwrap_or_else(|| json!({ "kind": "workspace" })),
                        },
                    );
                }
                Some("game.ended") => {
                    open.remove(id);
                }
                _ => {}
            }
        }
    }

    /// The sessions this worker believes are open, for closing the ones that are not.
    pub fn still_open(&self) -> Vec<String> {
        let mut held: Vec<String> = self.open.lock().expect("open").keys().cloned().collect();
        held.extend(self.devices.lock().expect("devices").keys().cloned());
        held
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(name: &str) -> Value {
        json!({ "kind": "agent", "agentId": name, "label": name })
    }

    fn game(id: &str, state: &str) -> Value {
        json!({ "id": id, "rootId": "root-1", "type": "game", "state": state, "game": "nolf", "surface": "sdl", "args": ["-w"] })
    }

    /* The host announces a new session BEFORE the launch call returns, so who asked cannot be looked
       up by session id at that point. The queue is what carries the answer across that gap. */
    #[test]
    fn a_launch_is_attributed_to_whoever_asked_even_before_it_has_an_id() {
        let launches = Launches::new();
        launches.queue("root-1", &agent("one"), 1000);
        let says = launches.heard(&game("s1", "running"), 1010);
        let Says::Started { kind, by, fields } = says else { panic!("a game that started says so") };
        assert_eq!(kind, "game.started");
        assert_eq!(by, agent("one"));
        assert_eq!(fields["sessionId"], json!("s1"));
        assert_eq!(fields["gameId"], json!("nolf"));
        assert_eq!(fields["args"], json!(["-w"]));

        /* And the ending carries the same asker, read back from the open pair. */
        let Says::Ended { kind, by, fields } = launches.heard(&json!({ "id": "s1", "rootId": "root-1", "state": "exited", "exitCode": 0 }), 2000)
        else {
            panic!("a game that ended says so")
        };
        assert_eq!(kind, "game.ended");
        assert_eq!(by, agent("one"), "the ending is the starter's, not the workspace's");
        assert_eq!(fields["exitCode"], json!(0));
        assert_eq!(fields["gameId"], json!("nolf"), "and it remembers what it was");
    }

    /* Oldest first, and only while fresh: a launch that failed leaves an entry behind, and it must
       never attach to an unrelated later session. */
    #[test]
    fn a_queued_asker_is_taken_in_order_and_only_while_it_is_fresh() {
        let launches = Launches::new();
        launches.queue("root-1", &agent("first"), 1_000);
        launches.queue("root-1", &agent("second"), 1_100);
        assert_eq!(launches.next("root-1", 1_200), Some(agent("first")));
        assert_eq!(launches.next("root-1", 1_200), Some(agent("second")));
        assert_eq!(launches.next("root-1", 1_200), None);

        launches.queue("root-1", &agent("stale"), 1_000);
        assert_eq!(launches.next("root-1", 1_000 + FRESH_MS), None, "ten seconds on is not this launch's asker");
        /* A root nobody launched on has nobody queued. */
        assert_eq!(launches.next("root-2", 1_000), None);
    }

    /* A launch the host coalesced onto a session that was ALREADY running is not a new one: the
       asker takes its own entry back rather than leaving it to attach to somebody else's. */
    #[test]
    fn a_launch_that_joined_a_running_game_takes_its_queue_entry_back() {
        let launches = Launches::new();
        launches.queue("root-1", &agent("joiner"), 1_000);
        launches.landed("root-1", "s1", &agent("joiner"), true, 1_010);
        assert_eq!(launches.next("root-1", 1_020), None, "nothing is left over to mis-attribute");

        /* And a genuine launch leaves its entry for the announcement that has not arrived yet. */
        let other = Launches::new();
        other.queue("root-1", &agent("starter"), 1_000);
        other.landed("root-1", "s2", &agent("starter"), false, 1_010);
        assert_eq!(other.next("root-1", 1_020), Some(agent("starter")));
    }

    /* A pane this worker never announced and is not a game is nothing to do with the feed. That is
       what makes "no PTY output on the feed" structural rather than a filter somebody can forget. */
    #[test]
    fn a_terminal_is_not_a_game_and_says_nothing() {
        let launches = Launches::new();
        assert_eq!(launches.heard(&json!({ "id": "t1", "rootId": "root-1", "type": "terminal", "state": "running" }), 0), Says::Nothing);
        assert_eq!(launches.heard(&json!({ "id": "t1", "rootId": "root-1", "type": "terminal", "state": "exited" }), 0), Says::Nothing);
        assert_eq!(launches.heard(&json!({ "type": "game", "state": "running" }), 0), Says::Nothing, "and a session with no id is not one");
    }

    /* A `started` is never repeated and an `ended` never doubled: a monitor counts these. */
    #[test]
    fn a_game_starts_once_and_ends_once() {
        let launches = Launches::new();
        assert!(matches!(launches.heard(&game("s1", "running"), 0), Says::Started { .. }));
        assert_eq!(launches.heard(&game("s1", "running"), 0), Says::Nothing, "still running is not starting again");
        assert!(matches!(launches.heard(&game("s1", "exited"), 0), Says::Ended { .. }));
        assert_eq!(launches.heard(&game("s1", "exited"), 0), Says::Nothing, "and it only ends once");
    }

    /* A worker replaced mid-game inherits the open pairs from the ring rather than a lost map, so
       the `ended` half still lands and a monitor is not left with a game that never stopped. */
    #[test]
    fn a_replaced_worker_still_closes_the_games_its_predecessor_opened() {
        let launches = Launches::new();
        launches.inherit(&[
            json!({ "type": "game.started", "sessionId": "s1", "rootId": "root-1", "gameId": "nolf", "surface": "sdl", "args": ["-w"], "by": agent("one") }),
            json!({ "type": "game.started", "sessionId": "s2", "rootId": "root-1", "gameId": "vtmb" }),
            json!({ "type": "game.ended", "sessionId": "s2" }),
            json!({ "type": "token.taken", "sessionId": "s3" }),
        ]);
        let mut still = launches.still_open();
        still.sort();
        assert_eq!(still, vec!["s1".to_string()], "one open, one already closed, and one that is not a game");

        let Says::Ended { by, fields, .. } = launches.heard(&json!({ "id": "s1", "rootId": "root-1", "state": "exited", "exitCode": 3 }), 0)
        else {
            panic!("the inherited game still ends")
        };
        assert_eq!(by, agent("one"), "attributed to whoever started it, a worker ago");
        assert_eq!(fields["gameId"], json!("nolf"));
        assert_eq!(fields["exitCode"], json!(3));
    }

    /* The other pair on the same stream: the owner's "deploying to the box", named generally — any
       action whose declared device is not this machine. Its session bounds the pair, and the pair is
       how a person sees a deploy start and stop. */
    #[test]
    fn a_device_bound_action_is_a_pair_too_and_says_which_one_it_is() {
        let launches = Launches::new();
        let fields = json!({ "sessionId": "d1", "actionId": "deploy", "deviceId": "box", "kind": "adb" });
        launches.device_action("d1", "root-1", &agent("one"), &fields);
        /* It is already announced when it is registered, so a running transition says nothing. */
        assert_eq!(launches.heard(&json!({ "id": "d1", "rootId": "root-1", "type": "terminal", "state": "running" }), 0), Says::Nothing);

        let Says::Ended { kind, by, fields } = launches.heard(&json!({ "id": "d1", "rootId": "root-1", "state": "exited", "exitCode": 7 }), 0)
        else {
            panic!("the deploy ended")
        };
        assert_eq!(kind, "device-action.ended", "a deploy is not a game, and the frame says which");
        assert_eq!(by, agent("one"));
        assert_eq!(fields["actionId"], json!("deploy"));
        assert_eq!(fields["deviceId"], json!("box"));
        assert_eq!(fields["exitCode"], json!(7), "and how it went");
        /* Once. */
        assert_eq!(launches.heard(&json!({ "id": "d1", "rootId": "root-1", "state": "exited" }), 0), Says::Nothing);
    }

    /* A replaced worker inherits these the same way it inherits games: the `ended` half still lands,
       so a person is not left watching a deploy that never finished. */
    #[test]
    fn a_replaced_worker_still_closes_the_deploys_its_predecessor_opened() {
        let launches = Launches::new();
        launches.inherit(&[
            json!({ "type": "device-action.started", "sessionId": "d1", "rootId": "root-1", "actionId": "deploy", "deviceId": "box", "kind": "adb", "by": agent("one") }),
            json!({ "type": "device-action.started", "sessionId": "d2", "rootId": "root-1", "actionId": "other" }),
            json!({ "type": "device-action.ended", "sessionId": "d2" }),
        ]);
        assert_eq!(launches.still_open(), vec!["d1".to_string()]);
        /* Minted on the project the PAIR remembers: the record that arrives at the end carries no
           root, and a frame nobody can place is a frame nobody reads. Asked before the ending, which
           is when the caller asks it. */
        assert_eq!(launches.root_of("d1", &json!({ "id": "d1", "state": "exited" })), "root-1");
        let Says::Ended { kind, by, fields } = launches.heard(&json!({ "id": "d1", "state": "exited", "exitCode": 0 }), 0)
        else {
            panic!("the inherited deploy still ends")
        };
        assert_eq!(kind, "device-action.ended");
        assert_eq!(by, agent("one"), "attributed to whoever asked, a worker ago");
        assert_eq!(fields["deviceId"], json!("box"));
    }

    /* An ending whose session record no longer says which project it was in is still minted, on the
       project the open pair remembers — a frame nobody can place is a frame nobody reads. */
    #[test]
    fn an_ending_is_minted_on_the_project_the_open_pair_remembers() {
        let launches = Launches::new();
        launches.queue("root-1", &agent("one"), 0);
        launches.heard(&game("s1", "running"), 0);
        assert_eq!(launches.root_of("s1", &json!({ "id": "s1", "state": "exited" })), "root-1");
        assert_eq!(launches.root_of("s1", &game("s1", "exited")), "root-1", "and the record's own when it has one");
    }
}
