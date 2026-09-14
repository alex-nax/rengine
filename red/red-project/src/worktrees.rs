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

/// Where this project's worktrees are created, or the reason there is nowhere.
///
/// The directory is the declaration's and may leave the checkout (`../worktrees`), because a
/// worktree inside the main working tree is a mistake git warns about and a gitignored one inside
/// it is the invisibility this feature exists to end.
pub fn declared_directory(root_path: &str, declared: &Value) -> Result<String, Fail> {
    if declared.get("declared").and_then(Value::as_bool) != Some(true) {
        return Err(refuse("This project does not declare a worktree directory in .rengine/project.json.", 415));
    }
    if let Some(said) = declared.get("worktreesError").and_then(Value::as_str) {
        return Err(refuse(said, 415));
    }
    let named = declared
        .get("worktrees")
        .and_then(|block| block.get("directory"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| refuse("This project does not declare a worktree directory in .rengine/project.json.", 415))?;
    if named.starts_with('/') {
        return Err(refuse("A declared worktree directory must be relative to the project root.", 415));
    }
    Ok(red_store::store::js_resolve(root_path, named))
}

/// The edit charter D63 offers, as the text a person is shown before anything is written.
///
/// D63's bound is the whole decision: shown in full, written only on confirmation, and a
/// declaration that will not parse is reported rather than rewritten. This function does the
/// SHOWING — it returns what the file would become and never touches disk — so a caller cannot
/// write the block without having had the text to display.
pub fn declaration_offer(root_path: &str, directory: &str) -> Result<Value, Fail> {
    if directory.is_empty() || directory.starts_with('/') {
        return Err(refuse("A declared worktree directory must be relative to the project root.", 400));
    }
    let file = format!("{root_path}/.rengine/project.json");
    let (existing, contract) = match std::fs::read(&file) {
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let parsed: Value = serde_json::from_str(&text).map_err(|error| {
                /* Reported, never rewritten: a file this cannot read is a file whose shape it must
                   not guess at, and overwriting it would lose whatever the project meant by it. */
                refuse(format!(".rengine/project.json: invalid JSON ({error}); it was not changed."), 409)
            })?;
            if !parsed.is_object() {
                return Err(refuse(".rengine/project.json is not an object; it was not changed.", 409));
            }
            let contract = parsed.get("contract").and_then(Value::as_i64).unwrap_or(1);
            (parsed, contract)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (json!({ "project": "" }), 1),
        Err(error) => return Err(refuse(format!("{error}"), 500)),
    };
    let mut proposed = existing.as_object().cloned().unwrap_or_default();
    /* The block needs contract 11, and raising a contract is what makes an OLDER reader answer
       "unknown contract" rather than "unknown key" — so it is part of the edit and shown with it. */
    let raised = contract.max(11);
    proposed.insert("contract".into(), json!(raised));
    proposed.insert("worktrees".into(), json!({ "directory": directory }));
    let text = serde_json::to_string_pretty(&Value::Object(proposed)).map_err(|error| refuse(format!("{error}"), 500))?;
    Ok(object(vec![
        ("file", json!(file)),
        ("directory", json!(directory)),
        ("contract", json!(raised)),
        ("raisedFrom", json!(contract)),
        ("existed", json!(existing.get("project").is_some() || contract != 1)),
        ("text", json!(format!("{text}\n"))),
    ]))
}

/// Write the offer a person confirmed, and nothing else.
///
/// The text is the offer's own — a caller cannot compose one here — so what lands is what was
/// shown. The file is re-read first: an offer made against a declaration that has changed since is
/// refused rather than applied over the change.
pub fn accept_offer(root_path: &str, offer: &Value) -> Result<Value, Fail> {
    let file = offer.get("file").and_then(Value::as_str).unwrap_or_default().to_string();
    let text = offer.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
    if file.is_empty() || text.is_empty() {
        return Err(refuse("A worktree declaration is written only from an offer that was shown.", 400));
    }
    let fresh = declaration_offer(root_path, offer.get("directory").and_then(Value::as_str).unwrap_or_default())?;
    if fresh.get("text") != offer.get("text") {
        return Err(refuse(".rengine/project.json changed since this was offered; nothing was written.", 409));
    }
    if let Some(parent) = std::path::Path::new(&file).parent() {
        std::fs::create_dir_all(parent).map_err(|error| refuse(format!("{error}"), 500))?;
    }
    std::fs::write(&file, text.as_bytes()).map_err(|error| refuse(format!("{error}"), 500))?;
    Ok(object(vec![("file", json!(file)), ("written", json!(true))]))
}

/// Add a worktree for `branch` under the declared directory.
pub fn create(root_path: &str, declared: &Value, branch: &str, environment: &[(String, String)]) -> Result<Value, Fail> {
    if branch.is_empty() || branch.starts_with('-') || branch.contains(char::is_whitespace) || branch.contains('\0') {
        return Err(refuse("Choose a branch name.", 400));
    }
    let directory = declared_directory(root_path, declared)?;
    let listing = worktrees(root_path, environment)?;
    let repository = listing.get("repository").and_then(Value::as_str).unwrap_or_default().to_string();
    let taken = listing
        .get("worktrees")
        .and_then(Value::as_array)
        .is_some_and(|rows| rows.iter().any(|row| row.get("branch").and_then(Value::as_str) == Some(branch)));
    if taken {
        return Err(refuse(format!("{branch} is already checked out in a worktree of this repository."), 409));
    }
    std::fs::create_dir_all(&directory).map_err(|error| refuse(format!("{error}"), 500))?;
    let target = format!("{directory}/{}", branch.replace('/', "-"));
    if std::fs::metadata(&target).is_ok() {
        return Err(refuse(format!("{target} already exists; nothing was created."), 409));
    }
    /* `--` before the path, because a branch named like an option is still a branch and git must
       not read one as a flag. */
    git(&repository, &["worktree", "add", "--", &target, branch], environment)?;
    Ok(object(vec![("path", json!(target)), ("branch", json!(branch))]))
}

/// Remove a worktree, and only one the survey says may go.
///
/// The branch is never deleted: a worktree is a checkout, and removing the checkout of a branch
/// somebody may still want is not the same as removing their work.
pub fn remove(root_path: &str, path: &str, environment: &[(String, String)]) -> Result<Value, Fail> {
    let listing = worktrees(root_path, environment)?;
    let repository = listing.get("repository").and_then(Value::as_str).unwrap_or_default().to_string();
    let rows = listing.get("worktrees").and_then(Value::as_array).cloned().unwrap_or_default();
    /* Git reports a worktree by its REAL path, and on macOS a scratch directory reached through
       `/var` is `/private/var` once resolved — the symlink this repository has been caught by
       before. So both sides are canonicalised before they are compared, and a path that does not
       resolve (the worktree whose directory is gone) falls back to the lexical one. */
    let settle = |value: &str| {
        let absolute = red_store::store::js_resolve(root_path, value);
        if let Ok(real) = std::fs::canonicalize(&absolute) {
            return real.to_string_lossy().into_owned();
        }
        /* The leaf may be gone — that is one of the states this answers about — so the PARENT is
           resolved and the name put back, which still settles a symlinked ancestor. */
        let path = std::path::Path::new(&absolute);
        match (path.parent(), path.file_name()) {
            (Some(parent), Some(name)) => match std::fs::canonicalize(parent) {
                Ok(real) => real.join(name).to_string_lossy().into_owned(),
                Err(_) => absolute,
            },
            _ => absolute,
        }
    };
    let wanted = settle(path);
    let row = rows
        .iter()
        .find(|row| {
            let named = row.get("path").and_then(Value::as_str).unwrap_or_default();
            named == path || named == wanted || settle(named) == wanted
        })
        .ok_or_else(|| refuse(format!("{path} is not a worktree of this repository."), 404))?;
    if row.get("removable").and_then(Value::as_bool) != Some(true) {
        /* The reason, by name, because a grey refusal a person cannot act on is the thing the
           survey exists to avoid. The order is the order a person can fix them in. */
        let said = if row.get("main").and_then(Value::as_bool) == Some(true) {
            "That is the repository's own checkout, not a worktree of it.".to_string()
        } else if row.get("locked").and_then(Value::as_bool) == Some(true) {
            "That worktree is locked; unlock it first.".to_string()
        } else if row.get("present").and_then(Value::as_bool) != Some(true) {
            "That worktree's directory is gone; prune it with git rather than removing it here.".to_string()
        } else if row.get("dirty").and_then(Value::as_i64).unwrap_or(-1) != 0 {
            format!("That worktree holds {} uncommitted path(s).", row.get("dirty").and_then(Value::as_i64).unwrap_or(0))
        } else {
            format!(
                "{} is not merged into {}.",
                row.get("branch").and_then(Value::as_str).unwrap_or("That branch"),
                listing.get("base").and_then(Value::as_str).unwrap_or("its base")
            )
        };
        return Err(refuse(said, 409));
    }
    let target = row.get("path").and_then(Value::as_str).unwrap_or_default().to_string();
    git(&repository, &["worktree", "remove", "--", &target], environment)?;
    Ok(object(vec![("path", json!(target)), ("removed", json!(true)), ("branch", row.get("branch").cloned().unwrap_or(Value::Null))]))
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

    /// A declaration for a fixture, as `declaration::read` would answer it.
    fn declaring(directory: Option<&str>) -> Value {
        match directory {
            Some(d) => json!({ "declared": true, "contract": 11, "worktrees": { "directory": d } }),
            None => json!({ "declared": true, "contract": 1 }),
        }
    }

    #[test]
    fn a_worktree_is_created_under_the_declared_directory() {
        let root = fixture();
        let repo = root.join("repo");
        run(&repo, &["branch", "new-branch"]);
        let declared = declaring(Some("../made"));
        let made = create(repo.to_str().unwrap(), &declared, "new-branch", &environment()).expect("created");
        let at = made["path"].as_str().expect("a path");
        assert!(at.ends_with("/made/new-branch"), "under the declared sibling directory: {at}");
        assert!(std::path::Path::new(at).join("a.txt").exists(), "and it is a real checkout");

        /* The same branch twice is refused by name, not checked out twice. */
        let again = create(repo.to_str().unwrap(), &declared, "new-branch", &environment()).expect_err("refused");
        assert!(again.message.contains("already checked out"), "{}", again.message);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_project_that_declares_no_directory_is_refused_by_name() {
        let root = fixture();
        let repo = root.join("repo");
        let refused = create(repo.to_str().unwrap(), &declaring(None), "merged-branch", &environment()).expect_err("refused");
        assert_eq!(refused.message, "This project does not declare a worktree directory in .rengine/project.json.");
        assert_eq!(refused.status, Some(415));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_a_clean_merged_worktree_is_removed_and_the_branch_survives() {
        let root = fixture();
        let repo = root.join("repo");
        let path = |name: &str| root.join(name).to_str().unwrap().to_string();

        for (name, expect) in [
            ("ahead", "is not merged into main"),
            ("dirty", "uncommitted path"),
            ("gone", "directory is gone"),
            ("repo", "repository's own checkout"),
        ] {
            let refused = remove(repo.to_str().unwrap(), &path(name), &environment()).expect_err("refused");
            assert!(refused.message.contains(expect), "{name}: {}", refused.message);
            assert_eq!(refused.status, Some(409));
        }
        /* Nothing was touched by any of those refusals. */
        assert!(root.join("dirty").join("scratch.txt").exists(), "the dirty worktree is untouched");
        assert!(root.join("ahead").exists());

        let removed = remove(repo.to_str().unwrap(), &path("clean"), &environment()).expect("removed");
        assert_eq!(removed["removed"], json!(true));
        assert!(!root.join("clean").exists(), "the checkout is gone");
        let branches = git(repo.to_str().unwrap(), &["branch", "--list", "merged-branch"], &environment()).expect("branches");
        assert!(branches.contains("merged-branch"), "and the BRANCH survives: {branches:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_declaration_offer_is_shown_before_anything_is_written() {
        let root = fixture();
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join(".rengine")).expect("a directory");
        std::fs::write(repo.join(".rengine/project.json"), br#"{"contract": 2, "project": "fixture"}"#).expect("a declaration");

        let offer = declaration_offer(repo.to_str().unwrap(), "../worktrees").expect("an offer");
        assert_eq!(offer["contract"], json!(11), "the block needs 11, so the edit raises it");
        assert_eq!(offer["raisedFrom"], json!(2));
        let text = offer["text"].as_str().expect("the text");
        assert!(text.contains("\"worktrees\"") && text.contains("../worktrees"), "the offer shows the block: {text}");
        assert!(text.contains("\"project\": \"fixture\""), "and keeps what was there");
        /* SHOWING writes nothing. */
        let before = std::fs::read_to_string(repo.join(".rengine/project.json")).expect("still there");
        assert_eq!(before, r#"{"contract": 2, "project": "fixture"}"#, "the offer did not touch the file");

        accept_offer(repo.to_str().unwrap(), &offer).expect("written on confirmation");
        let after: Value = serde_json::from_str(&std::fs::read_to_string(repo.join(".rengine/project.json")).expect("read")).expect("json");
        assert_eq!(after["worktrees"]["directory"], json!("../worktrees"));
        assert_eq!(after["project"], json!("fixture"), "the project's own keys survive");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_declaration_that_will_not_parse_is_reported_and_not_rewritten() {
        let root = fixture();
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join(".rengine")).expect("a directory");
        let broken = br#"{ not json"#;
        std::fs::write(repo.join(".rengine/project.json"), broken).expect("a declaration");
        let refused = declaration_offer(repo.to_str().unwrap(), "../worktrees").expect_err("refused");
        assert!(refused.message.starts_with(".rengine/project.json: invalid JSON ("), "{}", refused.message);
        assert!(refused.message.ends_with("it was not changed."), "{}", refused.message);
        assert_eq!(std::fs::read(repo.join(".rengine/project.json")).expect("still there"), broken, "untouched");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_offer_made_against_a_declaration_that_has_since_changed_is_refused() {
        let root = fixture();
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join(".rengine")).expect("a directory");
        std::fs::write(repo.join(".rengine/project.json"), br#"{"contract": 2, "project": "fixture"}"#).expect("a declaration");
        let offer = declaration_offer(repo.to_str().unwrap(), "../worktrees").expect("an offer");
        std::fs::write(repo.join(".rengine/project.json"), br#"{"contract": 2, "project": "renamed"}"#).expect("changed underneath");
        let refused = accept_offer(repo.to_str().unwrap(), &offer).expect_err("refused");
        assert!(refused.message.contains("changed since this was offered"), "{}", refused.message);
        assert!(std::fs::read_to_string(repo.join(".rengine/project.json")).expect("read").contains("renamed"), "the change survives");
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
