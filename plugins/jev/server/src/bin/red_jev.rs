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
use red_jev::flows;
use red_jev::record::{self, Outcome};

/// The project this run is about: the working directory, which core sets to the project root
/// (spec 152 decision 8). Not an argument, because a flow that could be pointed at another
/// project's corpus would be a way to read one project's files from another's tool call.
fn project_root() -> std::path::PathBuf {
    std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
}

/// Every `--name value` pair except the ones the harness itself uses. A flow's arguments are
/// identifiers (spec 153 decision 5), so they arrive and stay as strings.
fn flag_arguments(args: &[String]) -> red_jev::registry::Arguments {
    let mut arguments = red_jev::registry::Arguments::new();
    let mut i = 0;
    while i < args.len() {
        if let Some(name) = args[i].strip_prefix("--") {
            if name != "state" {
                if let Some(value) = args.get(i + 1).filter(|next| !next.starts_with("--")) {
                    arguments.insert(name.to_string(), value.clone());
                    i += 2;
                    continue;
                }
            }
            i += 2;
            continue;
        }
        i += 1;
    }
    arguments
}

fn usage() -> &'static str {
    "Usage:
  red-jev status    --state DIR
  red-jev configure --state DIR --key VALUE
  red-jev triage   --state DIR --output NAME --test NAME
  red-jev settle   --state DIR --id ID --outcome accepted|overridden|confirmed|reverted
  red-jev tally    --state DIR
  red-jev flows    --state DIR
  red-jev <flow>   --state DIR [--<argument> VALUE ...]

A flow is one of the judgement tasks this plugin has, and a project enables the subset it wants in
plugins/jev/flows.json. `flows` lists what THIS project enabled, with the tool declarations core
offers an agent for them. Run it in the project root: that is where the declaration is read from."
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

    flows::remember_state(&state);

    let outcome = match command.as_str() {
        "status" => Ok(capability::status(&state)),
        "configure" => need(&args, "--key").and_then(|key| capability::configure(&state, &key)),

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

        /* What this project enabled, and the tools core should offer for it. Core calls this when a
           manifest names a subcommand instead of listing tools, so the declaration and the tool list
           cannot drift apart (spec 153 decision 7). */
        "flows" => (|| {
            let root = project_root();
            Ok(serde_json::json!({
                "flows": flows::declared(&root)?.iter().map(flows::Flow::report).collect::<Vec<_>>(),
                "tools": flows::tools(&root)?,
                "thresholds": red_jev::gates::all(),
                "declaration": flows::DECLARATION,
            }))
        })(),

        /* Any other word is a flow name. It reaches here the same way an agent's tool call does:
           core routes a tool to the subcommand its declaration names, and a flow's subcommand IS
           its name. A flow this project did not enable is refused by name rather than run. */
        other if red_jev::registry::find(other).is_some() => (|| {
            let root = project_root();
            let flow = flows::enabled(&root, other)?;
            let jev = red_jev::Jev::from_state_directory(&state)?;
            let arguments = flag_arguments(&args);
            let answer = red_jev::registry::run(&jev, &flow, &arguments, &root)?;
            Ok(answer)
        })(),

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
