//! The conversation flag parsers: the read side of each CLI's resume spellings (F171, spec 129,
//! KI-093). Ported from registry.mjs's claudeFlags/kimiFlags/codexResume, whose id shapes are
//! regular expressions there — hand-rolled here, because the shapes are small and a regex
//! dependency would be the crate's first for three char classes.
//!
//! What the CLI's own argv says about which conversation a launch will be, for each spelling:
//! named (an id the CLI was given), unknown (a selection only the CLI sees — a bare
//! resume/continue), or minted (nothing named, the CLI will name its own).

/// `[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}`, case-insensitive.
fn uuid_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    })
}

/// `[0-9A-HJKMNP-TV-Z]{26}`, case-insensitive (the JS side tests with the i flag).
fn ulid_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 26
        && bytes.iter().all(|byte| {
            matches!(byte.to_ascii_uppercase(), b'0'..=b'9' | b'A'..=b'H' | b'J'..=b'K' | b'M'..=b'N' | b'P'..=b'T' | b'V'..=b'Z')
        })
}

/// Kimi's ids: an optional `session_` (any case) over either shape.
fn kimi_id_shape(value: &str) -> bool {
    let body = value.get(8..).filter(|_| value[..8].eq_ignore_ascii_case("session_")).unwrap_or(value);
    uuid_shape(body) || ulid_shape(body)
}

/// The answer both sides give: `(id, source)` with source flag | unknown | minted.
pub type Parsed = (Option<String>, &'static str);

fn named_or_opaque<T>(named: Option<T>, opaque: bool) -> Parsed
where
    T: Into<String>,
{
    if opaque {
        (None, "unknown")
    } else if let Some(id) = named {
        (Some(id.into()), "flag")
    } else {
        (None, "minted")
    }
}

/// claude: `--session-id`/`--resume`/`-r` name it (inline `--flag=value` counts); `-c`,
/// `--continue`, `--fork-session` are opaque. Every flag is read; the last naming wins and any
/// opaque makes the whole launch unknown.
pub fn claude_flags(args: &[String]) -> Parsed {
    let mut named: Option<String> = None;
    let mut opaque = false;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        let (flag, inline) = match arg.strip_prefix("--").and_then(|rest| rest.split_once('=')) {
            Some((flag, value)) => (arg[..2 + flag.len()].to_string(), Some(value.to_string())),
            None => (arg.clone(), None),
        };
        if flag == "--fork-session" || flag == "-c" || flag == "--continue" {
            opaque = true;
        } else if ["--session-id", "--resume", "-r"].contains(&flag.as_str()) {
            let value = inline.or_else(|| args.get(index + 1).cloned());
            if value.is_some() && !args[index].contains('=') {
                index += 1;
            }
            match value {
                Some(id) if uuid_shape(&id) => named = Some(id.to_lowercase()),
                _ => opaque = true,
            }
        }
        index += 1;
    }
    named_or_opaque(named, opaque)
}

/// kimi: `--session`/`-S`/`--resume`/`-r` name it (the id keeps its case); `-c`/`--continue` are
/// opaque. Same last-wins, any-opaque-unknown reading as claude's.
pub fn kimi_flags(args: &[String]) -> Parsed {
    let mut named: Option<String> = None;
    let mut opaque = false;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        let (flag, inline) = match arg.strip_prefix("--").and_then(|rest| rest.split_once('=')) {
            Some((flag, value)) => (arg[..2 + flag.len()].to_string(), Some(value.to_string())),
            None => (arg.clone(), None),
        };
        if flag == "-c" || flag == "--continue" {
            opaque = true;
        } else if ["--session", "-S", "--resume", "-r"].contains(&flag.as_str()) {
            let value = inline.or_else(|| args.get(index + 1).cloned());
            if value.is_some() && !args[index].contains('=') {
                index += 1;
            }
            match value {
                Some(id) if kimi_id_shape(&id) => named = Some(id),
                _ => opaque = true,
            }
        }
        index += 1;
    }
    named_or_opaque(named, opaque)
}

/// `codex resume <id>` is a subcommand, not a flag: the first positional decides it, flags that
/// take values are skipped with their values, and a bare `codex resume` opens the CLI's picker.
pub fn codex_resume(args: &[String]) -> Parsed {
    const VALUE_FLAGS: [&str; 8] = ["-c", "--config", "-m", "--model", "-p", "--profile", "-i", "--image"];
    let mut named: Option<String> = None;
    let mut opaque = false;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if VALUE_FLAGS.contains(&arg.as_str()) {
            index += 2;
            continue;
        }
        if arg.starts_with('-') {
            index += 1;
            continue;
        }
        if arg == "resume" {
            match args.get(index + 1) {
                Some(id) if uuid_shape(id) => named = Some(id.to_lowercase()),
                _ => opaque = true,
            }
        }
        break;
    }
    named_or_opaque(named, opaque)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    const UUID: &str = "3f85774e-05bb-4791-bb9f-1c90dc37d0e6";
    const ULID: &str = "01M2AGK5YNB630T8HJ2SQPXR3B";

    #[test]
    fn the_id_shapes_hold() {
        assert!(uuid_shape(UUID));
        assert!(uuid_shape(&UUID.to_uppercase()));
        assert!(!uuid_shape("not-a-uuid"));
        assert!(!uuid_shape(&UUID[..35]));
        assert!(ulid_shape(ULID));
        assert!(ulid_shape(&ULID.to_lowercase()), "the JS i flag takes lowercase too");
        assert!(!ulid_shape("01M2AGK5YNB630T8HJ2SQPXR3!"));
        assert!(!ulid_shape("01M2AGK5YNB630T8HJ2SQPXR3l"), "l is not in the alphabet");
        assert!(kimi_id_shape(&format!("session_{UUID}")));
        assert!(kimi_id_shape(&format!("SESSION_{UUID}")));
        assert!(kimi_id_shape(ULID));
        assert!(!kimi_id_shape("session_garbage"));
    }

    #[test]
    fn claude_reads_the_way_the_js_side_reads() {
        assert_eq!(claude_flags(&args(&["--session-id", UUID])), (Some(UUID.to_string()), "flag"));
        assert_eq!(claude_flags(&args(&["--resume", &UUID.to_uppercase()])), (Some(UUID.to_string()), "flag"));
        assert_eq!(claude_flags(&args(&[&format!("--session-id={UUID}")])), (Some(UUID.to_string()), "flag"));
        assert_eq!(claude_flags(&args(&["-c"])), (None, "unknown"));
        assert_eq!(claude_flags(&args(&["--fork-session"])), (None, "unknown"));
        assert_eq!(claude_flags(&args(&["--session-id", "not-a-uuid"])), (None, "unknown"));
        assert_eq!(claude_flags(&args(&["--resume", UUID, "-c"])), (None, "unknown"));
        assert_eq!(claude_flags(&args(&[])), (None, "minted"));
        assert_eq!(claude_flags(&args(&["--resume"])), (None, "unknown"), "a flag without its value is opaque");
    }

    #[test]
    fn kimi_keeps_the_ids_case_and_the_picker_stays_opaque() {
        let kimi_id = format!("session_{UUID}");
        assert_eq!(kimi_flags(&args(&["--session", &kimi_id])), (Some(kimi_id.clone()), "flag"));
        assert_eq!(kimi_flags(&args(&["-S", &kimi_id])), (Some(kimi_id), "flag"));
        assert_eq!(kimi_flags(&args(&["--resume", ULID])), (Some(ULID.to_string()), "flag"));
        assert_eq!(kimi_flags(&args(&[&format!("--session={ULID}")])), (Some(ULID.to_string()), "flag"));
        assert_eq!(kimi_flags(&args(&["--continue"])), (None, "unknown"));
        assert_eq!(kimi_flags(&args(&[])), (None, "minted"));
    }

    #[test]
    fn codex_resume_is_a_subcommand() {
        assert_eq!(codex_resume(&args(&["resume", UUID])), (Some(UUID.to_string()), "flag"));
        assert_eq!(codex_resume(&args(&["-m", "gpt-5", "resume", UUID])), (Some(UUID.to_string()), "flag"));
        assert_eq!(codex_resume(&args(&["--model=gpt-5", "resume", UUID])), (Some(UUID.to_string()), "flag"));
        assert_eq!(codex_resume(&args(&["resume"])), (None, "unknown"));
        assert_eq!(codex_resume(&args(&["resume", "not-a-uuid"])), (None, "unknown"));
        assert_eq!(codex_resume(&args(&["exec", "resume", UUID])), (None, "minted"));
        assert_eq!(codex_resume(&args(&[])), (None, "minted"));
    }
}
