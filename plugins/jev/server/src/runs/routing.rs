//! The flows that route a request to something declared (F238, spec 153).
//!
//! `classify` walks a taxonomy, `skill-pick` chooses at most one skill for a turn, and
//! `action-intent` maps a sentence to one of the project's own declared actions. What they share is
//! that **the answer set is a declaration, not a generation**: every option comes out of a file this
//! project wrote, so nothing here can name a category, a skill or an action that does not exist.
//!
//! All three can answer "none of these". That is not politeness — a router that must pick something
//! will, and a forced pick reads exactly like a confident one.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{json, Value};

use crate::corpus;
use crate::flows::Flow;
use crate::gates;
use crate::registry::Arguments;
use crate::runs::{argument, describe};
use crate::{Answer, Jev, Question};

const NONE: &str = "none";
/// `hierarchical_classification`'s beam: three paths kept at every level.
const BEAM: usize = 3;
/// A guard, not a budget. A taxonomy deeper than this is a corpus, not a tree.
const MAX_DEPTH: usize = 12;

/// The beam walk, with asking left to the caller so the bookkeeping can be tested on its own.
///
/// `ask` is given the path so far and the children to choose between, and answers with a
/// probability per child. What is returned is every path that reached a leaf, best first.
fn walk(
    taxonomy: &Value,
    beam_width: usize,
    max_depth: usize,
    mut ask: impl FnMut(&[String], &BTreeMap<String, String>) -> Result<BTreeMap<String, f64>, String>,
) -> Result<Vec<(Vec<String>, Vec<f64>)>, String> {
    fn children<'a>(taxonomy: &'a Value, path: &[String]) -> Option<&'a serde_json::Map<String, Value>> {
        let mut node = taxonomy;
        for step in path { node = node.get(step)?; }
        node.as_object().filter(|map| !map.is_empty())
    }

    let mut beam: Vec<(Vec<String>, Vec<f64>)> = vec![(Vec::new(), Vec::new())];
    let mut finished: Vec<(Vec<String>, Vec<f64>)> = Vec::new();
    // Whether the walk ran out of DEPTH rather than out of tree. It decides what happens to the
    // beam at the end: paths that reached a leaf are already in `finished`, so adding the beam
    // again would report each of them twice — which it did, until it was seen in a live answer.
    let mut out_of_depth = true;

    for _ in 0..max_depth {
        let mut next: Vec<(Vec<String>, Vec<f64>)> = Vec::new();
        let mut alive = false;
        for (path, edges) in &beam {
            let Some(options) = children(taxonomy, path) else {
                finished.push((path.clone(), edges.clone()));
                continue;
            };
            alive = true;
            let named: BTreeMap<String, String> = options.iter()
                .map(|(name, description)| {
                    (name.clone(), description.as_str().unwrap_or_default().to_string())
                }).collect();
            if named.len() == 1 {
                // Nothing to decide, so nothing is asked and nothing counts as a decision —
                // counting it would dilute the mean with a certainty nobody asked about.
                let mut path = path.clone();
                path.push(named.keys().next().cloned().unwrap_or_default());
                next.push((path, edges.clone()));
                continue;
            }
            for (name, probability) in ask(path, &named)? {
                if !options.contains_key(&name) { continue; }
                let mut path = path.clone();
                path.push(name);
                let mut edges = edges.clone();
                edges.push(probability);
                next.push((path, edges));
            }
        }
        if !alive { out_of_depth = false; break; }
        next.sort_by(|a, b| geometric_mean(&b.1).total_cmp(&geometric_mean(&a.1)));
        next.truncate(beam_width);
        beam = next;
        if beam.is_empty() { out_of_depth = false; break; }
    }
    if out_of_depth { finished.extend(beam); }
    finished.sort_by(|a, b| geometric_mean(&b.1).total_cmp(&geometric_mean(&a.1)));
    Ok(finished)
}

/// `classify` — place a subject in a declared taxonomy. (`hierarchical_classification`)
///
/// Beam search rather than a greedy walk, because one wrong turn near the root hides every leaf
/// under it and there is no way back. Paths are scored by the GEOMETRIC MEAN of their edges, which
/// is what lets a shallow leaf and a deep one be compared: a plain product punishes depth, so the
/// shallowest branch would win every time regardless of what it said.
///
/// A branch with one child costs no request and does not count as a decision — there was nothing to
/// decide, and counting it would dilute the mean with a certainty nobody asked about.
pub fn classify(jev: &Jev, flow: &Flow, arguments: &Arguments, root: &Path) -> Result<Value, String> {
    let entries = corpus::read(root, flow.source("corpus")?)?;
    let subject = corpus::find(&entries, &argument(arguments, &flow.name, "subject")?)?;
    let taxonomy_path = root.join(flow.source("taxonomy")?);
    let taxonomy: Value = serde_json::from_str(&std::fs::read_to_string(&taxonomy_path)
        .map_err(|e| format!("cannot read the taxonomy at {}: {e}", taxonomy_path.display()))?)
        .map_err(|e| format!("{} is not JSON: {e}", taxonomy_path.display()))?;

    let mut tokens = 0u64;
    let finished = walk(&taxonomy, BEAM, MAX_DEPTH, |path, options| {
        let state = json!({
            "subject": { "id": subject.id, "says": subject.body },
            "where": if path.is_empty() { json!("the top of the taxonomy") } else { json!(path.join(" / ")) },
        });
        let questions = BTreeMap::from([("child".to_string(), Question::Choice {
            instructions: "Which of these categories does the subject belong to?".to_string(),
            options: options.clone(),
        })]);
        let response = jev.ask(&state, &questions)?;
        tokens += response.input_tokens;
        match response.answers.get("child") {
            Some(Answer::Choice { probabilities, .. }) => Ok(probabilities.clone()),
            _ => Err("a taxonomy step asks a Choice and got something else".to_string()),
        }
    })?;

    let paths: Vec<Value> = finished.iter().take(BEAM).map(|(path, edges)| json!({
        "path": path, "edges": edges, "score": geometric_mean(edges),
    })).collect();
    let best = finished.first();
    Ok(json!({
        "flow": "classify", "subject": subject.id,
        "leaf": best.map(|(path, _)| json!(path)).unwrap_or(Value::Null),
        "score": best.map(|(_, edges)| geometric_mean(edges)).unwrap_or(0.0),
        "paths": paths,
        "inputTokens": tokens, "acted": false,
        "note": "Paths are scored by the geometric mean of their edges, so a shallow leaf and a deep \
                 one compare fairly. A branch with one child cost no request and is not a decision.",
    }))
}

/// Length-normalised path score. An empty path scores 0 rather than 1: nothing was decided.
fn geometric_mean(edges: &[f64]) -> f64 {
    if edges.is_empty() { return 0.0; }
    let product: f64 = edges.iter().product();
    product.powf(1.0 / edges.len() as f64)
}

/// One skill as its own file declares itself. A derived Debug is fine here — unlike the client,
/// nothing in a skill is a credential.
#[derive(Debug)]
struct Skill { name: String, description: String, body: String }

/// Read `<roster>/<name>/SKILL.md`, each with `name:` and `description:` in its front matter.
fn roster(directory: &Path) -> Result<Vec<Skill>, String> {
    let mut skills = Vec::new();
    let entries = std::fs::read_dir(directory)
        .map_err(|e| format!("cannot read the skills at {}: {e}", directory.display()))?;
    for entry in entries.flatten() {
        let path = entry.path().join("SKILL.md");
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let mut name = entry.file_name().to_string_lossy().to_string();
        let mut description = String::new();
        let mut body = String::new();
        let mut in_front_matter = false;
        for (index, line) in text.lines().enumerate() {
            if index == 0 && line.trim() == "---" { in_front_matter = true; continue; }
            if in_front_matter {
                if line.trim() == "---" { in_front_matter = false; continue; }
                if let Some(value) = line.strip_prefix("name:") { name = value.trim().to_string(); }
                if let Some(value) = line.strip_prefix("description:") { description = value.trim().to_string(); }
                continue;
            }
            body.push_str(line);
            body.push('\n');
        }
        if description.is_empty() { continue; }
        skills.push(Skill { name, description, body });
    }
    if skills.is_empty() {
        return Err(format!(
            "{} holds no skills: a skill is a directory with a SKILL.md whose front matter carries a \
             name and a description", directory.display()));
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

/// `skill-pick` — at most one skill for the turn a person just took. (`skill_suggestion`)
///
/// Two stages, and the first one's job is to be allowed to say no. It asks the whole roster which
/// skill fits AND three independent questions about whether the turn wants a skill at all; below
/// the gate nothing is suggested, however confidently the Choice named a favourite. Then the top
/// three are read properly — full description and the opening of the instructions — and each is
/// asked on its own whether it does the specific thing. Every candidate can be rejected.
pub fn skill_pick(jev: &Jev, flow: &Flow, arguments: &Arguments, root: &Path) -> Result<Value, String> {
    let turn = argument(arguments, &flow.name, "turn")?;
    let skills = roster(&root.join(flow.source("skills")?))?;

    let mut options: BTreeMap<String, String> = skills.iter()
        .map(|skill| (skill.name.clone(), skill.description.chars().take(60).collect()))
        .collect();
    options.insert(NONE.to_string(), "No skill in this roster fits the turn.".to_string());
    let state = json!({ "turn": turn });
    let questions = BTreeMap::from([
        ("which".to_string(), Question::Choice {
            instructions: "Which of these skills, if any, is the right one to load for the request?"
                .to_string(),
            options,
        }),
        ("acts_on_system".to_string(), Question::Noul {
            instructions: "Is the assistant being asked to act on files, services or devices, rather \
                           than to explain something?".to_string(),
            when_true: Some("It asks for something to be done".to_string()),
            when_false: Some("It asks for something to be explained".to_string()),
        }),
        ("follows_procedure".to_string(), Question::Noul {
            instructions: "Would a careful expert consult a documented procedure before doing this?"
                .to_string(),
            when_true: Some("There is a right order of steps to follow".to_string()),
            when_false: Some("Judgement alone is enough".to_string()),
        }),
        ("prose_suffices".to_string(), Question::Noul {
            instructions: "Could a knowledgeable generalist fully satisfy this in prose, with no tools?"
                .to_string(),
            when_true: Some("An answer in words is the whole of it".to_string()),
            when_false: Some("Something has to be done, not said".to_string()),
        }),
    ]);
    let first = jev.ask(&state, &questions)?;
    let noul = |name: &str| match first.answers.get(name) {
        Some(Answer::Noul { probability }) => *probability,
        _ => 0.0,
    };
    // `prose_suffices` counts inverted: prose being enough is a reason NOT to load a skill.
    let wanted = (noul("acts_on_system") + noul("follows_procedure") + (1.0 - noul("prose_suffices"))) / 3.0;
    let mut tokens = first.input_tokens;

    if wanted < gates::SKILL_WANTED.value {
        return Ok(json!({
            "flow": "skill-pick", "turn": turn, "suggest": Value::Null,
            "wanted": wanted, "considered": skills.len(),
            "thresholds": [gates::SKILL_WANTED.report()],
            "inputTokens": tokens, "acted": false,
            "note": "No skill is suggested: the turn does not want one. Suggesting nothing is a \
                     normal answer here, not a failure to find something.",
        }));
    }

    let Some(Answer::Choice { probabilities, .. }) = first.answers.get("which") else {
        return Err("the roster question was not answered".to_string());
    };
    let mut ranked: Vec<(&String, &f64)> = probabilities.iter()
        .filter(|(name, _)| name.as_str() != NONE).collect();
    ranked.sort_by(|a, b| b.1.total_cmp(a.1));
    let top: Vec<&Skill> = ranked.iter().take(BEAM)
        .filter_map(|(name, _)| skills.iter().find(|skill| &&skill.name == name)).collect();

    // Stage two: the same three read properly, each asked on its own so one cannot take mass from
    // another, and all three can be rejected together.
    let state = json!({
        "turn": turn,
        "candidates": top.iter().map(|skill| json!({
            "name": skill.name, "description": skill.description,
            "instructions": skill.body.chars().take(700).collect::<String>(),
        })).collect::<Vec<_>>(),
    });
    let questions: BTreeMap<String, Question> = top.iter().map(|skill| (
        skill.name.clone(),
        Question::Noul {
            instructions: format!("Does the skill {:?} do the specific thing this request asks for?",
                                  skill.name),
            when_true: Some("It is for this exact kind of request".to_string()),
            when_false: Some("It is for something else, even if related".to_string()),
        },
    )).collect();
    let second = jev.ask(&state, &questions)?;
    tokens += second.input_tokens;

    let mut fits: Vec<(String, f64)> = second.answers.iter().filter_map(|(name, answer)| {
        let Answer::Noul { probability } = answer else { return None };
        Some((name.clone(), *probability))
    }).collect();
    fits.sort_by(|a, b| b.1.total_cmp(&a.1));
    let best = fits.first().filter(|(_, p)| *p >= gates::SKILL_WANTED.value);

    Ok(json!({
        "flow": "skill-pick", "turn": turn,
        "suggest": best.map(|(name, _)| json!(name)).unwrap_or(Value::Null),
        "wanted": wanted,
        "considered": skills.len(),
        "fits": fits.iter().map(|(name, p)| json!({ "skill": name, "probability": p })).collect::<Vec<_>>(),
        "thresholds": [gates::SKILL_WANTED.report()],
        "inputTokens": tokens, "acted": false,
        "note": "Read this as a suggestion to ignore when it does not fit. Every candidate can be \
                 rejected, and nothing is loaded by this answer.",
    }))
}

/// `action-intent` — which declared action is this sentence asking for? (`function_calling`)
///
/// Every option is an action the project declared, so an action that does not exist cannot be
/// named. Where the declaration offers a further closed set — which device an action runs on —
/// that is asked as its own question, and the confidence reported is **the weakest of them**, not
/// the product: one wrong argument is enough to spoil the call, and a product of several good
/// probabilities understates a call whose parts were all fine.
pub fn action_intent(jev: &Jev, flow: &Flow, arguments: &Arguments, root: &Path) -> Result<Value, String> {
    let turn = argument(arguments, &flow.name, "turn")?;
    let declaration_path = root.join(flow.source("actions")?);
    let declaration: Value = serde_json::from_str(&std::fs::read_to_string(&declaration_path)
        .map_err(|e| format!("cannot read the declaration at {}: {e}", declaration_path.display()))?)
        .map_err(|e| format!("{} is not JSON: {e}", declaration_path.display()))?;

    let mut actions: Vec<(String, String)> = Vec::new();
    let mut devices: Vec<String> = Vec::new();
    for group in declaration.pointer("/dashboard/groups").and_then(Value::as_array).into_iter().flatten() {
        for action in group.get("actions").and_then(Value::as_array).into_iter().flatten() {
            let Some(id) = action.get("id").and_then(Value::as_str) else { continue };
            let title = action.get("title").and_then(Value::as_str).unwrap_or_default();
            let description = action.get("description").and_then(Value::as_str).unwrap_or_default();
            actions.push((id.to_string(), format!("{title}. {description}").trim().to_string()));
            if let Some(device) = action.get("device").and_then(Value::as_str) {
                if !devices.iter().any(|d| d == device) { devices.push(device.to_string()); }
            }
        }
    }
    if actions.is_empty() {
        return Err(format!("{} declares no dashboard actions to route to", declaration_path.display()));
    }

    let mut options: BTreeMap<String, String> = actions.iter().cloned().collect();
    options.insert(NONE.to_string(), "The request is not asking for any of these to be run.".to_string());
    let mut questions = BTreeMap::from([("action".to_string(), Question::Choice {
        instructions: "Which of this project's actions is the request asking to run?".to_string(),
        options,
    })]);
    if devices.len() > 1 {
        questions.insert("device".to_string(), Question::Choice {
            instructions: "Which machine does the request want it run on? Answer `unstated` if it \
                           does not say.".to_string(),
            options: devices.iter().map(|d| (d.clone(), String::new()))
                .chain([("unstated".to_string(), "The request does not say.".to_string())])
                .collect(),
        });
    }
    let response = jev.ask(&json!({ "turn": turn }), &questions)?;

    let mut answers = serde_json::Map::new();
    for (id, answer) in &response.answers { answers.insert(id.clone(), describe(answer)); }
    let (chosen, action_confidence) = match response.answers.get("action") {
        Some(Answer::Choice { choice, confidence, .. }) => (choice.clone(), *confidence),
        _ => return Err("the action question was not answered".to_string()),
    };
    // The weakest judgement in the call, not the product of them.
    let weakest = response.answers.values().filter_map(|answer| match answer {
        Answer::Choice { confidence, .. } => Some(*confidence),
        _ => None,
    }).fold(f64::INFINITY, f64::min);
    let weakest = if weakest.is_finite() { weakest } else { action_confidence };

    let call = (chosen != NONE).then(|| {
        let mut call = json!({ "action": chosen });
        if let Some(Answer::Choice { choice, .. }) = response.answers.get("device") {
            if choice != "unstated" { call["device"] = json!(choice); }
        }
        call
    });

    Ok(json!({
        "flow": "action-intent", "turn": turn,
        "call": call,
        "confidence": weakest,
        "confidenceIs": "the weakest judgement in the call, because one wrong argument spoils it",
        "offered": actions.len(),
        "answers": answers,
        "acted": false,
        "note": "Names an action this project DECLARED, or none. Nothing is run by this answer, and \
                 an action that is not in the declaration cannot be named by it.",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_deep_leaf_and_a_shallow_one_compare_fairly() {
        // A plain product would rank the shallow branch above the deep one whatever it said, which
        // is the whole reason for the normalisation.
        let shallow = [0.8];
        let deep = [0.9, 0.9, 0.9];
        assert!(deep.iter().product::<f64>() < shallow.iter().product::<f64>(),
                "the product punishes depth");
        assert!(geometric_mean(&deep) > geometric_mean(&shallow), "the geometric mean does not");
        assert_eq!(geometric_mean(&[]), 0.0, "nothing decided scores nothing, not one");
        assert!((geometric_mean(&[0.25, 0.25]) - 0.25).abs() < 1e-9);
    }

    #[test]
    fn a_leaf_is_reported_once_and_a_one_child_branch_costs_no_question() {
        let taxonomy = json!({
            "workspace": { "sessions": "s", "layout": "l" },
            "services": { "host": "h" },
            "solo": { "only": "o" },
        });
        let mut asked: Vec<Vec<String>> = Vec::new();
        let finished = walk(&taxonomy, 3, 12, |path, options| {
            asked.push(path.to_vec());
            // Flat over whatever is offered, which is enough to exercise the bookkeeping.
            let each = 1.0 / options.len() as f64;
            Ok(options.keys().map(|name| (name.clone(), each)).collect())
        }).expect("walk");

        let paths: Vec<String> = finished.iter().map(|(path, _)| path.join("/")).collect();
        let mut unique = paths.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(paths.len(), unique.len(), "every leaf is reported once: {paths:?}");

        // `services` and `solo` each have ONE child, so neither was asked about below the root.
        assert_eq!(asked.iter().filter(|path| path.as_slice() == ["services"]).count(), 0,
                   "a branch with one child costs no question");
        assert!(finished.iter().any(|(path, edges)| path == &["services", "host"] && edges.len() == 1),
                "and its single child is not counted as a decision: {finished:?}");
    }

    #[test]
    fn the_beam_keeps_a_path_whose_root_edge_was_not_the_best() {
        // The argument for a beam at all. `surfaces` is behind at the root and its child is
        // certain; a greedy walk takes `services` and never sees it.
        let taxonomy = json!({ "surfaces": { "plugins": "p", "design": "d" },
                               "services": { "host": "h", "worker": "w" } });
        let finished = walk(&taxonomy, 3, 12, |path, options| {
            Ok(options.keys().map(|name| (name.clone(), match (path.first().map(String::as_str), name.as_str()) {
                (None, "surfaces") => 0.24, (None, "services") => 0.59,
                (Some("surfaces"), "plugins") => 0.99, (Some("services"), "host") => 0.40,
                _ => 0.01,
            })).collect())
        }).expect("walk");
        assert_eq!(finished[0].0, ["surfaces", "plugins"],
                   "the best path is the one a greedy walk would have pruned at the root: {finished:?}");
    }

    #[test]
    fn a_roster_is_read_from_the_files_that_declare_it() {
        let root = std::env::temp_dir().join(format!("jev-roster-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("grill-me")).expect("dir");
        std::fs::create_dir_all(root.join("no-front-matter")).expect("dir");
        std::fs::write(root.join("grill-me").join("SKILL.md"),
                       "---\nname: grill-me\ndescription: Interview the owner about a plan.\n---\n\n# Body\nText.\n")
            .expect("skill");
        std::fs::write(root.join("no-front-matter").join("SKILL.md"), "# Just a document\n").expect("skill");

        let skills = roster(&root).expect("roster");
        assert_eq!(skills.len(), 1, "a file with no description is not a skill");
        assert_eq!(skills[0].name, "grill-me");
        assert!(skills[0].body.contains("Text."), "the body is kept for the second stage");
        assert!(!skills[0].body.contains("description:"), "and the front matter is not in it");

        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).expect("dir");
        assert!(roster(&empty).expect_err("refused").contains("holds no skills"));
    }

    #[test]
    fn the_gate_counts_prose_the_other_way_round() {
        // Prose being enough is a reason NOT to load a skill, so it enters the mean inverted. With
        // it counted the same way round, a pure explain-this turn would score as wanting one.
        let (acts, procedure, prose) = (0.02_f64, 0.05_f64, 0.98_f64);
        let wanted = (acts + procedure + (1.0 - prose)) / 3.0;
        assert!(wanted < gates::SKILL_WANTED.value, "an explain-this turn wants no skill: {wanted}");
        let naive = (acts + procedure + prose) / 3.0;
        assert!(naive > wanted, "which counting it the same way round would have hidden");
    }
}
