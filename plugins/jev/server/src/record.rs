//! The call record (F228, spec 151 decision 6).
//!
//! Every call is written down, and every judgement later carries **what actually happened**. The
//! first draft of spec 151 recorded question, answer, confidence and tokens — and no outcome, which
//! a cross-vendor review caught: that record measures usage, not accuracy, and the row that decides
//! adoption could not have decided anything from it.
//!
//! The record lives in the state directory with the key and never in the checkout, because it holds
//! whatever the capability sent — failure output, among other things.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::{Answer, Response};

/// What reality showed, filled in after the fact. `Undecided` is a real state and is counted as
/// itself: a judgement nobody followed up is not evidence either way, and dropping it would quietly
/// flatter whatever the tool did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Undecided,
    Accepted,
    Overridden,
    Confirmed,
    Reverted,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Undecided => "undecided",
            Outcome::Accepted => "accepted",
            Outcome::Overridden => "overridden",
            Outcome::Confirmed => "confirmed",
            Outcome::Reverted => "reverted",
        }
    }

    pub fn parse(text: &str) -> Option<Outcome> {
        Some(match text {
            "undecided" => Outcome::Undecided,
            "accepted" => Outcome::Accepted,
            "overridden" => Outcome::Overridden,
            "confirmed" => Outcome::Confirmed,
            "reverted" => Outcome::Reverted,
            _ => return None,
        })
    }
}

pub fn record_path(state_directory: &str) -> PathBuf {
    Path::new(state_directory).join("calls.jsonl")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Append one judgement. Returns the id a later outcome is attached by.
///
/// `state_hash` is what makes a repeat recognisable: the same capability asking the same question
/// about the same state inside a window is served from here rather than paid for twice, and
/// re-asking can answer differently because pinning the model does not pin decoding.
pub fn append(state_directory: &str, capability: &str, state_hash: &str,
              response: &Response) -> Result<String, String> {
    std::fs::create_dir_all(state_directory)
        .map_err(|e| format!("cannot make {state_directory}: {e}"))?;

    let id = format!("{}-{}", now_ms(), state_hash.chars().take(8).collect::<String>());
    let mut answers = serde_json::Map::new();
    for (question, answer) in &response.answers {
        answers.insert(question.clone(), match answer {
            Answer::Noul { probability } =>
                serde_json::json!({ "type": "noul", "noul": probability }),
            Answer::Choice { choice, confidence, probabilities } => serde_json::json!({
                "type": "choice", "choice": choice, "confidence": confidence,
                "probabilities": probabilities, "margin": answer.margin() }),
            Answer::Score { score, confidence, probabilities } => serde_json::json!({
                "type": "score", "score": score, "confidence": confidence,
                "probabilities": probabilities, "margin": answer.margin() }),
        });
    }

    let row = serde_json::json!({
        "id": id,
        "at": now_ms(),
        "capability": capability,
        "stateHash": state_hash,
        // The versioned id that ANSWERED, not the alias that was asked for: an alias moves and a
        // threshold tuned against one model must be attributable to it.
        "model": response.model,
        "inputTokens": response.input_tokens,
        "answers": answers,
        "outcome": Outcome::Undecided.as_str(),
    });

    let mut file = std::fs::OpenOptions::new().create(true).append(true)
        .open(record_path(state_directory))
        .map_err(|e| format!("cannot open the Jev record: {e}"))?;
    writeln!(file, "{row}").map_err(|e| format!("cannot write the Jev record: {e}"))?;
    Ok(id)
}

/// Every recorded judgement, oldest first. A malformed line is skipped rather than fatal: a record
/// with one bad row is still the evidence for every other row.
pub fn rows(state_directory: &str) -> Vec<serde_json::Value> {
    let Ok(text) = std::fs::read_to_string(record_path(state_directory)) else { return Vec::new() };
    text.lines().filter_map(|line| serde_json::from_str(line).ok()).collect()
}

/// Attach what actually happened to a judgement already recorded.
pub fn settle(state_directory: &str, id: &str, outcome: Outcome) -> Result<(), String> {
    let mut found = false;
    let mut out = String::new();
    for mut row in rows(state_directory) {
        if row.get("id").and_then(|i| i.as_str()) == Some(id) {
            row["outcome"] = serde_json::Value::String(outcome.as_str().to_string());
            row["settledAt"] = serde_json::json!(now_ms());
            found = true;
        }
        out.push_str(&row.to_string());
        out.push('\n');
    }
    if !found {
        return Err(format!("no recorded judgement {id}"));
    }
    std::fs::write(record_path(state_directory), out)
        .map_err(|e| format!("cannot rewrite the Jev record: {e}"))
}

/// What the adoption row reads (F231). Counts by outcome, so "how often was it overridden" is
/// answerable — which is the question the first draft of this record could not answer at all.
pub fn tally(state_directory: &str) -> BTreeMap<String, u64> {
    let mut counts: BTreeMap<String, u64> = BTreeMap::new();
    for row in rows(state_directory) {
        let outcome = row.get("outcome").and_then(|o| o.as_str()).unwrap_or("undecided");
        *counts.entry(outcome.to_string()).or_default() += 1;
        *counts.entry("calls".to_string()).or_default() += 1;
        if let Some(tokens) = row.get("inputTokens").and_then(|t| t.as_u64()) {
            *counts.entry("inputTokens".to_string()).or_default() += tokens;
        }
    }
    counts
}

/// A stable, cheap digest of what was sent, for recognising a repeat. FNV-1a: this identifies a
/// question already asked, it does not protect anything.
pub fn state_hash(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Answer;

    fn temp() -> String {
        let directory = std::env::temp_dir()
            .join(format!("rengine-jev-record-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("temp");
        directory.to_str().expect("utf8").to_string()
    }

    fn response() -> Response {
        Response {
            answers: BTreeMap::from([
                ("flaky".to_string(), Answer::Noul { probability: 0.91 }),
                ("verdict".to_string(), Answer::Choice {
                    choice: "treat_as_flake".into(), confidence: 0.74,
                    probabilities: BTreeMap::from([("treat_as_flake".into(), 0.82),
                                                   ("rerun".into(), 0.16)]),
                }),
            ]),
            model: "jev-1.13.0".to_string(),
            input_tokens: 474,
        }
    }

    #[test]
    fn a_judgement_starts_undecided_and_is_settled_later() {
        let directory = temp();
        let id = append(&directory, "triage", &state_hash("a failure"), &response()).expect("append");

        let recorded = rows(&directory);
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0]["outcome"], "undecided", "a fresh judgement has no outcome yet");
        assert_eq!(recorded[0]["model"], "jev-1.13.0", "the id that answered, not the alias");
        assert_eq!(recorded[0]["inputTokens"], 474);
        // The margin is stored beside the vendor's scalar, because the margin is what gets gated.
        assert!((recorded[0]["answers"]["verdict"]["margin"].as_f64().expect("margin") - 0.66).abs() < 1e-9);
        assert_eq!(recorded[0]["answers"]["verdict"]["confidence"], 0.74);

        settle(&directory, &id, Outcome::Confirmed).expect("settle");
        let settled = rows(&directory);
        assert_eq!(settled[0]["outcome"], "confirmed");
        assert!(settled[0]["settledAt"].is_number());
    }

    #[test]
    fn settling_an_unknown_judgement_is_refused_by_name() {
        let directory = temp();
        append(&directory, "triage", "hash", &response()).expect("append");
        let error = settle(&directory, "not-a-real-id", Outcome::Accepted).expect_err("refused");
        assert!(error.contains("not-a-real-id"), "{error}");
    }

    #[test]
    fn the_tally_answers_how_often_it_was_overridden() {
        let directory = temp();
        let first = append(&directory, "triage", "one", &response()).expect("append");
        let second = append(&directory, "triage", "two", &response()).expect("append");
        append(&directory, "triage", "three", &response()).expect("append");
        settle(&directory, &first, Outcome::Confirmed).expect("settle");
        settle(&directory, &second, Outcome::Overridden).expect("settle");

        let counts = tally(&directory);
        assert_eq!(counts["calls"], 3);
        assert_eq!(counts["confirmed"], 1);
        assert_eq!(counts["overridden"], 1);
        // The one nobody followed up is counted as itself rather than dropped.
        assert_eq!(counts["undecided"], 1);
        assert_eq!(counts["inputTokens"], 474 * 3);
    }

    #[test]
    fn the_same_state_hashes_the_same_and_a_different_one_does_not() {
        assert_eq!(state_hash("a failure"), state_hash("a failure"));
        assert_ne!(state_hash("a failure"), state_hash("a different failure"));
    }

    #[test]
    fn a_malformed_line_does_not_lose_the_rest_of_the_record() {
        let directory = temp();
        append(&directory, "triage", "one", &response()).expect("append");
        let mut file = std::fs::OpenOptions::new().append(true)
            .open(record_path(&directory)).expect("open");
        writeln!(file, "{{ this is not json").expect("write");
        append(&directory, "triage", "two", &response()).expect("append");
        assert_eq!(rows(&directory).len(), 2, "the two good rows survive the bad one");
    }
}
