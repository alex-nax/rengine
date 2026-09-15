//! One child process that answers questions, a line at a time (F158, spec 129; spec 133).
//!
//! `red-ide serve` and `red-lsp-serve` speak the same shape: a request per line in, an answer per
//! line out, `{"started": true}` first, and the process ends when its stdin closes. Two things
//! travel the other way — an EVENT nobody asked for, and an ASK, which is the child needing
//! something only this process knows.
//!
//! **The ask is the reason this is not a plain command runner.** The IDE bridge answers a CLI's
//! `getDiagnostics` from the language servers, and the language servers are the worker's (spec 133,
//! D3): the bridge cannot answer without asking back, and a client that only wrote and read
//! answers would deadlock the moment a CLI asked.
//!
//! A child that dies takes every waiting caller with it, named. A caller left waiting on a process
//! that has gone is a route that never answers, which is worse than one that refuses.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

/// What the child asks back for, answered by whoever started it.
pub type Answering = Box<dyn Fn(&str, &[Value]) -> Result<Value, String> + Send + Sync>;

pub struct Pipe {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, Sender<Result<Value, String>>>>,
    /// Events the child sent that nobody has taken yet, and whoever is waiting for the next one.
    events: Mutex<Vec<Value>>,
    waiting: Mutex<Vec<Sender<Value>>>,
    sequence: AtomicU64,
    /// Set once the child says so, so a caller never writes into a process that is still starting.
    started: Mutex<Option<Receiver<()>>>,
}

impl Pipe {
    /// Start one, and read it until it goes away.
    pub fn spawn(program: &str, args: &[String], answering: Option<Answering>) -> Result<Arc<Pipe>, String> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("cannot start {program}: {error}"))?;
        let stdin = child.stdin.take().ok_or_else(|| format!("{program} has no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| format!("{program} has no stdout"))?;
        let (announced, started) = channel();
        let pipe = Arc::new(Pipe {
            stdin: Mutex::new(Some(stdin)),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            events: Mutex::new(Vec::new()),
            waiting: Mutex::new(Vec::new()),
            sequence: AtomicU64::new(0),
            started: Mutex::new(Some(started)),
        });
        let reading = pipe.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                reading.heard(&message, &answering, &announced);
            }
            /* The child is gone: everyone waiting on it is told, rather than left waiting. */
            reading.ended("the process this worker was asking answered nothing more.");
        });
        Ok(pipe)
    }

    fn heard(self: &Arc<Pipe>, message: &Value, answering: &Option<Answering>, announced: &Sender<()>) {
        if message.get("started") == Some(&Value::Bool(true)) {
            let _ = announced.send(());
            return;
        }
        if let Some(ask) = message.get("ask").and_then(Value::as_i64) {
            /* Answered on its own thread: the handler may call back into something that is itself
               waiting on a line from this child, and a reader that answered inline would be the one
               thing not reading. */
            let method = message.get("method").and_then(Value::as_str).unwrap_or_default().to_string();
            let args: Vec<Value> = message.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
            let answer = match answering {
                Some(answering) => answering(&method, &args),
                None => Err(format!("this worker cannot answer {method}.")),
            };
            let reply = match answer {
                Ok(result) => json!({ "answer": ask, "result": result }),
                Err(message) => json!({ "answer": ask, "error": { "message": message } }),
            };
            self.write(&reply);
            return;
        }
        if message.get("event").is_some() {
            let taker = self.waiting.lock().expect("waiting").pop();
            match taker {
                Some(taker) => {
                    let _ = taker.send(message.clone());
                }
                None => self.events.lock().expect("events").push(message.clone()),
            }
            return;
        }
        let Some(id) = message.get("id").and_then(Value::as_u64) else { return };
        let Some(waiting) = self.pending.lock().expect("pending").remove(&id) else { return };
        let answer = match message.get("error") {
            Some(error) => Err(error.get("message").and_then(Value::as_str).unwrap_or("the call failed.").to_string()),
            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = waiting.send(answer);
    }

    fn ended(&self, why: &str) {
        for (_, waiting) in std::mem::take(&mut *self.pending.lock().expect("pending")) {
            let _ = waiting.send(Err(why.to_string()));
        }
    }

    fn write(&self, value: &Value) {
        if let Some(stdin) = self.stdin.lock().expect("stdin").as_mut() {
            let _ = writeln!(stdin, "{value}");
            let _ = stdin.flush();
        }
    }

    /// Wait for the child to say it is up. Once, and every caller after that goes straight through.
    fn ready(&self) {
        let held = self.started.lock().expect("started").take();
        if let Some(started) = held {
            let _ = started.recv_timeout(std::time::Duration::from_secs(10));
        }
    }

    /// Ask, and wait. The answer is the child's, including its refusal.
    pub fn call(&self, method: &str, args: Value) -> Result<Value, String> {
        self.ready();
        let id = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let (answered, answer) = channel();
        self.pending.lock().expect("pending").insert(id, answered);
        self.write(&json!({ "id": id, "method": method, "args": args }));
        match answer.recv() {
            Ok(answer) => answer,
            Err(_) => Err("the process this worker was asking went away.".to_string()),
        }
    }

    /// The next thing the child says that nobody asked for. `None` if it says nothing in time.
    pub fn next_event(&self, within: std::time::Duration) -> Option<Value> {
        if let Some(held) = self.events.lock().expect("events").pop() {
            return Some(held);
        }
        let (sender, receiver) = channel();
        self.waiting.lock().expect("waiting").push(sender);
        receiver.recv_timeout(within).ok()
    }

    /// Close its stdin, which is how both of these end, and stop waiting after that.
    pub fn end(&self) {
        *self.stdin.lock().expect("stdin") = None;
        let mut child = self.child.lock().expect("child");
        for _ in 0..40 {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                Err(_) => break,
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in child: a shell that echoes a scripted line for each line it is given.
    fn scripted(script: &str) -> Arc<Pipe> {
        Pipe::spawn("/bin/bash", &["-c".to_string(), script.to_string()], None).expect("a child")
    }

    #[test]
    fn a_call_waits_for_the_answer_that_carries_its_own_id() {
        /* Answers out of order, which is the whole reason a call carries an id. */
        let pipe = scripted(
            r#"echo '{"started":true}'; read a; read b; echo '{"id":2,"result":"second"}'; echo '{"id":1,"result":"first"}'; sleep 5"#,
        );
        let one = pipe.clone();
        let first = std::thread::spawn(move || one.call("slow", json!([])));
        std::thread::sleep(std::time::Duration::from_millis(150));
        let second = pipe.call("quick", json!([]));
        assert_eq!(second, Ok(json!("second")));
        assert_eq!(first.join().expect("joined"), Ok(json!("first")));
        pipe.end();
    }

    #[test]
    fn a_refusal_is_the_childs_own_words() {
        let pipe = scripted(r#"echo '{"started":true}'; read a; echo '{"id":1,"error":{"message":"no server for that file."}}'; sleep 5"#);
        assert_eq!(pipe.call("diagnostics", json!([])), Err("no server for that file.".to_string()));
        pipe.end();
    }

    /* A caller left waiting on a process that has gone is a route that never answers, which is
       worse than one that refuses. */
    #[test]
    fn a_child_that_dies_takes_every_waiting_caller_with_it_by_name() {
        let pipe = scripted(r#"echo '{"started":true}'; read a; exit 0"#);
        let refused = pipe.call("anything", json!([])).expect_err("refused");
        assert!(refused.contains("answered nothing more") || refused.contains("went away"), "{refused}");
    }

    /* The ask: the child needing something only this process knows. Without it the bridge would
       deadlock the first time a CLI asked for diagnostics. */
    #[test]
    fn a_child_that_asks_back_is_answered_and_then_carries_on() {
        let pipe = Pipe::spawn(
            "/bin/bash",
            &["-c".to_string(),
              r#"echo '{"started":true}'; read a; echo '{"ask":7,"method":"diagnostics","args":["file:///x.rs"]}'; read answer; echo "{\"id\":1,\"result\":$answer}"; sleep 5"#.to_string()],
            Some(Box::new(|method: &str, args: &[Value]| {
                assert_eq!(method, "diagnostics");
                Ok(json!({ "asked": args[0] }))
            })),
        )
        .expect("a child");
        let answer = pipe.call("start", json!([])).expect("an answer");
        assert_eq!(answer["answer"], json!(7), "the ask was answered with its own number");
        assert_eq!(answer["result"]["asked"], json!("file:///x.rs"));
        pipe.end();
    }

    /* An event nobody asked for, which is how a retake settles. */
    #[test]
    fn an_event_waits_until_somebody_takes_it() {
        let pipe = scripted(r#"echo '{"started":true}'; echo '{"event":"published","port":1234}'; sleep 5"#);
        let event = pipe.next_event(std::time::Duration::from_secs(5)).expect("an event");
        assert_eq!(event["event"], json!("published"));
        assert_eq!(pipe.next_event(std::time::Duration::from_millis(100)), None, "and there is only the one");
        pipe.end();
    }
}
