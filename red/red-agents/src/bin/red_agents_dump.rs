//! Prints the resolved recipe projection of a registry TOML document as JSON.
//!
//! A binary rather than only a Rust test because the parity judge belongs to the JS suite: it
//! knows the cooked recipes the JS runtime actually serves, and this end owns the only question
//! Rust can answer — whether the same document resolves to the same atoms here (F148a; the
//! harness shape red-contract established in F140).
//!
//!   red-agents-dump <registry.toml> [--extra <extra.toml>]
//!
//! Exit 0 and the projection on stdout; exit 2 on a usage or read error; exit 1 with the
//! parser's or cook's file:line refusal on stderr when the document is rejected.

use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(registry) = args.next() else {
        eprintln!("usage: red-agents-dump <registry.toml> [--extra <extra.toml>]");
        return ExitCode::from(2);
    };
    let extra = match (args.next().as_deref(), args.next()) {
        (None, None) => None,
        (Some("--extra"), Some(path)) => Some(path),
        _ => {
            eprintln!("usage: red-agents-dump <registry.toml> [--extra <extra.toml>]");
            return ExitCode::from(2);
        }
    };
    let read = |path: &str| match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) => {
            eprintln!("red-agents-dump: cannot read {path}: {error}");
            Err(ExitCode::from(2))
        }
    };
    let registry_text = match read(&registry) {
        Ok(text) => text,
        Err(code) => return code,
    };
    let extra_pair = match extra.map(|path| read(&path).map(|text| (text, path))) {
        None => None,
        Some(Ok(pair)) => Some(pair),
        Some(Err(code)) => return code,
    };
    let recipes = match red_agents::load_registry(
        &registry_text,
        &registry,
        extra_pair.as_ref().map(|(text, path)| (text.as_str(), path.as_str())),
    ) {
        Ok(recipes) => recipes,
        Err(error) => {
            eprintln!("red-agents-dump: {error}");
            return ExitCode::from(1);
        }
    };
    println!("{}", serde_json::to_string_pretty(&red_agents::projection(&recipes)).expect("atoms serialize"));
    ExitCode::SUCCESS
}
