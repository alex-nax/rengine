//! The token service (F157, spec 132): the project token ledger and its lifecycle feed as one
//! process per state directory.
//!
//!   red-token-serve --state <state-dir>
//!
//! Not a one-shot binary, and not a thin client's answering machine, for three reasons the other
//! ports did not have: the feed keeps its ring in memory and rewrites it whole (a second writer
//! would hand a monitor a sequence it had already seen), the ring has two producers already — the
//! ledger's own token frames and the worker's `task.added`/`agent.spawned` — and a desktop learns a
//! contest resolved because something PUSHED, not because it asked.
//!
//! So: `red_core::service`'s machinery — descriptor, attach handshake, idle reaper — with the
//! dispatch and the pushes here. Every frame goes out to every attached client as
//! `{event: "frame", rootId, frame, status}`, which is both halves of what the JS kept separately
//! (`feed.subscribe` and `ledger.watch`), because they always fired together.
//!
//! Liveness is this process's own question: a holder's pid is tested with `kill(pid, 0)`, the same
//! test `launcher/sidecar.mjs` makes, rather than carried across the socket by a caller that cannot
//! send a function.

use std::collections::HashSet;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use red_core::service::{Emitter, Served};
use red_token::ledger::FromDesktop;
use red_token::tokens::Tokens;
use red_token::{uuid_v4, Identity, Refused};
use serde_json::{json, Value};

/// `process.kill(pid, 0)`: alive, or alive-but-not-ours, is alive.
fn alive(pid: i64) -> bool {
    if pid < 1 || pid > i64::from(i32::MAX) {
        return false;
    }
    #[cfg(unix)]
    {
        let answered = unsafe { libc::kill(pid as libc::pid_t, 0) };
        answered == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        /* No process table question here yet: a holder is then never read as gone, which is the
           conservative half — the token stays with whoever took it until they release it or the
           person at the desktop revokes it. */
        true
    }
}

struct Shared {
    tokens: Mutex<Tokens>,
    /// The roots whose pushes are already wired. A ledger is opened lazily, so this is where the
    /// subscription is attached — once, however many times the root is asked for.
    wired: Mutex<HashSet<String>>,
    listeners: Arc<Mutex<Option<Emitter>>>,
}

fn identity(value: Option<&Value>) -> Option<Identity> {
    value.filter(|value| !value.is_null()).and_then(Identity::from_value)
}

impl Shared {
    /// The ledger for `root_id`, with its pushes wired the first time it is opened.
    fn with<T>(&self, root_id: &str, act: impl FnOnce(&mut red_token::ledger::Ledger) -> T) -> Result<T, Refused> {
        let mut tokens = self.tokens.lock().expect("tokens lock");
        let ledger = tokens.ledger(root_id)?;
        let fresh = self.wired.lock().expect("wired lock").insert(root_id.to_string());
        if fresh {
            let listeners = self.listeners.clone();
            let named = root_id.to_string();
            /* The frame and the status a frame leaves go out together, because the JS emitted them
               together: `feed.subscribe` fed the /feed socket and `ledger.watch` fed the desktop's
               status segment, and both fired inside `frame()`. */
            ledger.watch(Arc::new(move |status: &Value| {
                let event = json!({ "event": "status", "rootId": named, "status": status });
                if let Some(emitter) = listeners.lock().expect("listener lock").as_ref() {
                    emitter.say(&event);
                }
            }));
            let listeners = self.listeners.clone();
            let named = root_id.to_string();
            ledger.feed.subscribe(Arc::new(move |frame: &Value| {
                let event = json!({ "event": "frame", "rootId": named, "frame": frame });
                if let Some(emitter) = listeners.lock().expect("listener lock").as_ref() {
                    emitter.say(&event);
                }
            }));
        }
        Ok(act(ledger))
    }

    /* The workspace preferences, pushed rather than polled: a client reads the window inside a
       response it builds synchronously, and a round trip there would be a round trip per request.
       Pushed on every change means a second host that changed it is not a stale copy for long. */
    fn announce_preferences(&self) {
        let event = json!({ "event": "preferences", "preferences": self.tokens.lock().expect("tokens lock").preferences() });
        if let Some(emitter) = self.listeners.lock().expect("listener lock").as_ref() {
            emitter.say(&event);
        }
    }

    fn dispatch(&self, method: &str, args: &Value) -> Result<Value, Refused> {
        let arg = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
        let text = |index: usize| args.get(index).and_then(Value::as_str).unwrap_or_default().to_string();
        match method {
            /* The workspace's own two, which are not a root's. */
            "window" => Ok(json!(self.tokens.lock().expect("tokens lock").window())),
            "preferences" => Ok(self.tokens.lock().expect("tokens lock").preferences()),
            "setWindow" => {
                let answer = self.tokens.lock().expect("tokens lock").set_window(arg(0).as_i64())?;
                self.announce_preferences();
                Ok(answer)
            }
            "bumpGeneration" => {
                let next = self.tokens.lock().expect("tokens lock").bump_generation();
                self.announce_preferences();
                Ok(json!(next))
            }
            _ => {
                let root_id = text(0);
                match method {
                    "status" => self.with(&root_id, |ledger| ledger.status(identity(args.get(1)).as_ref())),
                    "settle" => self.with(&root_id, |ledger| json!(ledger.settle())),
                    "seen" => self.with(&root_id, |ledger| {
                        ledger.seen(identity(args.get(1)).as_ref());
                        Value::Null
                    }),
                    "persist" => self.with(&root_id, |ledger| {
                        ledger.persist();
                        Value::Null
                    }),
                    "refusal" => self.with(&root_id, |ledger| {
                        json!(ledger.refusal(identity(args.get(1)).as_ref(), args.get(2).and_then(Value::as_str)))
                    }),
                    "segment" => self.with(&root_id, |ledger| ledger.segment()),
                    /* What `worker.mjs`'s gate does, in one call rather than four: settle, note the
                       caller, ask for the refusal, persist. Four round trips would also be four
                       chances for another client to move the ledger between them. */
                    "gate" => self.with(&root_id, |ledger| {
                        ledger.settle();
                        let caller = identity(args.get(1));
                        ledger.seen(caller.as_ref());
                        let refusal = ledger.refusal(caller.as_ref(), args.get(2).and_then(Value::as_str));
                        ledger.persist();
                        json!({ "refusal": refusal })
                    }),
                    /* The status a caller actually sees: the settle and the note that precede every
                       answer the worker gives, and the refusal beside it. */
                    "callerStatus" => self.with(&root_id, |ledger| {
                        ledger.settle();
                        let caller = identity(args.get(1));
                        if caller.is_some() {
                            ledger.seen(caller.as_ref());
                            ledger.persist();
                        }
                        json!({
                            "status": ledger.status(caller.as_ref()),
                            "refusal": ledger.refusal(caller.as_ref(), args.get(2).and_then(Value::as_str)),
                        })
                    }),
                    "frame" => {
                        let answer = self.with(&root_id, |ledger| ledger.frame(&text(1), &arg(2), &arg(3)))?;
                        answer.map_err(|message| red_token::refuse(message, 400))
                    }
                    "feedAfter" => self.with(&root_id, |ledger| {
                        let limit = args.get(2).and_then(Value::as_u64).unwrap_or(ledger.feed.limit as u64) as usize;
                        ledger.feed.after(args.get(1).and_then(Value::as_i64).unwrap_or(0), limit.min(ledger.feed.limit))
                    }),
                    "contest" | "reject" | "release" => {
                        let Some(caller) = identity(args.get(1)) else {
                            return Err(red_token::refuse("Only an identified agent can act on the token.", 403));
                        };
                        let reason = args.get(2).and_then(Value::as_str).unwrap_or("").to_string();
                        self.with(&root_id, move |ledger| match method {
                            "contest" => ledger.contest(&caller, &reason),
                            "reject" => ledger.reject(&caller, &reason),
                            _ => ledger.release(&caller),
                        })?
                    }
                    "desktop" => {
                        let options = arg(2);
                        let request = FromDesktop {
                            contest_id: options.get("contestId").and_then(Value::as_str).map(str::to_string),
                            desktop_id: options.get("desktopId").and_then(Value::as_str).map(str::to_string),
                            reason: options.get("reason").and_then(Value::as_str).unwrap_or("").to_string(),
                            agent_id: options.get("agentId").and_then(Value::as_str).map(str::to_string),
                            /* The conversation the caller found for an assign: `lookup` was a
                               function the worker handed in, and a function does not cross a
                               socket, so what it would have answered comes with the request. */
                            lookup: options.get("lookup").cloned().filter(|value| !value.is_null()),
                        };
                        let action = text(1);
                        self.with(&root_id, move |ledger| ledger.desktop(&action, &request))?
                    }
                    other => Err(red_token::refuse(format!("Unknown token method {other}."), 400)),
                }
            }
        }
    }
}

impl Served for Shared {
    fn answer(&self, request: &Value) -> Value {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let args = request.get("args").cloned().unwrap_or_else(|| json!([]));
        match self.dispatch(method, &args) {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(refused) => json!({
                "id": id,
                "error": { "message": refused.message, "status": refused.status.map_or(Value::Null, |status| json!(status)) },
            }),
        }
    }

    /// The ledgers are on disk. A reaped service costs the next attach a file read — and the
    /// deadline it was waiting on is an absolute wall time the next call settles from the file,
    /// which is exactly what the JavaScript's "the timer is only an optimisation" meant.
    fn holding(&self) -> bool {
        false
    }

    fn greeting(&self) -> Value {
        json!({ "preferences": self.tokens.lock().expect("tokens lock").preferences() })
    }
}

/// The timer, as a sweep rather than one `setTimeout` per contest: a deadline that passes while
/// nobody is calling still resolves, and still pushes, so a desktop watching a contest sees it
/// transfer without asking. Every call settles first regardless, so this is the optimisation the
/// JavaScript said it was and never the thing correctness rests on.
fn settle_when_deadlines_pass(shared: Arc<Shared>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(250));
        let roots = shared.tokens.lock().expect("tokens lock").opened();
        for root in roots {
            let _ = shared.with(&root, |ledger| ledger.settle());
        }
    });
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let (Some(flag), Some(directory)) = (argv.first(), argv.get(1)) else {
        eprintln!("usage: red-token-serve --state <state-dir>");
        return ExitCode::from(2);
    };
    if flag != "--state" {
        eprintln!("usage: red-token-serve --state <state-dir>");
        return ExitCode::from(2);
    }
    let path = std::path::Path::new(directory);
    let tokens = match Tokens::open(path, Arc::new(alive), Arc::new(now_millis), Arc::new(uuid_v4)) {
        Ok(tokens) => tokens,
        Err(message) => {
            eprintln!("red-token-serve: {message}");
            return ExitCode::from(1);
        }
    };
    let listeners: Arc<Mutex<Option<Emitter>>> = Arc::new(Mutex::new(None));
    let shared = Arc::new(Shared { tokens: Mutex::new(tokens), wired: Mutex::new(HashSet::new()), listeners: listeners.clone() });
    settle_when_deadlines_pass(shared.clone());
    let idle = Duration::from_secs(std::env::var("RED_TOKEN_IDLE_SECONDS").ok().and_then(|value| value.parse().ok()).unwrap_or(600));
    match red_core::service::serve(path, "token", 1, idle, Held(shared), |emitter| {
        *listeners.lock().expect("listener lock") = Some(emitter);
    }) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("red-token-serve: {message}");
            ExitCode::from(3)
        }
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|since| since.as_millis() as i64).unwrap_or(0)
}

/// `serve` takes the value; the sweep thread already holds an `Arc`, so this is the wrapper that
/// lets both point at one `Shared`.
struct Held(Arc<Shared>);

impl Served for Held {
    fn answer(&self, request: &Value) -> Value {
        self.0.answer(request)
    }
    fn holding(&self) -> bool {
        self.0.holding()
    }
    fn greeting(&self) -> Value {
        self.0.greeting()
    }
}
