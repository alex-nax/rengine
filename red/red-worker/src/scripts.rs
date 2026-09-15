//! Which script a person may open as a tab, and with what (F158, spec 129).
//!
//! An interactive script tab is a first-class workflow surface here, and the thing it runs is named
//! by whoever asked. So this is where the asking is judged, and it is judged on the resolved path
//! rather than on the string: `realpath` first, then ask whether what came back is still inside the
//! project. A check that reasoned about `..` in the text would be fooled by a symlink, which is the
//! one shape that matters — a link inside a project pointing anywhere at all.
//!
//! The arguments are bounded the same way a declared action's are, because they reach the same
//! shell: sixty-four of them, four kilobytes each, and no NUL — a NUL truncates an argument at the
//! exec boundary, so a caller that sent one would be running something other than what it read.

use std::path::{Component, Path, PathBuf};

/// Why this script cannot be opened. The sentences are the JavaScript's, and the statuses with them.
#[derive(Debug, Clone, PartialEq)]
pub struct Refused {
    pub message: String,
    pub status: u16,
}

fn refuse(message: &str, status: u16) -> Refused {
    Refused { message: message.to_string(), status }
}

/// The `.sh` a caller named, as a path inside the project — or why it is not one.
///
/// `resolve` is handed in so this can be tested without a filesystem AND so the real one is
/// `realpath`: the check is about where a path ENDS UP, and only the filesystem knows that.
pub fn script_path(
    root: &Path,
    asked: Option<&str>,
    resolve: &dyn Fn(&Path) -> Option<PathBuf>,
) -> Result<PathBuf, Refused> {
    /* The shape first, on the string as it arrived: absolute, not a `.sh`, or carrying a NUL are
       all answers that need no filesystem, and a NUL must never reach one. */
    let asked = asked.unwrap_or_default();
    if asked.is_empty() || Path::new(asked).is_absolute() || !asked.ends_with(".sh") || asked.contains('\0') {
        return Err(refuse("Choose a project-relative .sh script.", 400));
    }
    let Some(script) = resolve(&root.join(asked)) else {
        return Err(refuse("Script escapes the bound project.", 403));
    };
    /* Resolved, then asked: a link inside the project pointing outside it is the shape a textual
       check misses, and the reason this waits for the filesystem's answer. */
    let Some(root) = resolve(root) else {
        return Err(refuse("Script escapes the bound project.", 403));
    };
    if script == root || !script.starts_with(&root) {
        return Err(refuse("Script escapes the bound project.", 403));
    }
    /* And nothing that walks back up: `starts_with` is by component, but a resolved path that still
       carries `..` has not been resolved. */
    if script.components().any(|part| part == Component::ParentDir) {
        return Err(refuse("Script escapes the bound project.", 403));
    }
    Ok(script)
}

/// The arguments a script is handed, bounded as a declared action's are.
pub fn script_arguments(asked: Option<&serde_json::Value>) -> Result<Vec<String>, Refused> {
    let Some(asked) = asked.filter(|value| !value.is_null()) else { return Ok(Vec::new()) };
    let bad = || refuse("Script arguments must be a bounded string array.", 400);
    let listed = asked.as_array().filter(|items| items.len() <= 64).ok_or_else(bad)?;
    let mut arguments = Vec::with_capacity(listed.len());
    for value in listed {
        let text = value.as_str().ok_or_else(bad)?;
        if text.len() > 4096 || text.contains('\0') {
            return Err(bad());
        }
        arguments.push(text.to_string());
    }
    Ok(arguments)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in filesystem: every path resolves to itself with `..` collapsed, and the named
    /// links resolve to what they point at.
    fn filesystem<'a>(links: &'a [(&'static str, &'static str)]) -> impl Fn(&Path) -> Option<PathBuf> + 'a {
        move |path: &Path| {
            let text = path.to_string_lossy().to_string();
            for (from, to) in links {
                if text == *from {
                    return Some(PathBuf::from(*to));
                }
            }
            let mut out = PathBuf::new();
            for part in path.components() {
                match part {
                    Component::ParentDir => {
                        out.pop();
                    }
                    other => out.push(other),
                }
            }
            Some(out)
        }
    }

    fn root() -> PathBuf {
        PathBuf::from("/work/project")
    }

    #[test]
    fn a_project_relative_shell_script_is_opened() {
        let resolved = script_path(&root(), Some("tools/deploy.sh"), &filesystem(&[])).expect("a script");
        assert_eq!(resolved, PathBuf::from("/work/project/tools/deploy.sh"));
    }

    #[test]
    fn anything_that_is_not_a_project_relative_shell_script_is_refused_before_the_filesystem() {
        let never = |_: &Path| -> Option<PathBuf> { panic!("the filesystem must not be asked") };
        /* The NUL case ENDS IN `.sh` deliberately. The first version did not, so the extension
           check refused it first and removing the NUL check changed nothing — the control masking
           the thing under test, which `docs/evidence/blind-regressions-2026-09-06.md` has six of. */
        for asked in [None, Some(""), Some("/etc/rc.sh"), Some("tools/deploy"), Some("tools/dep\0loy.sh")] {
            let refused = script_path(&root(), asked, &never).expect_err("refused");
            assert_eq!(refused.status, 400, "{asked:?}");
            assert_eq!(refused.message, "Choose a project-relative .sh script.");
        }
    }

    /* The shape a textual check misses, and the reason the filesystem is asked: a link INSIDE the
       project pointing anywhere at all. */
    #[test]
    fn a_link_out_of_the_project_is_refused_however_it_is_spelled() {
        let escaping = filesystem(&[("/work/project/tools/away.sh", "/elsewhere/away.sh")]);
        let refused = script_path(&root(), Some("tools/away.sh"), &escaping).expect_err("refused");
        assert_eq!((refused.status, refused.message.as_str()), (403, "Script escapes the bound project."));

        /* And the textual walk-up, which the resolver collapses and this still refuses. */
        let up = script_path(&root(), Some("../outside/thing.sh"), &filesystem(&[])).expect_err("refused");
        assert_eq!(up.status, 403);

        /* A link that stays inside is fine: the rule is about where it lands, not that it is a link. */
        let inside = filesystem(&[("/work/project/tools/here.sh", "/work/project/scripts/here.sh")]);
        assert_eq!(
            script_path(&root(), Some("tools/here.sh"), &inside).expect("a script"),
            PathBuf::from("/work/project/scripts/here.sh")
        );
    }

    /* A prefix is not a parent: `/work/project-two` starts with `/work/project` as a string and is
       a different project. `starts_with` on a Path compares components, which is why this holds —
       and why it is asserted, because the string version is the easy mistake. */
    /* The check that guards against a resolver which does NOT canonicalise. `realpath` always
       collapses `..`, so against the real one this is dead — and a stand-in that also collapses it
       gave the rule no evidence at all, which is how it was found. `resolve` is injected, so a
       caller CAN hand in one that does not, and then this is the only thing between a `..` and the
       filesystem. */
    #[test]
    fn a_resolver_that_does_not_collapse_is_not_trusted_to_have_resolved() {
        let lazy = |path: &Path| Some(path.to_path_buf());
        let refused = script_path(&root(), Some("tools/../../outside/thing.sh"), &lazy).expect_err("refused");
        assert_eq!((refused.status, refused.message.as_str()), (403, "Script escapes the bound project."));
        /* And one with no walk-up still passes through the same lazy resolver. */
        assert!(script_path(&root(), Some("tools/deploy.sh"), &lazy).is_ok());
    }

    #[test]
    fn a_project_whose_name_extends_this_one_is_not_inside_it() {
        let sideways = filesystem(&[("/work/project/x.sh", "/work/project-two/x.sh")]);
        let refused = script_path(&root(), Some("x.sh"), &sideways).expect_err("refused");
        assert_eq!(refused.status, 403);
    }

    #[test]
    fn the_project_root_itself_is_not_a_script_in_it() {
        let itself = filesystem(&[("/work/project/x.sh", "/work/project")]);
        assert!(script_path(&root(), Some("x.sh"), &itself).is_err());
    }

    #[test]
    fn arguments_are_bounded_the_way_a_declared_actions_are() {
        assert_eq!(script_arguments(None), Ok(Vec::new()));
        assert_eq!(script_arguments(Some(&serde_json::Value::Null)), Ok(Vec::new()));
        assert_eq!(script_arguments(Some(&serde_json::json!(["--dry-run"]))), Ok(vec!["--dry-run".to_string()]));
        for bad in [
            serde_json::json!("--dry-run"),
            serde_json::json!([1]),
            serde_json::json!(["a\0b"]),
            serde_json::json!([ "x".repeat(4097) ]),
            serde_json::json!(vec!["-x"; 65]),
        ] {
            assert!(script_arguments(Some(&bad)).is_err(), "{bad} should be refused");
        }
        /* The edges that are allowed, so the bounds are bounds rather than a smaller box. */
        assert!(script_arguments(Some(&serde_json::json!([ "x".repeat(4096) ]))).is_ok());
        assert!(script_arguments(Some(&serde_json::json!(vec!["-x"; 64]))).is_ok());
    }
}
