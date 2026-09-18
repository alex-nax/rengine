//! `red-jev` — the one way anything in this tree asks for a judgement (F228/F229, spec 151).
//!
//! A binary rather than a library call, because the triggers live where the harness lives: the
//! Python gates are stdlib-only, the suite is node, and neither is going to link Rust. An explicit
//! subcommand also makes every call intentional, which is the other half of "nothing runs on a
//! timer".
//!
//! Every subcommand prints one JSON object on stdout and nothing else, so a caller parses rather
//! than scrapes. Refusals go to stderr and exit non-zero.

use std::collections::BTreeMap;

use red_jev::capability::{self, Capability};
use red_jev::record::{self, Outcome};

fn usage() -> &'static str {
    "Usage:
  red-jev status   --state DIR
  red-jev triage   --state DIR --output NAME --test NAME
  red-jev settle   --state DIR --id ID --outcome accepted|overridden|confirmed|reverted
  red-jev tally    --state DIR"
}

fn flag(args: &[String], name: &str) -> Option<String> {
    let at = args.iter().position(|a| a == name)?;
    args.get(at + 1).cloned()
}

fn need(args: &[String], name: &str) -> Result<String, String> {
    flag(args, name).ok_or_else(|| format!("{name} is required.\n{}", usage()))
}

fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().cloned().unwrap_or_default();
    let state = match need(&args, "--state") {
        Ok(state) => state,
        Err(error) => return fail(&error),
    };

    let outcome = match command.as_str() {
        "status" => Ok(capability::status(&state)),

        "triage" => (|| {
            let output = need(&args, "--output")?;
            let test = need(&args, "--test")?;
            let judgement = capability::run(&state, &Capability::Triage { output, test })?;
            let mut answers = serde_json::Map::new();
            for (id, answer) in &judgement.answers {
                answers.insert(id.clone(), describe(answer));
            }
            Ok(serde_json::json!({
                "id": judgement.id,
                "capability": "triage",
                "answers": answers,
                "inputTokens": judgement.input_tokens,
                // Shadow mode: this build never acts on a judgement, and says so where a caller
                // reads it rather than only in a spec (spec 151 decision 5).
                "acted": false,
                "note": "Recorded, not acted on. Settle it with `red-jev settle` once you know.",
            }))
        })(),

        "settle" => (|| {
            let id = need(&args, "--id")?;
            let text = need(&args, "--outcome")?;
            let outcome = Outcome::parse(&text).ok_or_else(||
                format!("{text:?} is not an outcome. One of: accepted, overridden, confirmed, reverted."))?;
            record::settle(&state, &id, outcome)?;
            Ok(serde_json::json!({ "id": id, "outcome": outcome.as_str() }))
        })(),

        "tally" => {
            let counts: BTreeMap<String, u64> = record::tally(&state);
            Ok(serde_json::json!(counts))
        }

        other => Err(format!("unknown command {other:?}.\n{}", usage())),
    };

    match outcome {
        Ok(value) => {
            println!("{value}");
            std::process::ExitCode::SUCCESS
        }
        Err(error) => fail(&error),
    }
}

fn describe(answer: &red_jev::Answer) -> serde_json::Value {
    let mut value = match answer {
        red_jev::Answer::Noul { probability } =>
            serde_json::json!({ "type": "noul", "noul": probability }),
        red_jev::Answer::Choice { choice, probabilities, .. } =>
            serde_json::json!({ "type": "choice", "choice": choice, "probabilities": probabilities }),
        red_jev::Answer::Score { score, probabilities, .. } =>
            serde_json::json!({ "type": "score", "score": score, "probabilities": probabilities }),
    };
    // The margin is what a caller would gate on; the vendor's scalar is reported beside it, named so
    // nobody mistakes one for the other.
    value["margin"] = serde_json::json!(answer.margin());
    value["reportedConfidence"] = serde_json::json!(answer.reported_confidence());
    value
}

fn fail(error: &str) -> std::process::ExitCode {
    eprintln!("{error}");
    std::process::ExitCode::from(2)
}
