//! Every flow this plugin has, in one table (spec 153 decision 1).
//!
//! A cookbook is a technique and a flow is a task, so the 18 cookbooks do not become 18 entries
//! here: `parallel_questions` is how every flow batches its questions, and three more are routing
//! rules that live in `gates`. What is here is the tasks, each naming the cookbook it comes from so
//! "implemented" is checkable one cookbook at a time rather than as a claim about a total.
//!
//! An entry is metadata plus, once it is built, a runner. A flow with no runner can still be
//! DECLARED — its surface and sources are enforced from the moment it is named here — and running
//! it says plainly that it is not built rather than failing obscurely. `every_flow_is_built_or_is
//! _counted` is the guard that keeps that list shrinking on purpose.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{json, Value};

use crate::flows::{Flow, Surface};
use crate::Jev;

/// What a flow is given: the caller's arguments, all of them identifiers (spec 153 decision 5).
pub type Arguments = BTreeMap<String, String>;
pub type Runner = fn(&Jev, &Flow, &Arguments, &Path) -> Result<Value, String>;

pub struct Entry {
    pub name: &'static str,
    /// The vendor cookbook this realises, for the mapping in spec 153.
    pub cookbook: &'static str,
    pub surface: Surface,
    /// The source keys a project must declare for this flow.
    pub sources: &'static [&'static str],
    pub description: &'static str,
    /// What one run costs, said out loud where a surface decision depends on it.
    pub cost: &'static str,
    pub schema: fn() -> Value,
    pub runner: Option<Runner>,
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required })
}

fn triage_schema() -> Value {
    object(json!({
        "output": { "type": "string",
            "description": "A run this workspace already recorded, named relative to the state directory." },
        "test": { "type": "string", "description": "The failing test's name, as the run reported it." },
    }), &["output", "test"])
}

fn query_schema() -> Value {
    object(json!({ "query": { "type": "string",
        "description": "The question, in the words somebody would actually ask it." } }), &["query"])
}

fn report_schema() -> Value {
    object(json!({ "report": { "type": "string",
        "description": "The text of the report, as it was filed." } }), &["report"])
}

fn align_schema() -> Value {
    object(json!({
        "left": { "type": "string", "description": "An id in the declared corpus." },
        "right": { "type": "string", "description": "The other id, in the same corpus." },
    }), &["left", "right"])
}

fn rerank_schema() -> Value {
    object(json!({
        "query": { "type": "string", "description": "What the candidates are being ranked against." },
        "candidates": { "type": "array", "items": { "type": "string" },
            "description": "Ids in the declared corpus. Identifiers, never text." },
    }), &["query", "candidates"])
}

fn evidence_schema() -> Value {
    object(json!({
        "claim": { "type": "string", "description": "An id in the declared corpus whose claim is being checked." },
    }), &["claim"])
}

fn taxonomy_schema() -> Value {
    object(json!({
        "subject": { "type": "string", "description": "An id in the declared corpus to classify." },
    }), &["subject"])
}

fn turn_schema() -> Value {
    object(json!({ "turn": { "type": "string",
        "description": "The request a person just made, in their own words." } }), &["turn"])
}

fn document_schema() -> Value {
    object(json!({ "document": { "type": "string",
        "description": "A path this project declared as readable by this flow." } }), &["document"])
}

fn extract_schema() -> Value {
    object(json!({
        "document": { "type": "string", "description": "A path this project declared as readable by this flow." },
        "want": { "type": "string", "description": "What to find, e.g. 'the pid the crash reported'." },
    }), &["document", "want"])
}

/// The table. Order is the order a person reads it in: primitives, then routing, then reading,
/// then the composites built out of them.
pub const FLOWS: &[Entry] = &[
    Entry {
        name: "align", cookbook: "entity_alignment", surface: Surface::Tool,
        sources: &["corpus"],
        description: "Decide whether two records in this project's corpus describe the same thing. \
                      Answers on three ordered levels that ARE the outcomes - different, needs a \
                      person, the same - so there is no threshold to fit, and reports which \
                      dimension disagrees when the answer is the middle one.",
        cost: "1 request, about $0.0003",
        schema: align_schema, runner: Some(crate::runs::retrieval::align),
    },
    Entry {
        name: "find", cookbook: "semantic_find", surface: Surface::Tool,
        sources: &["corpus"],
        description: "Search this project's declared corpus for what already answers a question. \
                      Ranks every entry by the full probability distribution and asks INDEPENDENTLY \
                      whether the corpus answers the query at all, so an absent answer is reported \
                      as absent rather than dressed up as the best of a bad set.",
        cost: "1 request, about $0.0007",
        schema: query_schema, runner: Some(crate::runs::retrieval::find),
    },
    Entry {
        name: "rerank", cookbook: "rerank_typesafe", surface: Surface::Tool,
        sources: &["corpus"],
        description: "Order a shortlist of candidates against a query, one independent judgement per \
                      candidate. Use it when something cheap has already narrowed the field; it does \
                      not search, and a candidate the shortlist missed cannot be recovered here.",
        cost: "1 request per candidate, about $0.0003 each",
        schema: rerank_schema, runner: Some(crate::runs::retrieval::rerank),
    },
    Entry {
        name: "evidence-check", cookbook: "citation_check", surface: Surface::Tool,
        sources: &["corpus"],
        description: "Does the evidence cited for a claim actually support it? Reads the claim and \
                      its cited evidence out of this project's corpus and decides between supported, \
                      unsupported, and needs a person.",
        cost: "1 request, about $0.0003",
        schema: evidence_schema, runner: Some(crate::runs::retrieval::evidence_check),
    },
    Entry {
        name: "passage-triage", cookbook: "classifying_rag_passages", surface: Surface::Tool,
        sources: &["corpus"],
        description: "Judge a retrieved passage before it reaches an answering model: keep, flag or \
                      drop. Asks about a hidden instruction FIRST and reports it outright rather \
                      than averaging it against the other judgements - a passage trying to direct \
                      its reader is reported before anything else about it.",
        cost: "1 request, about $0.0004",
        schema: evidence_schema, runner: Some(crate::runs::retrieval::passage_triage),
    },
    Entry {
        name: "classify", cookbook: "hierarchical_classification", surface: Surface::Tool,
        sources: &["corpus", "taxonomy"],
        description: "Place a subject in a declared taxonomy by walking it, keeping three candidate \
                      paths and scoring each by the geometric mean of its edges so a shallow leaf and \
                      a deep one compare fairly. A branch with one child costs no request.",
        cost: "about 1 request per level per kept path",
        schema: taxonomy_schema, runner: None,
    },
    Entry {
        name: "skill-pick", cookbook: "skill_suggestion", surface: Surface::Tool,
        sources: &["skills"],
        description: "Suggest at most one skill from this project's roster for the request a person \
                      just made. Asks first whether the turn wants a skill AT ALL, and can reject \
                      every candidate - suggesting nothing is a normal answer, not a failure.",
        cost: "2 requests, about $0.0012",
        schema: turn_schema, runner: None,
    },
    Entry {
        name: "action-intent", cookbook: "function_calling", surface: Surface::Tool,
        sources: &["actions"],
        description: "Map a sentence to one of this project's DECLARED actions and its arguments. \
                      Every argument comes from a closed set, so a value it never saw cannot be \
                      invented, and the confidence reported is the WEAKEST argument rather than the \
                      product - one wrong argument spoils the call.",
        cost: "1 request, about $0.0004",
        schema: turn_schema, runner: None,
    },
    Entry {
        name: "reformat", cookbook: "autoformat", surface: Surface::Tool,
        sources: &[],
        description: "Recover Markdown structure from plain text that lost it: one pass stitches \
                      hard-wrapped lines, one classifies every block. The Markdown is assembled in \
                      code and no word is generated - every word in the output was in the input.",
        cost: "2 requests, about $0.001",
        schema: document_schema, runner: None,
    },
    Entry {
        name: "extract", cookbook: "pre_parsed_value_extraction", surface: Surface::Tool,
        sources: &[],
        description: "Pull one exact value out of a document. A pattern finds the candidates and the \
                      judgement only CHOOSES among them, so what comes back is a span copied \
                      unchanged - it cannot invent a value or transpose a digit.",
        cost: "1 request, about $0.0003",
        schema: extract_schema, runner: None,
    },
    Entry {
        name: "dates", cookbook: "date_extraction", surface: Surface::Tool,
        sources: &[],
        description: "Read the date a document states. The model names the parts and every calendar \
                      calculation happens in code, because reading dates as ordered quantities is a \
                      documented weakness; an impossible date is refused rather than resolved.",
        cost: "1 request, about $0.0005",
        schema: document_schema, runner: None,
    },
    Entry {
        name: "hazards", cookbook: "llm_guardrails", surface: Surface::Tool,
        sources: &[],
        description: "Flag hazards in a document for A PERSON to read, with a severity beside them. \
                      ADVISORY and not a security control: the vendor's own page says an attacker \
                      can talk a screening model past, so nothing in this workspace gates on it.",
        cost: "1 request, about $0.0005",
        schema: document_schema, runner: None,
    },
    Entry {
        name: "featurize", cookbook: "autoresearch_feature_discovery", surface: Surface::Action,
        sources: &["corpus"],
        description: "Turn a corpus of free text into a numeric matrix: each declared question \
                      becomes columns, a Score becoming its mean level and spread and a Noul its \
                      probability. It emits the matrix and fits NOTHING - the regressor needs a \
                      labelled target this workspace does not have.",
        cost: "1 request per row",
        schema: query_schema, runner: None,
    },
    Entry {
        name: "prior-art", cookbook: "entity_alignment + semantic_find", surface: Surface::Tool,
        sources: &["features"],
        description: "Before a report is minted as a feature, ask whether one already covers it. \
                      Sweeps the WHOLE feature corpus in chunks with an explicit no-match option, \
                      keeps every candidate above the floor rather than one per chunk, aligns each \
                      properly, and judges the report itself - whether it bundles two defects, what \
                      area it is really about, and whether it says where and how.",
        cost: "8-9 requests, about $0.0028",
        schema: report_schema, runner: None,
    },
    Entry {
        name: "prior-findings", cookbook: "semantic_find", surface: Surface::Tool,
        sources: &["corpus"],
        description: "Has this project already tried this and decided against it? Searches the \
                      lessons and antipatterns it records, which exist so a dead end is walked once \
                      and are otherwise read only when somebody remembers they exist.",
        cost: "1 request, about $0.0007",
        schema: query_schema, runner: None,
    },
    Entry {
        name: "assert-check", cookbook: "citation_check", surface: Surface::Action,
        sources: &["tests"],
        description: "Sweep a tests tree for tests whose assertions do not evidence the claim their \
                      NAME makes. A sweep, not a question: it is started and watched, not called.",
        cost: "about 130 requests, $0.007 on a 3,263-test tree",
        schema: query_schema, runner: None,
    },
    Entry {
        name: "ki-sweep", cookbook: "entity_alignment + classification_using_confidence",
        surface: Surface::Action, sources: &["issues", "features"],
        description: "Sweep every open known-issue row against the feature corpus, looking for the \
                      one that already covers it. The most expensive thing here by an order of \
                      magnitude, which is why it is an action.",
        cost: "2,477 requests, $0.95 on a 339-row list",
        schema: query_schema, runner: None,
    },
    Entry {
        name: "triage", cookbook: "sde_cascade", surface: Surface::Tool,
        sources: &[],
        description: "Ask whether a recorded test failure is better explained by the environment than \
                      by the change under test. The parameters are IDENTIFIERS, never text: `output` \
                      names a run this workspace already recorded and `test` names the failing test. \
                      The state is built by reading that file inside the plugin and scrubbing home \
                      directories and private hosts out of it, so this cannot be used to send \
                      arbitrary content. The answer is RECORDED AND NOT ACTED ON, and carries the \
                      margin between the top two outcomes, which is what you would gate on rather \
                      than the service's own confidence scalar.",
        cost: "1 request, about $0.0002",
        schema: triage_schema, runner: Some(crate::runs::triage),
    },
];

pub fn find(name: &str) -> Option<&'static Entry> {
    FLOWS.iter().find(|entry| entry.name == name)
}

/// Run one flow, or say plainly that it is declared but not built.
pub fn run(jev: &Jev, flow: &Flow, arguments: &Arguments, project_root: &Path) -> Result<Value, String> {
    let entry = find(&flow.name).ok_or_else(|| format!("{} is not a flow this plugin has", flow.name))?;
    let runner = entry.runner.ok_or_else(|| format!(
        "the {} flow is declared but not built yet. It is in this plugin's table with its sources \
         and surface enforced, and its runner is the part that is missing.", flow.name))?;
    runner(jev, flow, arguments, project_root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_flow_is_built_or_is_counted() {
        // A count rather than a list, for the reason the tool-count guard exists: a flow that
        // appears without a decision behind it should be a failing test rather than a surprise.
        // This number goes DOWN, one feature row at a time, and never up without one.
        let unbuilt: Vec<&str> = FLOWS.iter().filter(|e| e.runner.is_none()).map(|e| e.name).collect();
        assert_eq!(unbuilt.len(), 12, "flows still to build: {unbuilt:?}");
        assert_eq!(FLOWS.len(), 18);
    }

    #[test]
    fn a_flow_names_its_cookbook_so_the_mapping_can_be_checked() {
        for entry in FLOWS {
            assert!(!entry.cookbook.is_empty(), "{} names no cookbook", entry.name);
            assert!(!entry.cost.is_empty(), "{} does not say what it costs", entry.name);
            assert!(entry.description.len() > 80, "{} needs a description an agent can act on", entry.name);
        }
        // Every cookbook in spec 153's table is either a flow here or a gate in `gates`.
        let named: String = FLOWS.iter().map(|e| e.cookbook).collect::<Vec<_>>().join(" ");
        for cookbook in ["entity_alignment", "semantic_find", "citation_check", "rerank_typesafe",
                         "classifying_rag_passages", "hierarchical_classification", "skill_suggestion",
                         "function_calling", "autoformat", "pre_parsed_value_extraction",
                         "date_extraction", "llm_guardrails", "autoresearch_feature_discovery",
                         "sde_cascade"] {
            assert!(named.contains(cookbook), "no flow realises {cookbook}");
        }
    }

    #[test]
    fn the_expensive_flows_are_actions_rather_than_tools() {
        for name in ["ki-sweep", "assert-check", "featurize"] {
            assert_eq!(find(name).expect(name).surface, Surface::Action,
                       "{name} is a sweep and an agent must not be able to start it on a whim");
        }
        for name in ["prior-art", "find", "triage"] {
            assert_eq!(find(name).expect(name).surface, Surface::Tool);
        }
    }

    #[test]
    fn a_declared_but_unbuilt_flow_says_so_rather_than_failing_obscurely() {
        // A flow that is declared and has no runner yet. When this one gains a runner, point the
        // test at another - or delete it, on the day the count above reaches zero.
        let flow = Flow { name: "classify".into(), surface: Surface::Tool,
                          sources: BTreeMap::new(), settings: json!({}) };
        let jev = Jev::from_key("x".repeat(40).as_str()).expect("key");
        let error = run(&jev, &flow, &Arguments::new(), Path::new(".")).expect_err("not built");
        assert!(error.contains("not built yet"), "{error}");
    }
}
