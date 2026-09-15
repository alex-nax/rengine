//! The lifecycle feed, served to whoever is watching (F158, spec 129; specs 095/101/103).
//!
//! The feed itself — the ring, the sequence, the frames — is `red_token::feed`'s and has been since
//! F157. What is here is the half `runtime/worker.mjs` owned: handing a watcher the frames it has
//! not seen, and then the ones that happen next.
//!
//! **A cursor, not a subscription.** A watcher says the sequence it last read and is sent everything
//! after it before anything live arrives. That ordering is the whole contract: a watcher that
//! subscribed first and replayed second would see a frame twice, and one that replayed first
//! without holding the subscription would miss whatever happened in between. So the subscription is
//! taken BEFORE the replay and the replay is de-duplicated against it.
//!
//! **A watcher that cannot keep up is closed, not buffered.** A megabyte behind and the socket is
//! closed with the sequence it should reopen from — the JS worker's own rule. A feed that queued
//! without bound would hold the whole ring for a client that has gone away, and the frames are
//! small enough that a megabyte means the client is not reading at all.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

/// A megabyte of frames a watcher has not taken. The JS worker read `bufferedAmount` for this and
/// closed at the same figure.
pub const BEHIND_LIMIT: usize = 1024 * 1024;

/// What a watcher is told when its socket closes, and why.
#[derive(Debug, Clone, PartialEq)]
pub enum Close {
    /// Too far behind: reopen from the last sequence actually read.
    Behind,
    /// This worker has been retired; the watcher re-reads `feed_url` and resumes from its cursor.
    Retired,
    /// Something this worker could not do, said in its own words.
    Refused(String),
}

impl Close {
    /// The code and the sentence, which a monitor reads and acts on.
    pub fn frame(&self) -> (u16, String) {
        match self {
            Close::Behind => (1013, "Reopen the feed with the last sequence you read".to_string()),
            Close::Retired => (
                1011,
                "Workspace worker retired; re-read feed_url and resume from your cursor".to_string(),
            ),
            /* Truncated at 100 as the JavaScript truncated it: a close reason is a header field and
               a long one is refused by the protocol rather than delivered. */
            Close::Refused(why) => (1011, why.chars().take(100).collect()),
        }
    }
}

/// One watcher's end of the feed: a queue, and how far behind it has fallen.
pub struct Watcher {
    out: UnboundedSender<String>,
    queued: Arc<AtomicUsize>,
    /// The highest sequence this watcher has been sent, so a replay and a live frame cannot
    /// deliver the same one twice.
    delivered: std::sync::Mutex<i64>,
}

impl Watcher {
    pub fn new(out: UnboundedSender<String>, queued: Arc<AtomicUsize>, cursor: i64) -> Watcher {
        Watcher { out, queued, delivered: std::sync::Mutex::new(cursor) }
    }

    /// Send one frame, unless this watcher has already had it or has fallen too far behind.
    ///
    /// `Err(Close::Behind)` is the caller's signal to close: a watcher that is not reading is not
    /// one to keep frames for.
    pub fn send(&self, frame: &Value) -> Result<(), Close> {
        if self.queued.load(Ordering::SeqCst) > BEHIND_LIMIT {
            return Err(Close::Behind);
        }
        let sequence = frame.get("sequence").and_then(Value::as_i64).unwrap_or(0);
        {
            /* The de-duplication the ordering needs: the subscription is live while the replay is
               still going, so a frame that arrives both ways is sent once. */
            let mut delivered = self.delivered.lock().expect("delivered");
            if sequence <= *delivered {
                return Ok(());
            }
            *delivered = sequence;
        }
        let text = frame.to_string();
        self.queued.fetch_add(text.len(), Ordering::SeqCst);
        let _ = self.out.send(text);
        Ok(())
    }
}

/// Everyone watching a feed, and the root each is watching.
///
/// The ledger pushes one stream of events for the whole state directory; a watcher asked about ONE
/// root. So the fan-out filters by root — a watcher handed another project's frames would show a
/// monitor events from a workspace it is not looking at.
#[derive(Default)]
pub struct Watchers {
    watching: std::sync::Mutex<Vec<(u64, String, Arc<Watcher>)>>,
    next: std::sync::atomic::AtomicU64,
}

impl Watchers {
    pub fn join(&self, root: &str, watcher: Arc<Watcher>) -> u64 {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        self.watching.lock().expect("watchers").push((id, root.to_string(), watcher));
        id
    }

    pub fn leave(&self, id: u64) {
        self.watching.lock().expect("watchers").retain(|(held, _, _)| *held != id);
    }

    /// One event from the ledger. Anything that is not a frame is not a feed frame — the ledger
    /// pushes status and preferences over the same stream — and a watcher is told only about the
    /// root it asked for.
    ///
    /// Returns the watchers that have fallen too far behind, for the caller to close: closing them
    /// here would mean holding the lock across a socket write.
    pub fn deliver(&self, event: &Value) -> Vec<u64> {
        if event.get("event").and_then(Value::as_str) != Some("frame") {
            return Vec::new();
        }
        let Some(frame) = event.get("frame") else { return Vec::new() };
        let root = event.get("rootId").and_then(Value::as_str).unwrap_or_default();
        let watching = self.watching.lock().expect("watchers");
        watching
            .iter()
            .filter(|(_, watched, _)| watched == root)
            .filter_map(|(id, _, watcher)| watcher.send(frame).is_err().then_some(*id))
            .collect()
    }
}

/// A cursor a watcher asked for. Anything that is not a whole number is 0 — the JavaScript read it
/// with `Number(...)` and fell back to 0 for a value it could not use, which means "everything".
pub fn cursor_of(asked: Option<&str>) -> i64 {
    asked.and_then(|value| value.parse::<i64>().ok()).filter(|value| *value >= 0).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::sync::mpsc::unbounded_channel;

    fn watcher(cursor: i64) -> (Watcher, Arc<AtomicUsize>, tokio::sync::mpsc::UnboundedReceiver<String>) {
        let (out, receiver) = unbounded_channel();
        let queued = Arc::new(AtomicUsize::new(0));
        (Watcher::new(out, queued.clone(), cursor), queued, receiver)
    }

    fn frame(sequence: i64) -> Value {
        json!({ "sequence": sequence, "type": "token.taken" })
    }

    fn sequences(receiver: &mut tokio::sync::mpsc::UnboundedReceiver<String>) -> Vec<i64> {
        let mut seen = Vec::new();
        while let Ok(text) = receiver.try_recv() {
            let value: Value = serde_json::from_str(&text).expect("a frame");
            seen.push(value["sequence"].as_i64().expect("a sequence"));
        }
        seen
    }

    /* THE ordering contract. The subscription is taken before the replay, so a frame can arrive
       both ways; a watcher that sent both would show the same event twice in a monitor. */
    #[test]
    fn a_frame_that_arrives_twice_is_sent_once() {
        let (watcher, _queued, mut receiver) = watcher(0);
        for sequence in [1, 2, 3] {
            watcher.send(&frame(sequence)).expect("sent");
        }
        /* The replay catching up over the same frames the subscription already delivered. */
        for sequence in [1, 2, 3, 4] {
            watcher.send(&frame(sequence)).expect("sent");
        }
        assert_eq!(sequences(&mut receiver), vec![1, 2, 3, 4]);
    }

    #[test]
    fn a_watcher_is_sent_nothing_it_had_before_its_cursor() {
        let (watcher, _queued, mut receiver) = watcher(2);
        for sequence in [1, 2, 3] {
            watcher.send(&frame(sequence)).expect("sent");
        }
        assert_eq!(sequences(&mut receiver), vec![3], "everything after the cursor, and only that");
    }

    /* A megabyte behind is a client that is not reading. Closing it with the sequence to reopen
       from is what lets it come back without a gap. */
    #[test]
    fn a_watcher_too_far_behind_is_closed_with_the_way_back() {
        let (watcher, queued, _receiver) = watcher(0);
        watcher.send(&frame(1)).expect("the first frame goes");
        queued.store(BEHIND_LIMIT + 1, Ordering::SeqCst);
        assert_eq!(watcher.send(&frame(2)), Err(Close::Behind));
        let (code, reason) = Close::Behind.frame();
        assert_eq!(code, 1013);
        assert!(reason.contains("last sequence you read"), "{reason}");
    }

    /* The retired sentence is READ BY A MONITOR, which re-reads feed_url and resumes: it is a
       contract, not a log line, so it is named once and asserted here. */
    #[test]
    fn a_retired_worker_tells_its_watchers_how_to_find_the_next_one() {
        let (code, reason) = Close::Retired.frame();
        assert_eq!(code, 1011);
        assert_eq!(reason, "Workspace worker retired; re-read feed_url and resume from your cursor");
    }

    #[test]
    fn a_refusal_is_the_workers_own_words_and_fits_in_a_close_frame() {
        let (code, reason) = Close::Refused("This workspace worker does not serve the project token ledger.".into()).frame();
        assert_eq!(code, 1011);
        assert_eq!(reason, "This workspace worker does not serve the project token ledger.");
        let long = Close::Refused("x".repeat(300)).frame().1;
        assert_eq!(long.chars().count(), 100, "a close reason is a header field, not a paragraph");
    }

    /* The fan-out's two rules, and both matter to a person: a monitor shown another project's
       frames is showing a workspace nobody is looking at, and one shown a status where it expects a
       frame has to guess what it is reading. */
    #[test]
    fn a_watcher_is_told_about_its_own_root_and_only_about_frames() {
        let watchers = Watchers::default();
        let (mine, _q1, mut receiver) = watcher(0);
        let (theirs, _q2, mut other) = watcher(0);
        watchers.join("root-1", Arc::new(mine));
        watchers.join("root-2", Arc::new(theirs));

        assert!(watchers.deliver(&json!({ "event": "frame", "rootId": "root-1", "frame": frame(1) })).is_empty());
        assert_eq!(sequences(&mut receiver), vec![1]);
        assert_eq!(sequences(&mut other), Vec::<i64>::new(), "another project's frames are not this watcher's");

        /* The ledger pushes status and preferences over the same stream; neither is a feed frame. */
        watchers.deliver(&json!({ "event": "status", "rootId": "root-1", "status": {} }));
        watchers.deliver(&json!({ "event": "preferences", "preferences": {} }));
        assert_eq!(sequences(&mut receiver), Vec::<i64>::new(), "only frames reach a feed");

        /* And the case the EVENT NAME is checked for, rather than the field: an event that carries
           a frame without being one. Nothing emits this today, which is exactly why the rule needs
           a case — the guard reads as redundant against the three events that exist, and the next
           one to carry a `frame` would be delivered as a feed frame without it. */
        watchers.deliver(&json!({ "event": "frame.replaced", "rootId": "root-1", "frame": frame(9) }));
        assert_eq!(sequences(&mut receiver), Vec::<i64>::new(), "a frame inside another event is not a feed frame");
    }

    #[test]
    fn a_watcher_that_has_left_is_told_nothing_and_one_too_far_behind_is_named() {
        let watchers = Watchers::default();
        let (one, queued, mut receiver) = watcher(0);
        let id = watchers.join("root-1", Arc::new(one));
        queued.store(BEHIND_LIMIT + 1, Ordering::SeqCst);
        assert_eq!(watchers.deliver(&json!({ "event": "frame", "rootId": "root-1", "frame": frame(1) })), vec![id],
                   "the caller is told which to close, rather than a socket being written under the lock");
        watchers.leave(id);
        assert!(watchers.deliver(&json!({ "event": "frame", "rootId": "root-1", "frame": frame(2) })).is_empty());
        assert_eq!(sequences(&mut receiver), Vec::<i64>::new());
    }

    #[test]
    fn a_cursor_that_is_not_a_number_means_everything() {
        assert_eq!(cursor_of(Some("7")), 7);
        assert_eq!(cursor_of(None), 0);
        assert_eq!(cursor_of(Some("")), 0);
        assert_eq!(cursor_of(Some("nonsense")), 0);
        assert_eq!(cursor_of(Some("-3")), 0, "a cursor before the beginning is the beginning");
        assert_eq!(cursor_of(Some("9007199254740993")), 9007199254740993);
    }
}
