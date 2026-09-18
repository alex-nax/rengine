//! The flow runners (spec 153). One function per flow, each with the same shape: read the sources
//! this project declared, build the state inside the plugin, ask, and report the distribution.
//!
//! What every runner here has in common is the rule from spec 151 that makes the whole thing safe
//! to offer an agent: **the caller names things, the flow reads them.** An argument is an id, a
//! path the project declared, or a query somebody typed — never a document. A flow that accepted
//! text would be a way to send arbitrary content to a third party through a tool call.

pub mod retrieval;
pub mod routing;

use std::path::Path;

use serde_json::{json, Value};

use crate::flows::Flow;
use crate::registry::Arguments;
use crate::Jev;

/// An argument by name, or a refusal that says which flow wanted it.
pub fn argument(arguments: &Arguments, flow: &str, name: &str) -> Result<String, String> {
    arguments.get(name).filter(|value| !value.trim().is_empty())
        .cloned()
        .ok_or_else(|| format!("the {flow} flow needs {name:?}"))
}

/// A Score's distribution comes back keyed by LEVEL INDEX — `{"0":0.97,"1":0.02}` — which is
/// unreadable at the point somebody has to act on it. Given the levels that were asked, this names
/// them. An index with no level (the service answered about something that was not asked) keeps its
/// number rather than being dropped, because a silent gap in a distribution is worse than an odd
/// key in one.
pub fn name_levels(answer: &crate::Answer, levels: &[&str]) -> Option<Value> {
    let crate::Answer::Score { probabilities, .. } = answer else { return None };
    let mut named = serde_json::Map::new();
    for (index, probability) in probabilities {
        let label = index.parse::<usize>().ok().and_then(|i| levels.get(i))
            .map(|label| (*label).to_string()).unwrap_or_else(|| index.clone());
        named.insert(label, json!(probability));
    }
    Some(Value::Object(named))
}

/// What every answer carries: the distribution, the margin a caller gates on, and the vendor's own
/// scalar reported beside it under a name nobody can mistake for the margin.
pub fn describe(answer: &crate::Answer) -> Value {
    let mut value = match answer {
        crate::Answer::Noul { probability } => json!({ "type": "noul", "noul": probability }),
        crate::Answer::Choice { choice, probabilities, .. } =>
            json!({ "type": "choice", "choice": choice, "probabilities": probabilities }),
        crate::Answer::Score { score, probabilities, .. } =>
            json!({ "type": "score", "score": score, "probabilities": probabilities }),
    };
    value["margin"] = json!(answer.margin());
    value["reportedConfidence"] = json!(answer.reported_confidence());
    value
}

/// `triage` — the flow that existed before there were flows (spec 151).
///
/// It keeps its own capability rather than being rewritten here: that path already scrubs the run,
/// coalesces a repeat through the record, and settles. A flow is a way to REACH a judgement, not a
/// second implementation of one.
pub fn triage(_jev: &Jev, flow: &Flow, arguments: &Arguments, _project_root: &Path)
              -> Result<Value, String> {
    let output = argument(arguments, &flow.name, "output")?;
    let test = argument(arguments, &flow.name, "test")?;
    let state = crate::flows::state_directory()?;
    let judgement = crate::capability::run(&state, &crate::capability::Capability::Triage { output, test })?;
    let mut answers = serde_json::Map::new();
    for (id, answer) in &judgement.answers {
        answers.insert(id.clone(), describe(answer));
    }
    Ok(json!({
        "id": judgement.id,
        "flow": "triage",
        "answers": answers,
        "inputTokens": judgement.input_tokens,
        "acted": false,
        "note": "Recorded, not acted on. Settle it with `red-jev settle` once you know.",
    }))
}
