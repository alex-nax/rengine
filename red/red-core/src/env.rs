//! What this process was told about its own machine, resolved so a caller can use it.
//!
//! One function's worth of module, and it earns the file: the values here are EXPORTED into other
//! processes and baked into a compiled binary, so "close enough for a shell" is not close enough.
//! Two callers do not go through a shell — `execv` in the desktop's bootstrap, and `[ -x "$VAR" ]`
//! in every `editor.sh` on the machine — and both read a bare name as "not there" while printing
//! something else, or nothing at all.

/// The node a pane's launcher runs, and the one the desktop's build is told about.
///
/// **It resolves to an absolute path.** The JS host passed `process.execPath` and never had to
/// think about this; a fallback to the bare word `node` is correct only for a caller that goes
/// through a shell. It is not correct for the two callers that do not: `execv` does not search
/// PATH, so a desktop built with the bare word fails its layered bootstrap silently, and a script
/// handed `RENGINE_NODE=node` in its environment asks `[ -x "$RENGINE_NODE" ]`, gets a no, and
/// reports node missing on a machine that has it. Both are real; both read as something else.
///
/// A name PATH does not answer is returned as it came, so the caller refuses it by name rather
/// than inventing a path that is not there.
pub fn node_path() -> String {
    for name in ["RENGINE_NODE", "RENGINE_NODE_EXECUTABLE"] {
        if let Some(declared) = std::env::var(name).ok().filter(|value| !value.is_empty()) {
            return on_path(&declared);
        }
    }
    on_path("node")
}

/// A bare command name resolved against PATH, the way a shell would; anything already carrying a
/// separator, or a name PATH does not answer, is returned unchanged.
pub fn on_path(command: &str) -> String {
    if command.contains(std::path::MAIN_SEPARATOR) {
        return command.to_string();
    }
    let Ok(path) = std::env::var("PATH") else { return command.to_string() };
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(command);
        if std::fs::metadata(&candidate).is_ok_and(|meta| meta.is_file()) {
            return candidate.to_string_lossy().into_owned();
        }
    }
    command.to_string()
}

#[cfg(test)]
mod tests {
    /* KI-113's shape, in a different variable: what a pane is HANDED has to be usable by a caller
       that does not go through a shell. `RENGINE_NODE=node` is what the door exported for months —
       `agent.sh` survived it because `${RENGINE_NODE:-node}` runs through a shell, and every
       editor.sh on this machine reported node MISSING on a machine that has it, because
       `[ -x node ]` is a no. The desktop's own bootstrap fails the same way, through `execv`, and
       prints nothing at all. */
    #[test]
    fn the_node_a_pane_is_handed_is_a_path_a_caller_can_test() {
        /* `RENGINE_NODE=node` is the exact value the door exported, so it is the exact value the
           resolver is judged on — not read from the environment, because a test that reads its own
           environment passes on the machine that set it and asserts nothing anywhere else. */
        let handed = super::on_path("node");
        assert!(
            std::path::Path::new(&handed).is_absolute(),
            "a bare name reaches callers that cannot search PATH (execv, and `[ -x ]`): {handed}"
        );
        assert!(std::fs::metadata(&handed).is_ok_and(|meta| meta.is_file()), "{handed} must be a file a caller can exec");
        /* The two shapes that are NOT PATH's to answer come back exactly as they came. */
        assert_eq!(super::on_path("/usr/local/bin/node"), "/usr/local/bin/node");
        let absent = "rengine-no-such-command-98f3a1";
        assert_eq!(super::on_path(absent), absent, "a name PATH cannot answer is refused by name, not invented");
    }
}
