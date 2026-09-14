//! One question per run, answered as JSON on stdout (F156c, spec 129).
//!
//!   red-project recordings <rootId> <rootPath> [limit]
//!   red-project recording  <rootId> <rootPath> <id> [artifact] [offset] [limit] [maxCharacters]
//!
//! A refusal is `{"error": …, "status": N}` and exit 1, because the JS client this answers turns it
//! back into the same `fail()` the module it replaced threw. Both of this crate's callers — the
//! Rust host, which links the library, and the JS worker, which runs this — get one implementation.

use std::process::ExitCode;

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let arg = |index: usize| argv.get(index).map(String::as_str).filter(|value| !value.is_empty());
    let answer = match arg(0) {
        Some("recordings") => red_project::recordings::list(arg(1).unwrap_or_default(), arg(2).unwrap_or_default(), arg(3)),
        Some("recording") => red_project::recordings::read(
            arg(1).unwrap_or_default(),
            arg(2).unwrap_or_default(),
            arg(3).unwrap_or_default(),
            arg(4),
            arg(5),
            arg(6),
            arg(7),
        ),
        other => {
            eprintln!("red-project: unknown question {}", other.unwrap_or("(none)"));
            return ExitCode::from(2);
        }
    };
    match answer {
        Ok(value) => {
            println!("{value}");
            ExitCode::SUCCESS
        }
        Err(fail) => {
            println!("{}", serde_json::json!({ "error": fail.message, "status": fail.status }));
            ExitCode::FAILURE
        }
    }
}
