//! What git already knows about a repository's worktrees (F190, spec 134 D1/D2).
//!
//! Thirty of these accumulated in this repository unseen, because a worktree is a directory git
//! knows about and nothing else does: they are gitignored, so no tree and no `git status` carries
//! them, and `git worktree list` from a shell was the only way to find out. This is that list, as a
//! record the workspace can draw.
//!
//! Discovery READS. It runs git's own plumbing and never writes, because the thing that makes a
//! worktree safe to remove — a clean tree and a branch already merged — is a fact about the
//! repository rather than a judgement this module is entitled to make. `remove` is F191's and it is
//! refused unless this module's survey says yes.
//!
//! Root IDs stay distinct from repository identity (charter D20, spec 002): this answers "which
//! worktrees does the repository behind THIS root have", and the caller decides which of them are
//! roots of its own.

use serde_json::{json, Value};

use crate::command;
use crate::recordings::Fail;
use crate::rules::object;

/// A worktree listing is a person opening a tab, not a hot path — but it runs several git commands
/// over a repository that may be large, so it is bounded like every other declared command.
const GIT_TIMEOUT_MS: u64 = 15_000;
const GIT_MAX_BYTES: usize = 8 * 1024 * 1024;

fn refuse(message: impl Into<String>, status: u16) -> Fail {
    Fail::with_status(message, status)
}

/// Run git in `directory`, or say why it could not.
fn git(directory: &str, args: &[&str], environment: &[(String, String)]) -> Result<String, Fail> {
    let argv: Vec<String> = std::iter::once("git".to_string()).chain(args.iter().map(|a| a.to_string())).collect();
    match command::run(std::path::Path::new(directory), &argv, environment, GIT_TIMEOUT_MS, GIT_MAX_BYTES) {
        Ok(run) => Ok(String::from_utf8_lossy(&run.stdout).into_owned()),
        Err(failed) => Err(refuse(failed.message, failed.status)),
    }
}

/// One entry of `git worktree list --porcelain`.
#[derive(Default, Debug)]
struct Entry {
    path: String,
    head: String,
    branch: Option<String>,
    detached: bool,
    locked: bool,
    prunable: bool,
}

/// `git worktree list --porcelain` is a blank-line-separated record set; a key with no value is a
/// flag. Parsed rather than scanned, because `locked` and `prunable` carry an optional reason and a
/// scan for the word would find it inside a path.
fn parse_listing(text: &str) -> Vec<Entry> {
    let mut entries = Vec::new();
    let mut current = Entry::default();
    let mut started = false;
    for line in text.lines() {
        if line.trim().is_empty() {
            if started {
                entries.push(std::mem::take(&mut current));
                started = false;
            }
            continue;
        }
        let (key, value) = match line.split_once(' ') {
            Some((key, value)) => (key, value),
            None => (line, ""),
        };
        match key {
            "worktree" => {
                current.path = value.to_string();
                started = true;
            }
            "HEAD" => current.head = value.to_string(),
            "branch" => current.branch = Some(value.trim_start_matches("refs/heads/").to_string()),
            "detached" => current.detached = true,
            "locked" => current.locked = true,
            "prunable" => current.prunable = true,
            _ => {}
        }
    }
    if started {
        entries.push(current);
    }
    entries
}

/// How many paths `git status --porcelain` names — the count a person is shown before a removal is
/// refused. A worktree whose directory is gone has no tree to read and answers `null`.
fn dirty_count(path: &str, present: bool, environment: &[(String, String)]) -> Option<usize> {
    if !present {
        return None;
    }
    git(path, &["status", "--porcelain"], environment).ok().map(|text| text.lines().filter(|line| !line.trim().is_empty()).count())
}

/// Whether `branch` is already contained in `base`.
///
/// "Its base" is the branch the MAIN worktree has checked out — the one a person means by "merged"
/// in a repository they are working in. A detached main worktree has no such branch, and then this
/// answers `null` rather than guessing: spec 002's rule for a root whose checkout it cannot
/// identify is to report the state, never to invent one.
fn merged_into(repository: &str, branch: &str, base: Option<&str>, environment: &[(String, String)]) -> Option<bool> {
    let base = base?;
    if branch == base {
        return Some(true);
    }
    let merged = command::run(
        std::path::Path::new(repository),
        &["git".into(), "merge-base".into(), "--is-ancestor".into(), branch.into(), base.into()],
        environment,
        GIT_TIMEOUT_MS,
        GIT_MAX_BYTES,
    );
    match merged {
        Ok(_) => Some(true),
        /* `--is-ancestor` answers by exit code: 1 is "no", and anything else is a question that
           could not be asked — an unknown ref, a corrupt object — which is not the same as "no". */
        Err(failed) if failed.message.contains("exit 1") => Some(false),
        Err(_) => None,
    }
}

/// Every worktree of the repository behind `root_path`, with what a removal would need to know.
pub fn worktrees(root_path: &str, environment: &[(String, String)]) -> Result<Value, Fail> {
    let listing = git(root_path, &["worktree", "list", "--porcelain"], environment).map_err(|fail| {
        /* A directory that is not in a repository is the ordinary case for a project root, not a
           fault: it is reported as such and the caller draws no worktree group for it. */
        if fail.message.contains("not a git repository") {
            refuse("This project is not in a git repository.", 415)
        } else {
            fail
        }
    })?;
    let entries = parse_listing(&listing);
    let Some(main) = entries.first() else {
        return Err(refuse("This repository reports no worktrees.", 415));
    };
    let repository = main.path.clone();
    let base = main.branch.clone();

    let mut rows = Vec::new();
    for entry in &entries {
        let present = std::fs::metadata(&entry.path).map(|meta| meta.is_dir()).unwrap_or(false);
        let dirty = dirty_count(&entry.path, present, environment);
        let merged = match (&entry.branch, present) {
            (Some(branch), true) => merged_into(&repository, branch, base.as_deref(), environment),
            _ => None,
        };
        /* The survey, in one field, because every caller asks the same question of it: a worktree
           is removable when it is present, is not the main one, holds nothing uncommitted and is
           already contained in its base. A `null` in either fact is not a yes. */
        let removable = present && entry.path != repository && dirty == Some(0) && merged == Some(true) && !entry.locked;
        rows.push(object(vec![
            ("path", json!(entry.path)),
            ("branch", entry.branch.clone().map(Value::String).unwrap_or(Value::Null)),
            ("head", json!(entry.head)),
            ("main", json!(entry.path == repository)),
            ("present", json!(present)),
            ("detached", json!(entry.detached)),
            ("locked", json!(entry.locked)),
            ("prunable", json!(entry.prunable)),
            ("dirty", dirty.map(|n| json!(n)).unwrap_or(Value::Null)),
            ("merged", merged.map(|m| json!(m)).unwrap_or(Value::Null)),
            ("removable", json!(removable)),
        ]));
    }
    Ok(object(vec![
        ("repository", json!(repository)),
        ("base", base.map(Value::String).unwrap_or(Value::Null)),
        ("worktrees", json!(rows)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment() -> Vec<(String, String)> {
        std::env::vars().collect()
    }

    fn run(directory: &std::path::Path, args: &[&str]) {
        let argv: Vec<String> = std::iter::once("git".to_string()).chain(args.iter().map(|a| a.to_string())).collect();
        command::run(directory, &argv, &environment(), 20_000, 8 * 1024 * 1024)
            .unwrap_or_else(|failed| panic!("git {args:?} in {}: {}", directory.display(), failed.message));
    }

    /// A repository with four worktrees, one of each shape the criteria name.
    fn fixture() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("red-project-worktrees-{}", crate::uuid_like()));
        let main = root.join("repo");
        std::fs::create_dir_all(&main).expect("a directory");
        run(&main, &["init", "-q", "-b", "main"]);
        run(&main, &["config", "user.email", "fixture@example.invalid"]);
        run(&main, &["config", "user.name", "Fixture"]);
        std::fs::write(main.join("a.txt"), b"one\n").expect("a file");
        run(&main, &["add", "a.txt"]);
        run(&main, &["commit", "-qm", "first"]);

        /* merged: a branch whose commit is already in main. */
        run(&main, &["branch", "merged-branch"]);
        run(&main, &["worktree", "add", "-q", root.join("clean").to_str().unwrap(), "merged-branch"]);

        /* unmerged: a branch with a commit main does not have. */
        run(&main, &["worktree", "add", "-q", "-b", "ahead-branch", root.join("ahead").to_str().unwrap()]);
        let ahead = root.join("ahead");
        std::fs::write(ahead.join("b.txt"), b"two\n").expect("a file");
        run(&ahead, &["add", "b.txt"]);
        run(&ahead, &["commit", "-qm", "second"]);

        /* dirty: merged, but holding an uncommitted file. */
        run(&main, &["branch", "dirty-branch"]);
        run(&main, &["worktree", "add", "-q", root.join("dirty").to_str().unwrap(), "dirty-branch"]);
        std::fs::write(root.join("dirty").join("scratch.txt"), b"unsaved\n").expect("a file");

        /* gone: listed by git, but its directory has been deleted underneath. */
        run(&main, &["branch", "gone-branch"]);
        run(&main, &["worktree", "add", "-q", root.join("gone").to_str().unwrap(), "gone-branch"]);
        std::fs::remove_dir_all(root.join("gone")).expect("removed underneath");
        root
    }

    fn row<'a>(answer: &'a Value, name: &str) -> &'a Value {
        answer["worktrees"]
            .as_array()
            .expect("a list")
            .iter()
            .find(|w| w["path"].as_str().is_some_and(|p| p.ends_with(name)))
            .unwrap_or_else(|| panic!("no worktree ending {name} in {answer}"))
    }

    #[test]
    fn every_worktree_is_listed_with_what_a_removal_would_need_to_know() {
        let root = fixture();
        let answer = worktrees(root.join("repo").to_str().unwrap(), &environment()).expect("a listing");
        assert_eq!(answer["base"], json!("main"), "the base is the main worktree's branch");
        assert_eq!(answer["worktrees"].as_array().map(Vec::len), Some(5), "the main checkout and its four worktrees");

        let main = row(&answer, "/repo");
        assert_eq!(main["main"], json!(true));
        assert_eq!(main["removable"], json!(false), "the main checkout is never removable");

        let clean = row(&answer, "/clean");
        assert_eq!((&clean["dirty"], &clean["merged"]), (&json!(0), &json!(true)));
        assert_eq!(clean["removable"], json!(true), "clean and merged is the one removable shape");

        let ahead = row(&answer, "/ahead");
        assert_eq!(ahead["merged"], json!(false), "a branch main does not contain is not merged");
        assert_eq!(ahead["removable"], json!(false));

        let dirty = row(&answer, "/dirty");
        assert_eq!(dirty["dirty"], json!(1), "the count is what `status --porcelain` names");
        assert_eq!(dirty["merged"], json!(true));
        assert_eq!(dirty["removable"], json!(false), "merged is not enough while the tree holds something");

        /* A worktree whose directory is gone is REPORTED, not dropped and not guessed at: spec
           002's rule for a checkout that is not there. */
        let gone = row(&answer, "/gone");
        assert_eq!(gone["present"], json!(false));
        assert_eq!((&gone["dirty"], &gone["merged"]), (&Value::Null, &Value::Null), "neither fact can be read");
        assert_eq!(gone["removable"], json!(false));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_directory_outside_a_repository_is_reported_by_name() {
        let outside = std::env::temp_dir().join(format!("red-project-norepo-{}", crate::uuid_like()));
        std::fs::create_dir_all(&outside).expect("a directory");
        let refused = worktrees(outside.to_str().unwrap(), &environment()).expect_err("a refusal");
        assert_eq!(refused.message, "This project is not in a git repository.");
        assert_eq!(refused.status, Some(415));
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn a_repository_with_no_worktrees_still_lists_its_own_checkout() {
        let root = std::env::temp_dir().join(format!("red-project-bare-{}", crate::uuid_like()));
        std::fs::create_dir_all(&root).expect("a directory");
        run(&root, &["init", "-q", "-b", "main"]);
        run(&root, &["config", "user.email", "fixture@example.invalid"]);
        run(&root, &["config", "user.name", "Fixture"]);
        std::fs::write(root.join("a.txt"), b"one\n").expect("a file");
        run(&root, &["add", "a.txt"]);
        run(&root, &["commit", "-qm", "first"]);
        let answer = worktrees(root.to_str().unwrap(), &environment()).expect("a listing");
        assert_eq!(answer["worktrees"].as_array().map(Vec::len), Some(1), "a checkout is a worktree of itself");
        assert_eq!(answer["worktrees"][0]["removable"], json!(false));
        let _ = std::fs::remove_dir_all(&root);
    }
}
