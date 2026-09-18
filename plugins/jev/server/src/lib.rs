//! The Jev judgement client (F228, charter D74, spec 151).
//!
//! Jev answers typed questions about supplied state and returns probabilities. This crate is the
//! only thing in the tree that talks to it, and it is deliberately small: the HTTPS is
//! `red_core::tls`, which `red-project` already uses to reach a tracker, so this adds a caller and
//! not a dependency.
//!
//! Three properties are structural rather than documented:
//!
//!   1. **The shape trap cannot be written.** A Choice takes its criteria as a MAP and a Score takes
//!      an ORDERED LIST; sending the wrong one is a 422 from the service. `Question` makes the wrong
//!      one unrepresentable, so no call site rediscovers it.
//!   2. **The vendor's `confidence` scalar is recorded and never gated on.** Spec 151 watched it
//!      collapse 0.69 → 0.29 on one decision when a clause was reworded. `Answer::margin` is the
//!      distance between the top two probabilities, which is computed from data the response
//!      already carries and is what a caller gates on.
//!   3. **The key never leaves this module.** It is read from the state directory, held in one
//!      place, and `Jev` has no accessor for it — a `Debug` that could print it is not derived.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub mod record;
pub mod capability;
pub mod corpus;
pub mod gates;
pub mod runs;
pub mod flows;
pub mod registry;

/// The version that answers, pinned rather than the moving `jev-latest` alias (spec 151 decision 7):
/// thresholds tuned against one model must not be moved by someone else's release.
pub const MODEL: &str = "jev-1.13.0";
const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";

/// The state budget the service documents: 32k tokens for state plus the longest question. Counted
/// in bytes here, conservatively — state over the budget is REFUSED rather than truncated, because
/// silent truncation changes the question that was asked (spec 151 decision 11).
const STATE_BYTE_BUDGET: usize = 64 * 1024;

/// One typed question. The criteria shape is the type, which is the point: a Score cannot be handed
/// a map and a Choice cannot be handed a list.
pub enum Question {
    /// Yes/no. Returns a probability and, deliberately, no confidence.
    Noul { instructions: String, when_true: Option<String>, when_false: Option<String> },
    /// One of a set. `options` is option → description; a description may be empty.
    Choice { instructions: String, options: BTreeMap<String, String> },
    /// A position on an ordered scale. `levels` is ordered low to high and the order is the meaning.
    Score { instructions: String, levels: Vec<String> },
}

impl Question {
    fn to_json(&self) -> serde_json::Value {
        match self {
            Question::Noul { instructions, when_true, when_false } => {
                let mut q = serde_json::json!({ "type": "noul", "instructions": instructions });
                if when_true.is_some() || when_false.is_some() {
                    q["criteria"] = serde_json::json!({
                        "true": when_true.clone().unwrap_or_default(),
                        "false": when_false.clone().unwrap_or_default(),
                    });
                }
                q
            }
            Question::Choice { instructions, options } => {
                let mut map = serde_json::Map::new();
                for (option, description) in options {
                    map.insert(option.clone(), if description.is_empty() {
                        serde_json::Value::Null
                    } else {
                        serde_json::Value::String(description.clone())
                    });
                }
                serde_json::json!({ "type": "choice", "instructions": instructions, "criteria": map })
            }
            Question::Score { instructions, levels } => {
                serde_json::json!({ "type": "score", "instructions": instructions, "criteria": levels })
            }
        }
    }
}

/// One typed answer.
#[derive(Clone, Debug, PartialEq)]
pub enum Answer {
    Noul { probability: f64 },
    Choice { choice: String, confidence: f64, probabilities: BTreeMap<String, f64> },
    Score { score: f64, confidence: f64, probabilities: BTreeMap<String, f64> },
}

impl Answer {
    /// The distance between the best and second-best outcome — what a caller gates on.
    ///
    /// For a Noul there is no distribution and this is `None`: a Noul's distance from 0.5 measures
    /// how DECISIVELY the model picked a side, not how much the answer can be trusted, and a model
    /// forced to answer an ill-posed question answers extremely (spec 151 decision 5b). A Noul
    /// capability that needs a gate asks twice and requires agreement.
    pub fn margin(&self) -> Option<f64> {
        let probabilities = match self {
            Answer::Noul { .. } => return None,
            Answer::Choice { probabilities, .. } | Answer::Score { probabilities, .. } => probabilities,
        };
        let mut values: Vec<f64> = probabilities.values().copied().collect();
        values.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
        match values.len() {
            0 => None,
            1 => Some(values[0]),
            _ => Some(values[0] - values[1]),
        }
    }

    /// The vendor's own scalar, recorded for the log and never gated on. See the module note.
    pub fn reported_confidence(&self) -> Option<f64> {
        match self {
            Answer::Noul { .. } => None,
            Answer::Choice { confidence, .. } | Answer::Score { confidence, .. } => Some(*confidence),
        }
    }

    pub(crate) fn from_json(value: &serde_json::Value) -> Option<Answer> {
        let kind = value.get("type")?.as_str()?;
        let distribution = |key: &str| -> BTreeMap<String, f64> {
            value.get(key).and_then(|v| v.as_object()).map(|map| {
                map.iter().filter_map(|(k, v)| v.as_f64().map(|n| (k.clone(), n))).collect()
            }).unwrap_or_default()
        };
        match kind {
            "noul" => Some(Answer::Noul { probability: value.get("noul")?.as_f64()? }),
            "choice" => Some(Answer::Choice {
                choice: value.get("choice")?.as_str()?.to_string(),
                confidence: value.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.0),
                probabilities: distribution("probabilities"),
            }),
            "score" => Some(Answer::Score {
                score: value.get("score")?.as_f64()?,
                confidence: value.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.0),
                probabilities: distribution("probabilities"),
            }),
            _ => None,
        }
    }
}

/// What one call returned.
#[derive(Debug)]
pub struct Response {
    pub answers: BTreeMap<String, Answer>,
    pub model: String,
    pub input_tokens: u64,
}

/// Where the key lives: the state directory, beside the tracker's credentials, never the checkout.
/// `.jev` in a working tree is one `git add -A` from being published, which is how this one arrived.
pub fn key_path(state_directory: &str) -> PathBuf {
    Path::new(state_directory).join("key")
}

/// The client. Its `Debug` is written by hand and redacts: a derived one would print the key the
/// moment anyone put a client in a log line or an `expect`.
pub struct Jev {
    key: String,
    model: String,
}

impl std::fmt::Debug for Jev {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Jev").field("key", &"<redacted>").field("model", &self.model).finish()
    }
}

impl Jev {
    /// Read the declared key. A missing one is refused by name, with where to put it — and the
    /// refusal quotes the PATH, never the contents of anything.
    pub fn from_state_directory(state_directory: &str) -> Result<Jev, String> {
        let path = key_path(state_directory);
        let raw = std::fs::read_to_string(&path).map_err(|_| {
            format!("no Jev key at {}. Put the key there (one line), or leave it absent to keep Jev off.",
                    path.display())
        })?;
        Jev::from_key(raw.trim())
    }

    pub fn from_key(key: &str) -> Result<Jev, String> {
        let key = key.trim();
        // A file that still holds `apikey=...` is a common paste; take the value and say nothing
        // about it, because saying anything about a key's shape is saying something about the key.
        let key = key.split_once('=').map(|(name, value)| {
            if name.trim().eq_ignore_ascii_case("apikey") || name.trim().eq_ignore_ascii_case("typesafe_api_key") {
                value.trim()
            } else { key }
        }).unwrap_or(key);
        if key.is_empty() {
            return Err("the Jev key file is empty".to_string());
        }
        Ok(Jev { key: key.to_string(), model: MODEL.to_string() })
    }

    /// Ask one or more questions about one state. Blocking, like every other client here.
    pub fn ask(&self, state: &serde_json::Value, questions: &BTreeMap<String, Question>)
               -> Result<Response, String> {
        if questions.is_empty() {
            return Err("a Jev call with no questions asks nothing".to_string());
        }
        let mut map = serde_json::Map::new();
        for (id, question) in questions {
            map.insert(id.clone(), question.to_json());
        }
        let body = serde_json::json!({ "state": state, "model": self.model, "questions": map }).to_string();
        if body.len() > STATE_BYTE_BUDGET {
            return Err(format!(
                "this state is {} bytes, over the {} the service accepts. Refused rather than \
                 truncated: a truncated state is a different question than the one asked.",
                body.len(), STATE_BYTE_BUDGET));
        }

        let authorization = format!("Bearer {}", self.key);
        let headers = [("authorization", authorization.as_str()), ("content-type", "application/json")];

        // Three attempts, honouring retry-after. The limit is per KEY and shared with anything else
        // pointed at it, which is the lesson red-project's tracker client already wrote down.
        let mut last = String::new();
        for attempt in 0..3u32 {
            match red_core::tls::request("POST", ENDPOINT, &headers, Some(&body)) {
                Ok(answer) if answer.ok() => return Self::parse(&answer.body),
                Ok(answer) if answer.status == 429 || answer.status >= 500 => {
                    last = format!("the judge answered {}", answer.status);
                    if attempt < 2 {
                        std::thread::sleep(std::time::Duration::from_millis(400 * (1 << attempt)));
                    }
                }
                // A 4xx that is not a rate limit is this caller's fault and retrying repeats it.
                Ok(answer) => return Err(format!("the judge refused with {}: {}",
                                                 answer.status, first_line(&answer.body))),
                Err(error) => {
                    last = error;
                    if attempt < 2 {
                        std::thread::sleep(std::time::Duration::from_millis(400 * (1 << attempt)));
                    }
                }
            }
        }
        Err(format!("the judge could not be reached after three attempts: {last}"))
    }

    fn parse(body: &str) -> Result<Response, String> {
        let value: serde_json::Value = serde_json::from_str(body)
            .map_err(|error| format!("the judge's answer did not parse: {error}"))?;
        let mut answers = BTreeMap::new();
        for (id, answer) in value.get("answers").and_then(|a| a.as_object())
            .ok_or_else(|| "the judge's answer carried no answers".to_string())? {
            let parsed = Answer::from_json(answer)
                .ok_or_else(|| format!("the answer for {id} is a shape this build does not know"))?;
            answers.insert(id.clone(), parsed);
        }
        Ok(Response {
            answers,
            model: value.get("model").and_then(|m| m.as_str()).unwrap_or("unknown").to_string(),
            input_tokens: value.pointer("/usage/input_tokens").and_then(|t| t.as_u64()).unwrap_or(0),
        })
    }
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or("").chars().take(200).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_score_cannot_be_handed_a_map() {
        // This is the compile-time half of the trap: `Question::Score` has no field that accepts a
        // map, so the 422 the service returns for one cannot originate in this crate. The runtime
        // half is that the shapes it does emit are the documented ones.
        let score = Question::Score {
            instructions: "rate it".into(),
            levels: vec!["low".into(), "high".into()],
        };
        assert_eq!(score.to_json()["criteria"], serde_json::json!(["low", "high"]));
        let choice = Question::Choice {
            instructions: "pick".into(),
            options: BTreeMap::from([("a".to_string(), "first".to_string()),
                                     ("b".to_string(), String::new())]),
        };
        assert_eq!(choice.to_json()["criteria"], serde_json::json!({ "a": "first", "b": null }));
    }

    #[test]
    fn a_noul_has_no_margin_and_a_choice_does() {
        let noul = Answer::Noul { probability: 0.97 };
        assert_eq!(noul.margin(), None, "distance from 0.5 is decisiveness, not trust");
        assert_eq!(noul.reported_confidence(), None, "the service sends none for a noul");

        let choice = Answer::Choice {
            choice: "link".into(),
            confidence: 1.0,
            probabilities: BTreeMap::from([("link".into(), 0.6), ("compile".into(), 0.3),
                                           ("runtime".into(), 0.1)]),
        };
        let margin = choice.margin().expect("a choice has a distribution");
        assert!((margin - 0.3).abs() < 1e-9, "top two are 0.6 and 0.3, so the margin is 0.3");
        // The vendor's scalar says 1.0 on the same answer the distribution calls a 0.3 margin: the
        // reason spec 151 gates on one and records the other.
        assert_eq!(choice.reported_confidence(), Some(1.0));
    }

    #[test]
    fn answers_parse_from_the_shapes_the_service_returns() {
        let body = r#"{"model":"jev-1.13.0","answers":{
            "a":{"type":"noul","noul":0.91},
            "b":{"type":"choice","choice":"link","confidence":0.74,
                 "probabilities":{"link":0.82,"runtime":0.16,"compile":0.02}},
            "c":{"type":"score","score":2.0,"confidence":1.0,
                 "probabilities":{"0":0.0,"1":0.0,"2":1.0,"3":0.0}}},
            "usage":{"input_tokens":474,"output_tokens":56}}"#;
        let response = Jev::parse(body).expect("parses");
        assert_eq!(response.input_tokens, 474);
        assert_eq!(response.model, "jev-1.13.0");
        assert_eq!(response.answers["a"], Answer::Noul { probability: 0.91 });
        match &response.answers["c"] {
            Answer::Score { score, .. } => assert_eq!(*score, 2.0),
            other => panic!("expected a score, got {other:?}"),
        }
    }

    #[test]
    fn a_missing_key_is_refused_by_name_and_says_where_to_put_it() {
        let directory = std::env::temp_dir().join(format!("rengine-jev-{}", std::process::id()));
        let error = Jev::from_state_directory(directory.to_str().expect("utf8")).expect_err("no key");
        assert!(error.ends_with("keep Jev off.") && error.contains("/key"),
                "the refusal names the path: {error}");
        assert!(error.contains("keep Jev off"), "and says that absent is a valid state: {error}");
    }

    #[test]
    fn an_apikey_prefix_is_taken_off_a_pasted_key() {
        let jev = Jev::from_key("apikey=abc123").expect("accepted");
        assert_eq!(jev.key, "abc123");
        assert!(Jev::from_key("   ").is_err(), "an empty key is refused");
    }

    #[test]
    fn an_oversized_state_is_refused_rather_than_truncated() {
        let jev = Jev::from_key("k").expect("accepted");
        let state = serde_json::Value::String("x".repeat(STATE_BYTE_BUDGET + 1));
        let questions = BTreeMap::from([("q".to_string(),
            Question::Noul { instructions: "?".into(), when_true: None, when_false: None })]);
        let error = jev.ask(&state, &questions).expect_err("refused");
        assert!(error.contains("Refused rather than truncated"), "{error}");
    }

    #[test]
    fn no_questions_is_refused() {
        let jev = Jev::from_key("k").expect("accepted");
        assert!(jev.ask(&serde_json::json!("state"), &BTreeMap::new()).is_err());
    }
}
