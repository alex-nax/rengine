//! One question per run, answered as JSON on stdout (F156c, spec 129).
//!
//!   red-project declaration <rootPath> [declarationFile]
//!   red-project recordings <rootId> <rootPath> [limit]
//!   red-project recording  <rootId> <rootPath> <id> [artifact] [offset] [limit] [maxCharacters]
//!   red-project env-rules                    the env object on stdin, its problems on stdout
//!
//! A refusal is `{"error": …, "status": N}` and exit 1, because the JS client this answers turns it
//! back into the same `fail()` the module it replaced threw. Both of this crate's callers — the
//! Rust host, which links the library, and the JS worker, which runs this — get one implementation.

use std::process::ExitCode;

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let arg = |index: usize| argv.get(index).map(String::as_str).filter(|value| !value.is_empty());
    let answer = match arg(0) {
        /* The one question whose subject is not a path: an env object a caller proposes, judged by
           the same rules a declared action's env is judged by. It arrives on stdin rather than in
           argv because it is arbitrary caller input and argv has a length a caller could reach. */
        Some("env-rules") => {
            let mut text = String::new();
            match std::io::Read::read_to_string(&mut std::io::stdin(), &mut text) {
                Ok(_) => {
                    /* Absence and null are different answers: a request that names no env has no
                       rules to break, and one whose env is null is refused by name. */
                    let named: serde_json::Value = serde_json::from_str(text.trim()).unwrap_or(serde_json::Value::Null);
                    let env = named.get("env");
                    Ok(serde_json::json!({ "problems": red_project::rules::env_rules(env, "env") }))
                }
                Err(error) => Err(red_project::recordings::Fail { message: format!("cannot read the env: {error}"), status: 400 }),
            }
        }
        Some("recordings") => red_project::recordings::list(arg(1).unwrap_or_default(), arg(2).unwrap_or_default(), arg(3)),
        Some("declaration") => Ok(red_project::declaration::read(arg(1).unwrap_or_default(), arg(2))),
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
