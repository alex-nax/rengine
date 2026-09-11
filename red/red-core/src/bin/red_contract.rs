//! Reads a JSON bundle captured from a LIVE session host and reports contract drift
//! (spec 128, decision 5; F140 criterion 1).
//!
//! A binary rather than a Rust test because the live host belongs to the JS suite: that harness
//! knows how to start a workspace, make a root, spawn a session and read the feed. This end owns
//! the only question Rust can answer — whether the contract can carry what came back.
//!
//!   red-contract <bundle.json>
//!
//! Exit 0 and a one-line summary when every shape translated; exit 1 and one line per disagreement
//! otherwise, each naming the path and what was wrong with it.

use std::process::ExitCode;

use red_core::translate::{self, Drift};

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(path) = args.next() else {
        eprintln!("usage: red-contract <bundle.json>");
        return ExitCode::from(2);
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) => { eprintln!("red-contract: cannot read {path}: {error}"); return ExitCode::from(2); }
    };
    let bundle: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => { eprintln!("red-contract: {path} is not JSON: {error}"); return ExitCode::from(2); }
    };

    let mut drift: Vec<Drift> = Vec::new();
    let mut checked = 0usize;

    // Every section is optional so the harness can grow one at a time, but a bundle that carries
    // nothing is a pass that proved nothing — refused below.
    if let Some(value) = bundle.get("workspace") { let (_, d) = translate::workspace(value); drift.extend(d); checked += 1; }
    if let Some(value) = bundle.get("dashboard") { let (_, d) = translate::dashboard(value); drift.extend(d); checked += 1; }
    if let Some(value) = bundle.get("tasks") { let (_, d) = translate::task_list(value); drift.extend(d); checked += 1; }
    if let Some(value) = bundle.get("agents") { let (_, d) = translate::agent_menu(value); drift.extend(d); checked += 1; }
    if let Some(value) = bundle.get("token") { let (_, d) = translate::token(value); drift.extend(d); checked += 1; }
    if let Some(serde_json::Value::Array(events)) = bundle.get("feed") {
        for (index, event) in events.iter().enumerate() {
            let (_, d) = translate::feed_event(&format!("feed[{index}]"), event);
            drift.extend(d);
            checked += 1;
        }
    }

    if checked == 0 {
        eprintln!("red-contract: {path} carried no shape this contract knows; a check that examined nothing is not a pass");
        return ExitCode::from(2);
    }
    if drift.is_empty() {
        println!("red-contract: {checked} shape(s) from the live host translate into red.v1 with nothing left over");
        return ExitCode::SUCCESS;
    }
    eprintln!("red-contract: the live host and the red.v1 contract disagree in {} place(s):", drift.len());
    for item in &drift {
        eprintln!("  {item}");
    }
    ExitCode::FAILURE
}
