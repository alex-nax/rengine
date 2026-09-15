//! Reading a conversation id out of a CLI's own argv — the read side of the resume spellings the
//! recipe declares (F171/F213, specs 129 and 141).
//!
//! **This file knows no agent by name.** It implements the two SPELLINGS a recipe can declare in
//! `conversation.read`, named for what they do:
//!
//! - `flags` — naming flags carry the id (`--session-id X`, `--resume=X`), and separate opaque
//!   flags mean "a conversation only the CLI can see". claude and kimi both spell it this way and
//!   differ only in which flags those are, which is data.
//! - `subcommand` — a bare positional after a word carries the id (`codex resume X`), with
//!   value-taking flags skipped so their values are not mistaken for it.
//!
//! The id's SHAPE is never hand-rolled here. `conversation.ids` is a regular expression the recipe
//! already declares and `launch.rs` already matches with a real engine; this matches the same one.
//! Three copies of that shape existed before spec 141 — declared once, hand-rolled twice, and the
//! hand-rolled pair disagreed with the declaration about kimi's ULIDs.
//!
//! What the answer means, for every spelling: **named** (an id the CLI was given), **unknown** (a
//! selection only the CLI sees — a bare resume or continue), or **minted** (nothing named, so the
//! CLI will name its own).

use serde_json::Value as Json;

/// The answer both spellings give: `(id, source)` with source `flag` | `unknown` | `minted`.
pub type Parsed = (Option<String>, &'static str);

fn strings(value: Option<&Json>) -> Vec<String> {
    value
        .and_then(Json::as_array)
        .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn text<'a>(value: &'a Json, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Json::as_str)
}

fn named_or_opaque(named: Option<String>, opaque: bool) -> Parsed {
    if opaque {
        (None, "unknown")
    } else if let Some(id) = named {
        (Some(id), "flag")
    } else {
        (None, "minted")
    }
}

/// The shape the recipe declares, matched with a real engine. A recipe that declares no shape
/// accepts nothing as named: an id nobody can describe is not an id this can hand on.
fn shaped(talk: &Json, id: &str) -> bool {
    let Some(pattern) = text(talk, "ids") else { return false };
    regex::RegexBuilder::new(pattern)
        .case_insensitive(true)
        .build()
        .map(|expression| expression.is_match(id))
        .unwrap_or(false)
}

/// `normalize` is the recipe's too: claude and codex lowercase their ids, kimi keeps its case.
fn normalized(talk: &Json, id: &str) -> String {
    match text(talk, "normalize") {
        Some("lowercase") => id.to_ascii_lowercase(),
        _ => id.to_string(),
    }
}

/// Naming flags carry the id; opaque flags mean the CLI chose for itself. Every flag is read, the
/// last naming one wins, and any opaque flag makes the whole launch unknown — a launch that both
/// names a conversation and asks the CLI to pick is not a launch this can predict.
fn read_flags(talk: &Json, read: &Json, args: &[String]) -> Parsed {
    let names = strings(read.get("names"));
    let opaque_flags = strings(read.get("opaque"));
    let mut named: Option<String> = None;
    let mut opaque = false;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        /* `--flag=value` counts as naming: the value is inline and no argument is consumed. */
        let (flag, inline) = match arg.strip_prefix("--").and_then(|rest| rest.split_once('=')) {
            Some((flag, value)) => (arg[..2 + flag.len()].to_string(), Some(value.to_string())),
            None => (arg.clone(), None),
        };
        if opaque_flags.iter().any(|known| known == &flag) {
            opaque = true;
        } else if names.iter().any(|known| known == &flag) {
            let value = inline.or_else(|| args.get(index + 1).cloned());
            if value.is_some() && !args[index].contains('=') {
                index += 1;
            }
            match value {
                Some(id) if shaped(talk, &id) => named = Some(normalized(talk, &id)),
                /* A naming flag carrying something the declared shape refuses is not nothing: the
                   CLI was told something this cannot read, so the launch is unknown, not minted. */
                _ => opaque = true,
            }
        }
        index += 1;
    }
    named_or_opaque(named, opaque)
}

/// The id is a positional after a declared word. Flags that take values are skipped WITH their
/// values, so `-m gpt-5 resume X` reads X rather than `gpt-5`; the scan stops at the first bare
/// word, because a subcommand is the first thing that is not a flag.
fn read_subcommand(talk: &Json, read: &Json, args: &[String]) -> Parsed {
    let word = text(read, "word").unwrap_or_default();
    let value_flags = strings(read.get("valueFlags"));
    let mut named: Option<String> = None;
    let mut opaque = false;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if value_flags.iter().any(|known| known == arg) {
            index += 2;
            continue;
        }
        if arg.starts_with('-') {
            index += 1;
            continue;
        }
        if arg == word {
            match args.get(index + 1) {
                Some(id) if shaped(talk, id) => named = Some(normalized(talk, id)),
                /* A bare `resume` opens the CLI's own picker: a conversation only it can see. */
                _ => opaque = true,
            }
        }
        break;
    }
    named_or_opaque(named, opaque)
}

/// What a launch's argv says about which conversation it will be, for the spelling this recipe
/// declares. `None` when the recipe declares no read spelling — which is an honest "this CLI has
/// not told us how to read it", not a guess.
pub fn read(talk: &Json, args: &[String]) -> Option<Parsed> {
    let read = talk.get("read")?;
    match text(read, "kind") {
        Some("flags") => Some(read_flags(talk, read, args)),
        Some("subcommand") => Some(read_subcommand(talk, read, args)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /* The three recipes as the registry declares them, so these tests exercise the declaration
       rather than a restatement of it. */
    fn claude() -> Json {
        json!({
            "ids": r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$",
            "normalize": "lowercase",
            "read": { "kind": "flags", "names": ["--session-id", "--resume", "-r"], "opaque": ["--fork-session", "-c", "--continue"] },
        })
    }
    fn kimi() -> Json {
        json!({
            "ids": r"^(?:session_)?(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$",
            "normalize": "none",
            "read": { "kind": "flags", "names": ["--session", "-S", "--resume", "-r"], "opaque": ["-c", "--continue"] },
        })
    }
    fn codex() -> Json {
        json!({
            "ids": r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$",
            "normalize": "lowercase",
            "read": { "kind": "subcommand", "word": "resume", "valueFlags": ["-c", "--config", "-m", "--model", "-p", "--profile", "-i", "--image"] },
        })
    }
    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    const UUID: &str = "0199C9A2-1F5E-7A31-B1D9-7C0C9C2A4E11";

    #[test]
    fn a_naming_flag_carries_the_id_and_the_recipe_normalises_it() {
        assert_eq!(read(&claude(), &args(&["--session-id", UUID])).unwrap(), (Some(UUID.to_ascii_lowercase()), "flag"));
        assert_eq!(read(&claude(), &args(&[&format!("--resume={UUID}")])).unwrap(), (Some(UUID.to_ascii_lowercase()), "flag"));
        /* kimi declares normalize = none, so its id keeps the case it arrived in. */
        assert_eq!(read(&kimi(), &args(&["--session", UUID])).unwrap(), (Some(UUID.to_string()), "flag"));
    }

    #[test]
    fn an_opaque_flag_makes_the_whole_launch_unknown() {
        assert_eq!(read(&claude(), &args(&["--continue"])).unwrap(), (None, "unknown"));
        assert_eq!(read(&claude(), &args(&["--session-id", UUID, "--fork-session"])).unwrap(), (None, "unknown"));
        /* --fork-session is claude's alone: kimi's recipe does not list it, so it is just a flag. */
        assert_eq!(read(&kimi(), &args(&["--fork-session"])).unwrap(), (None, "minted"));
    }

    #[test]
    fn nothing_named_is_minted_rather_than_unknown() {
        assert_eq!(read(&claude(), &args(&[])).unwrap(), (None, "minted"));
        assert_eq!(read(&codex(), &args(&[])).unwrap(), (None, "minted"));
    }

    /* The bug two hand-rolled copies had: kimi accepts a ULID and a `session_` prefix, which the
       declared pattern says and a substring sniff got wrong. */
    #[test]
    fn the_declared_pattern_decides_the_shape_not_a_hand_rolled_one() {
        let ulid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        assert_eq!(read(&kimi(), &args(&["--session", ulid])).unwrap(), (Some(ulid.to_string()), "flag"));
        assert_eq!(read(&kimi(), &args(&["--session", &format!("session_{ulid}")])).unwrap(),
                   (Some(format!("session_{ulid}")), "flag"));
        /* claude's pattern refuses a ULID, so the same argv reads unknown for claude. */
        assert_eq!(read(&claude(), &args(&["--resume", ulid])).unwrap(), (None, "unknown"));
    }

    #[test]
    fn a_subcommand_reads_the_positional_past_flags_that_take_values() {
        assert_eq!(read(&codex(), &args(&["resume", UUID])).unwrap(), (Some(UUID.to_ascii_lowercase()), "flag"));
        assert_eq!(read(&codex(), &args(&["-m", "gpt-5", "resume", UUID])).unwrap(), (Some(UUID.to_ascii_lowercase()), "flag"));
        /* A bare resume is the CLI's own picker. */
        assert_eq!(read(&codex(), &args(&["resume"])).unwrap(), (None, "unknown"));
    }

    #[test]
    fn a_recipe_that_declares_no_spelling_is_refused_rather_than_guessed() {
        let silent = json!({ "ids": "^x$", "normalize": "none" });
        assert!(read(&silent, &args(&["--resume", UUID])).is_none());
    }
}
