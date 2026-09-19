//! The flows that read a document (F239, spec 153).
//!
//! `reformat`, `extract`, `dates`, `hazards` and `featurize`. Each names a file inside a directory
//! the project declared for it — never a bare path, because a flow that read whatever it was told
//! to would read the key file too (`Flow::file_in`).
//!
//! Two of these are deliberately narrow, and the narrowness IS the feature. `reformat` chooses
//! boundaries and types and assembles the Markdown in code, so every word in its output was in its
//! input. `extract` only ever picks among spans a pattern already found, so the value comes back
//! copied rather than retyped — it cannot transpose a digit. Neither is a limitation worked around;
//! both are how the answer becomes something you can rely on without checking it.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{json, Value};

use crate::corpus;
use crate::flows::Flow;
use crate::gates;
use crate::registry::Arguments;
use crate::runs::{argument, describe, name_levels};
use crate::{Answer, Jev, Question};

/// A document this flow is allowed to read, with a bound on how much of it is sent.
const MAX_LINES: usize = 400;

fn document(flow: &Flow, arguments: &Arguments, root: &Path) -> Result<(String, String), String> {
    let named = argument(arguments, &flow.name, "document")?;
    let path = flow.file_in("documents", &named, root)?;
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    Ok((named, text))
}

/// `reformat` — recover the structure plain text lost. (`autoformat`)
///
/// Two requests. The first asks, for every adjacent pair of lines, whether the second picks up a
/// sentence the first left unfinished; the second classifies each block that produces. Everything
/// after that is code: **no word in the output was generated.** The pipeline chose boundaries and
/// types, and the words are the ones that arrived.
pub fn reformat(jev: &Jev, flow: &Flow, arguments: &Arguments, root: &Path) -> Result<Value, String> {
    let (named, text) = document(flow, arguments, root)?;
    let lines: Vec<&str> = text.lines().take(MAX_LINES).collect();
    if lines.is_empty() { return Err(format!("{named} is empty")); }

    // Pass one: which lines continue the one above them. Asked for every adjacent pair in ONE
    // request, which is what `parallel_questions` is for.
    let mut questions: BTreeMap<String, Question> = BTreeMap::new();
    for index in 1..lines.len() {
        if lines[index].trim().is_empty() || lines[index - 1].trim().is_empty() { continue; }
        questions.insert(format!("line{index}"), Question::Noul {
            instructions: format!(
                "Does line {index} pick up mid-sentence, continuing a sentence left unfinished at \
                 the end of line {}?", index - 1),
            when_true: Some("The line starts in the middle of a sentence that began on the \
                             previous line".to_string()),
            when_false: Some("The line begins a new sentence, item, heading or thought of its own"
                .to_string()),
        });
    }
    let mut tokens = 0u64;
    let mut continues: BTreeMap<usize, f64> = BTreeMap::new();
    if !questions.is_empty() {
        let state = json!({ "lines": lines.iter().enumerate()
            .map(|(i, line)| json!({ "id": i, "text": line })).collect::<Vec<_>>() });
        let response = jev.ask(&state, &questions)?;
        tokens += response.input_tokens;
        for (id, answer) in &response.answers {
            let Answer::Noul { probability } = answer else { continue };
            if let Some(index) = id.strip_prefix("line").and_then(|n| n.parse::<usize>().ok()) {
                continues.insert(index, *probability);
            }
        }
    }

    // The thresholds are adaptive, because the evidence differs. A line that ended WITHOUT terminal
    // punctuation is already evidence of a continuation, so it takes less to join; a line that
    // ended with a full stop needs more than a hint.
    let mut blocks: Vec<String> = Vec::new();
    let mut current = String::new();
    for (index, line) in lines.iter().enumerate() {
        if line.trim().is_empty() {
            if !current.is_empty() { blocks.push(std::mem::take(&mut current)); }
            continue;
        }
        let joins = index > 0 && {
            let previous = lines[index - 1].trim_end();
            let dangling = !previous.ends_with(['.', '!', '?', ':', ';']);
            let threshold = if dangling { 0.2 } else { 0.5 };
            continues.get(&index).is_some_and(|p| *p >= threshold)
        };
        if joins && !current.is_empty() {
            current.push(' ');
            current.push_str(line.trim());
        } else {
            if !current.is_empty() { blocks.push(std::mem::take(&mut current)); }
            current.push_str(line.trim());
        }
    }
    if !current.is_empty() { blocks.push(current); }

    // Pass two: what each block IS. The companion questions are asked up front and read only where
    // the block's own type makes them apply — a heading level means nothing for a code block.
    const KINDS: [(&str, &str); 6] = [
        ("heading", "A short label or title that names the document or a section."),
        ("paragraph", "Running prose: one or more complete sentences of explanatory text."),
        ("list_item", "One entry in a list of parallel items."),
        ("quote", "Words attributed to a person or a source."),
        ("code", "Computer code, a shell command, or a config snippet."),
        ("callout", "A warning, a tip, or a note that interrupts the flow."),
    ];
    let mut questions: BTreeMap<String, Question> = BTreeMap::new();
    for (index, block) in blocks.iter().enumerate() {
        questions.insert(format!("kind{index}"), Question::Choice {
            instructions: format!("What kind of content is block {index}?"),
            options: KINDS.iter().map(|(k, d)| ((*k).to_string(), (*d).to_string())).collect(),
        });
        if block.chars().count() <= 90 {
            questions.insert(format!("level{index}"), Question::Score {
                instructions: format!("If block {index} is a heading, how high a one?"),
                levels: vec!["A subsection".into(), "A section".into(), "The document's title".into()],
            });
        }
        questions.insert(format!("ordered{index}"), Question::Noul {
            instructions: format!("If block {index} is a list item, does the order of the items matter?"),
            when_true: Some("They are steps in a sequence".to_string()),
            when_false: Some("They are parallel items in any order".to_string()),
        });
    }
    let state = json!({ "blocks": blocks.iter().enumerate()
        .map(|(i, b)| json!({ "id": i, "text": b })).collect::<Vec<_>>() });
    let response = jev.ask(&state, &questions)?;
    tokens += response.input_tokens;

    let mut markdown = String::new();
    let mut in_list = false;
    for (index, block) in blocks.iter().enumerate() {
        let kind = match response.answers.get(&format!("kind{index}")) {
            Some(Answer::Choice { choice, .. }) => choice.as_str(),
            _ => "paragraph",
        };
        // A list that ends needs the blank line that separates it from whatever follows, or the
        // next block is swallowed into the last item by every Markdown reader.
        if kind != "list_item" && in_list { markdown.push('\n'); in_list = false; }
        match kind {
            "heading" => {
                let level = match response.answers.get(&format!("level{index}")) {
                    Some(Answer::Score { score, .. }) => *score,
                    _ => 1.0,
                };
                let hashes = if level >= 1.5 { "#" } else if level >= 0.5 { "##" } else { "###" };
                markdown.push_str(&format!("{hashes} {block}\n\n"));
            }
            "list_item" => {
                let ordered = matches!(response.answers.get(&format!("ordered{index}")),
                                       Some(Answer::Noul { probability }) if *probability >= 0.5);
                markdown.push_str(&format!("{} {block}\n", if ordered { "1." } else { "-" }));
                in_list = true;
            }
            "quote" => markdown.push_str(&format!("> {block}\n\n")),
            "code" => markdown.push_str(&format!("```\n{block}\n```\n\n")),
            "callout" => markdown.push_str(&format!("> [!NOTE]\n> {block}\n\n")),
            _ => markdown.push_str(&format!("{block}\n\n")),
        }
    }
    if in_list { markdown.push('\n'); }

    Ok(json!({
        "flow": "reformat", "document": named,
        "markdown": markdown.trim_end(),
        "blocks": blocks.len(), "lines": lines.len(),
        "inputTokens": tokens, "acted": false,
        "note": "Every word here was in the input. The flow chose boundaries and types; the Markdown \
                 was assembled in code and nothing was written for you.",
    }))
}

/// `extract` — one exact value out of a document. (`pre_parsed_value_extraction`)
///
/// A pattern finds the candidates and the judgement only CHOOSES among them, so the value comes
/// back copied byte for byte. It cannot invent one or transpose a digit, and that is the whole
/// reason for the shape: the model is asked which, never what.
pub fn extract(jev: &Jev, flow: &Flow, arguments: &Arguments, root: &Path) -> Result<Value, String> {
    let (named, text) = document(flow, arguments, root)?;
    let want = argument(arguments, &flow.name, "want")?;

    // The candidate set is RECALL-TUNED, and the first version was not: it kept only tokens
    // carrying a dot, a dash or a digit, which left out `nm` and `atos` — so asked which tool
    // disambiguated the symbols, the flow had to choose among four paths and answered with one of
    // them at 0.82. A candidate the pattern misses cannot be chosen, and the model's confidence
    // says nothing about a set that never contained the answer.
    //
    // So: every distinct token, minus the words that carry no information, ranked by how RARE it is
    // in the document. Rarity is the right order for a cap — the value somebody is asking for is
    // almost never the word that appears forty times.
    const COMMON: [&str; 40] = [
        "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "at", "by", "for",
        "with", "from", "into", "is", "was", "are", "were", "be", "been", "it", "its", "this",
        "that", "these", "those", "we", "they", "he", "she", "you", "i", "as", "so", "then",
        "than", "not",
    ];
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut order: BTreeMap<String, usize> = BTreeMap::new();
    let mut first_seen: Vec<String> = Vec::new();
    for token in text.split(|c: char| c.is_whitespace() || "(),[]{}<>\"'`|".contains(c)) {
        let token = token.trim_matches(|c: char| ".,;:!?".contains(c));
        if token.len() < 2 || token.len() > 200 { continue; }
        if COMMON.contains(&token.to_ascii_lowercase().as_str()) { continue; }
        if counts.insert(token.to_string(), counts.get(token).copied().unwrap_or(0) + 1).is_none() {
            order.insert(token.to_string(), first_seen.len());
            first_seen.push(token.to_string());
        }
    }
    // Rarest first, and ties broken by where it appeared, so the set is stable run to run.
    first_seen.sort_by_key(|token| (counts.get(token).copied().unwrap_or(0),
                                    order.get(token).copied().unwrap_or(0)));
    let candidates: Vec<String> = first_seen.into_iter().take(200).collect();
    if candidates.is_empty() {
        return Err(format!("nothing in {named} looks like a value to pick from"));
    }

    let state = json!({ "document": text.chars().take(20_000).collect::<String>() });
    let questions = BTreeMap::from([("which".to_string(), Question::Choice {
        instructions: format!("{want}. Choose the span from the document that is it."),
        options: candidates.iter().map(|c| (c.clone(), String::new())).collect(),
    })]);
    let response = jev.ask(&state, &questions)?;
    let Some(Answer::Choice { choice, confidence, probabilities }) = response.answers.get("which") else {
        return Err("the extraction question was not answered".to_string());
    };
    // Paranoia that costs nothing: what comes back must be one of the spans that went in.
    if !candidates.iter().any(|c| c == choice) {
        return Err(format!("the service answered with {choice:?}, which was not one of the spans \
                            offered. Refused: the whole point of this flow is that the value is \
                            copied rather than produced."));
    }

    Ok(json!({
        "flow": "extract", "document": named, "want": want,
        "value": choice, "confidence": confidence,
        "candidates": candidates.len(),
        "alternatives": probabilities.iter().filter(|(c, _)| *c != choice)
            .map(|(c, p)| json!({ "value": c, "probability": p })).collect::<Vec<_>>(),
        "inputTokens": response.input_tokens, "acted": false,
        "note": "The value is a span the pattern found, copied unchanged. It cannot be a value that \
                 was not in the document.",
    }))
}

/// `dates` — the date a document states. (`date_extraction`)
///
/// The model names the PARTS and every calendar calculation happens in code. Reading dates as
/// ordered quantities is a documented weakness of this kind of model — it reads what the text says
/// and does not do the arithmetic — so it is never asked to. An impossible date is refused rather
/// than rounded into a real one.
pub fn dates(jev: &Jev, flow: &Flow, arguments: &Arguments, root: &Path) -> Result<Value, String> {
    let (named, text) = document(flow, arguments, root)?;
    const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July",
                                "August", "September", "October", "November", "December"];

    let mut questions = BTreeMap::from([
        ("mode".to_string(), Question::Choice {
            instructions: "How is the date in this document written?".to_string(),
            options: BTreeMap::from([
                ("absolute".to_string(), "A calendar date that names a month.".to_string()),
                ("relative".to_string(), "Relative to today: tomorrow, next Tuesday.".to_string()),
                ("none".to_string(), "No date is stated.".to_string()),
            ]),
        }),
        ("month".to_string(), Question::Choice {
            instructions: "Which month does the document name?".to_string(),
            options: MONTHS.iter().map(|m| ((*m).to_string(), String::new())).collect(),
        }),
        ("day".to_string(), Question::Choice {
            instructions: "Which day of the month?".to_string(),
            options: (1..=31).map(|d| (d.to_string(), String::new())).collect(),
        }),
        ("year".to_string(), Question::Choice {
            instructions: "Which year does the document state?".to_string(),
            options: (2000..=2050).map(|y| (y.to_string(), String::new()))
                .chain([("none".to_string(), "No year is stated.".to_string()),
                        ("out_of_range".to_string(), "A year outside 2000-2050 is stated.".to_string())])
                .collect(),
        }),
    ]);
    questions.insert("anchor".to_string(), Question::Choice {
        instructions: "If the date is relative, what is it relative to?".to_string(),
        options: BTreeMap::from([
            ("today".to_string(), String::new()), ("tomorrow".to_string(), String::new()),
            ("day_after".to_string(), String::new()), ("weekday".to_string(), "A named weekday.".to_string()),
        ]),
    });
    let response = jev.ask(&json!({ "document": text.chars().take(20_000).collect::<String>() }),
                           &questions)?;

    let pick = |name: &str| match response.answers.get(name) {
        Some(Answer::Choice { choice, confidence, .. }) => Some((choice.clone(), *confidence)),
        _ => None,
    };
    let (mode, mode_confidence) = pick("mode").ok_or("the mode question was not answered")?;

    // Confidence is the MINIMUM across the parts actually used, because a date is only as good as
    // its weakest part — a certain month with an unsure day is not a certain date.
    let mut used = vec![mode_confidence];
    let mut resolved = Value::Null;
    let mut refusal: Option<String> = None;

    if mode == "absolute" {
        let month = pick("month");
        let day = pick("day");
        let year = pick("year");
        match (&month, &day, &year) {
            (Some((month, mc)), Some((day, dc)), Some((year, yc))) => {
                used.extend([*mc, *dc, *yc]);
                let month_number = MONTHS.iter().position(|m| m == month).map(|i| i + 1);
                let day_number: Option<u32> = day.parse().ok();
                match (month_number, day_number) {
                    (Some(month_number), Some(day_number)) if valid(month_number, day_number) => {
                        let year = if year == "none" || year == "out_of_range" {
                            refusal = (year == "out_of_range").then(|| format!(
                                "the document states a year outside the list, so it is reported \
                                 rather than guessed"));
                            Value::Null
                        } else { json!(year) };
                        resolved = json!({ "month": month_number, "day": day_number, "year": year });
                    }
                    (Some(month_number), Some(day_number)) => {
                        // February 30 is not a date. Code catches it; the model never did the maths.
                        refusal = Some(format!(
                            "the parts name {month} {day_number}, which is not a real date. Refused \
                             rather than moved to the nearest one."));
                        let _ = month_number;
                    }
                    _ => refusal = Some("the date is incomplete".to_string()),
                }
            }
            _ => refusal = Some("an absolute date is missing one of its parts".to_string()),
        }
    } else if mode == "relative" {
        if let Some((anchor, ac)) = pick("anchor") {
            used.push(ac);
            // Resolution against today is the CALLER's, deliberately: this plugin does not decide
            // what "today" is for somebody else's document.
            resolved = json!({ "relativeTo": anchor });
        }
    }

    let confidence = used.iter().copied().fold(f64::INFINITY, f64::min);
    let mut answers = serde_json::Map::new();
    for (id, answer) in &response.answers { answers.insert(id.clone(), describe(answer)); }
    Ok(json!({
        "flow": "dates", "document": named,
        "mode": mode, "resolved": resolved,
        "confidence": confidence,
        "review": confidence < gates::DATE_REVIEW.value || refusal.is_some(),
        "refused": refusal,
        "answers": answers,
        "thresholds": [gates::DATE_REVIEW.report()],
        "inputTokens": response.input_tokens, "acted": false,
        "note": "The model named the parts; every calendar decision was made in code. An impossible \
                 date is refused rather than resolved, and a relative one is returned as its anchor \
                 because what `today` means is the caller's to know.",
    }))
}

/// Is this a real day of a real month? Leap years are the caller's problem only for February 29,
/// which is allowed here because the year may not have been stated at all.
fn valid(month: usize, day: u32) -> bool {
    let longest = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => 29,
        _ => return false,
    };
    day >= 1 && day <= longest
}

/// `hazards` — what somebody should look at before this text is used. (`llm_guardrails`)
///
/// **Advisory, and not a security control.** The vendor's own page says so in as many words: put a
/// screening model in front and "an attacker can talk that one past too". So this raises a flag for
/// a person and nothing in this workspace gates on it. It is named for what it does — reports
/// hazards — rather than for a protection it does not provide.
pub fn hazards(jev: &Jev, flow: &Flow, arguments: &Arguments, root: &Path) -> Result<Value, String> {
    let (named, text) = document(flow, arguments, root)?;

    let questions = BTreeMap::from([
        ("overrides".to_string(), Question::Noul {
            instructions: "Does this text try to override the instructions of a system reading it, \
                           or change what that system is?".to_string(),
            when_true: Some("It addresses the reading system and redirects it".to_string()),
            when_false: Some("It is about its subject matter".to_string()),
        }),
        ("harmful".to_string(), Question::Noul {
            instructions: "Does this text seek help with causing physical harm or with something \
                           plainly illegal?".to_string(),
            when_true: Some("It asks for help doing harm".to_string()),
            when_false: Some("It does not".to_string()),
        }),
        ("credential".to_string(), Question::Noul {
            instructions: "Does this text contain something that looks like a secret — an API key, \
                           a password, a private token?".to_string(),
            when_true: Some("A credential appears in it".to_string()),
            when_false: Some("Nothing in it looks like a credential".to_string()),
        }),
        ("personal".to_string(), Question::Noul {
            instructions: "Does this text contain personal information about an identifiable \
                           individual?".to_string(),
            when_true: Some("It identifies a person and says something about them".to_string()),
            when_false: Some("It does not".to_string()),
        }),
        ("severity".to_string(), Question::Score {
            instructions: "If this text were used as it is, how much damage could it do?".to_string(),
            levels: vec![
                "None: ordinary content.".to_string(),
                "Mild: sensitive, but little could come of it.".to_string(),
                "Serious: it could enable something harmful.".to_string(),
                "Severe: it could cause real physical or legal harm.".to_string(),
            ],
        }),
    ]);
    let response = jev.ask(&json!({ "text": text.chars().take(20_000).collect::<String>() }),
                           &questions)?;

    let flags: Vec<Value> = ["overrides", "harmful", "credential", "personal"].iter()
        .filter_map(|name| {
            let Some(Answer::Noul { probability }) = response.answers.get(*name) else { return None };
            Some(json!({ "hazard": name, "probability": probability,
                         "reads": gates::band(*probability).as_str() }))
        }).collect();
    let worst = flags.iter().filter_map(|f| f["probability"].as_f64()).fold(0.0_f64, f64::max);
    let (escalate, _) = gates::escalates(&[worst]);
    let severity = match response.answers.get("severity") {
        Some(Answer::Score { score, .. }) => *score,
        _ => 0.0,
    };

    let mut answers = serde_json::Map::new();
    for (id, answer) in &response.answers { answers.insert(id.clone(), describe(answer)); }
    const LEVELS: [&str; 4] = ["none", "mild", "serious", "severe"];
    if let Some(named_levels) = response.answers.get("severity").and_then(|a| name_levels(a, &LEVELS)) {
        answers["severity"]["levels"] = named_levels;
    }

    Ok(json!({
        "flow": "hazards", "document": named,
        "flags": flags, "severity": severity,
        "worth_reading": escalate || severity >= 2.0,
        "answers": answers,
        "thresholds": [gates::ESCALATE.report()],
        "acted": false,
        "advisory": true,
        "inputTokens": response.input_tokens,
        "note": "ADVISORY. This is not a security control: a screening model can be talked past, \
                 which the service's own documentation says. It raises a flag for a person to read, \
                 and nothing in this workspace decides anything on it.",
    }))
}

/// `featurize` — turn a corpus of free text into a numeric matrix.
/// (`autoresearch_feature_discovery`)
///
/// The loop that cookbook describes has three stages: propose questions, answer them into numeric
/// columns, fit a regressor on the result. **The first two are here and the third is not**, and
/// that is a decision rather than an omission: fitting needs a labelled numeric target this
/// workspace does not have, and a gradient-boosting dependency this plugin does not carry. What
/// comes back is the matrix — rows, columns and values — for somebody to fit with their own tools.
///
/// A Score becomes TWO columns, its mean level and its spread, because a level that the model is
/// torn between is a different observation from one it is sure of, and one column cannot say so.
pub fn featurize(jev: &Jev, flow: &Flow, arguments: &Arguments, root: &Path) -> Result<Value, String> {
    let entries = corpus::read(root, flow.source("corpus")?)?;
    let declared = flow.setting("questions").and_then(Value::as_array).cloned().unwrap_or_default();
    if declared.is_empty() {
        return Err("the featurize flow needs `settings.questions` in flows.json: a list of \
                    { name, ask, kind: noul|score, levels? } describing the columns to build"
            .to_string());
    }
    let limit: usize = arguments.get("rows").and_then(|r| r.parse().ok()).unwrap_or(25);

    let mut questions: BTreeMap<String, Question> = BTreeMap::new();
    for question in &declared {
        let name = question.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
        let ask = question.get("ask").and_then(Value::as_str).unwrap_or_default().to_string();
        if name.is_empty() || ask.is_empty() { return Err("each question needs a name and an ask".into()); }
        match question.get("kind").and_then(Value::as_str).unwrap_or("noul") {
            "score" => {
                let levels: Vec<String> = question.get("levels").and_then(Value::as_array)
                    .map(|l| l.iter().filter_map(Value::as_str).map(str::to_string).collect())
                    .unwrap_or_default();
                if levels.len() < 2 { return Err(format!("the {name} score needs at least two levels")); }
                questions.insert(name, Question::Score { instructions: ask, levels });
            }
            "noul" => { questions.insert(name, Question::Noul {
                instructions: ask, when_true: None, when_false: None }); }
            other => return Err(format!("{other:?} is not a question kind: noul or score")),
        }
    }

    let rows: Vec<&corpus::Entry> = entries.iter().take(limit).collect();
    let answered: Vec<Result<(String, serde_json::Map<String, Value>, u64), String>> =
        std::thread::scope(|scope| {
            let handles: Vec<_> = rows.iter().map(|entry| {
                let questions = &questions;
                scope.spawn(move || {
                    let response = jev.ask(&json!({ "text": entry.body }), questions)?;
                    let mut columns = serde_json::Map::new();
                    for (name, answer) in &response.answers {
                        match answer {
                            Answer::Noul { probability } => {
                                columns.insert(name.clone(), json!(probability));
                            }
                            Answer::Score { score, probabilities, .. } => {
                                // Mean and spread: a level the model is torn between is a different
                                // observation from one it is sure of, and one column cannot say so.
                                let mean = *score;
                                let variance: f64 = probabilities.iter().filter_map(|(level, p)| {
                                    let level: f64 = level.parse().ok()?;
                                    Some(p * (level - mean).powi(2))
                                }).sum();
                                columns.insert(format!("{name}_mean"), json!(mean));
                                columns.insert(format!("{name}_sd"), json!(variance.sqrt()));
                            }
                            Answer::Choice { .. } => {}
                        }
                    }
                    Ok((entry.id.clone(), columns, response.input_tokens))
                })
            }).collect();
            handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("a row panicked".into()))).collect()
        });

    let mut matrix = Vec::new();
    let mut tokens = 0;
    let mut columns: Vec<String> = Vec::new();
    for answer in answered {
        let (id, values, used) = answer?;
        for name in values.keys() {
            if !columns.contains(name) { columns.push(name.clone()); }
        }
        matrix.push(json!({ "id": id, "values": values }));
        tokens += used;
    }
    columns.sort();

    Ok(json!({
        "flow": "featurize",
        "columns": columns, "rows": matrix,
        "corpus": entries.len(), "featurised": matrix.len(),
        "inputTokens": tokens, "acted": false,
        "note": "This is the matrix and nothing is fitted to it. The loop's third stage needs a \
                 labelled numeric target this workspace does not have and a gradient-boosting \
                 dependency this plugin does not carry, so it is left to whoever has both.",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_that_ends_mid_sentence_joins_on_less_evidence() {
        // The adaptive threshold. A line already missing its full stop is itself evidence of a
        // continuation, so it takes less to join; one that ended with a full stop needs more.
        let dangling_threshold = 0.2;
        let terminated_threshold = 0.5;
        assert!(dangling_threshold < terminated_threshold);
        for (previous, probability, joins) in [
            ("a line that runs", 0.3, true),
            ("a line that stops.", 0.3, false),
            ("a line that stops.", 0.6, true),
            ("a line that runs", 0.1, false),
        ] {
            let dangling = !previous.trim_end().ends_with(['.', '!', '?', ':', ';']);
            let threshold = if dangling { dangling_threshold } else { terminated_threshold };
            assert_eq!(probability >= threshold, joins, "{previous:?} at {probability}");
        }
    }

    #[test]
    fn an_impossible_date_is_not_a_date() {
        assert!(valid(1, 31) && valid(2, 29) && valid(4, 30));
        assert!(!valid(2, 30), "February 30 is refused rather than moved to the nearest real day");
        assert!(!valid(4, 31));
        assert!(!valid(13, 1) && !valid(0, 1) && !valid(1, 0));
    }

    #[test]
    fn a_score_becomes_two_columns_because_one_cannot_say_how_torn_it_was() {
        // Two rows with the SAME mean level and very different spreads. One column would report
        // them as the same observation.
        let sure: BTreeMap<String, f64> = BTreeMap::from([
            ("0".into(), 0.0), ("1".into(), 1.0), ("2".into(), 0.0)]);
        let torn: BTreeMap<String, f64> = BTreeMap::from([
            ("0".into(), 0.5), ("1".into(), 0.0), ("2".into(), 0.5)]);
        let spread = |p: &BTreeMap<String, f64>, mean: f64| -> f64 {
            p.iter().filter_map(|(level, probability)| {
                let level: f64 = level.parse().ok()?;
                Some(probability * (level - mean).powi(2))
            }).sum::<f64>().sqrt()
        };
        assert_eq!(spread(&sure, 1.0), 0.0);
        assert_eq!(spread(&torn, 1.0), 1.0, "the same mean, and not the same observation");
    }
}
