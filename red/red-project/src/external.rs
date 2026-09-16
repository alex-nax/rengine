//! Installing rEngine's capabilities for a project that keeps none of them in its checkout
//! (F163, spec 146; spec 085).
//!
//! `orchestrator/external-project.mjs`. A project that cannot take a `.rengine/` directory — because
//! it is somebody else's repository, or because its owner does not want one — gets a **profile**
//! somewhere else instead: a declaration, a helper the declaration's commands run, and a launcher
//! script that opens the project bound to both. Nothing is written inside the project, ever.
//!
//! Three rules shape every path below, and each is about not damaging something:
//!
//! 1. **Nothing lands inside the project**, checked against the CANONICAL destination rather than
//!    the path as typed — a profile directory that is a symlink into the project would otherwise
//!    write there while looking like it did not. The canonical form is computed by walking up to a
//!    parent that exists, because the destination usually does not yet.
//! 2. **The declaration is checked before anything is written**, by the reader the product itself
//!    uses, so the installer refuses exactly what a workspace would refuse to open. A wrong
//!    declaration leaves the profile, the launcher and the project as it found them.
//! 3. **A file that differs is refused, not overwritten.** An owner edits their installed profile;
//!    rerunning the installer must not take that away. A file that is already byte-identical is
//!    not an error, so rerunning after a no-op change is allowed.
//!
//! The helper stays JavaScript and is meant to: it reads the project's `package.json`, lists its
//! scripts and runs them through its package manager. That is JavaScript about JavaScript, which is
//! the one kind this repository keeps.

use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

/// The helper copied into every profile, shipped with the binary so an install needs no checkout.
const COMMANDS: &str = include_str!("../../../orchestrator/templates/external/commands.mjs");

pub struct Install<'a> {
    pub project: &'a str,
    pub profile: &'a str,
    pub launcher: &'a str,
    pub state: &'a str,
    pub title: Option<&'a str>,
    pub minimal: bool,
    pub dry_run: bool,
    /// `red-project`, for checking the composed declaration — this binary, named by its caller so
    /// the check runs the reader the caller means rather than one this module goes looking for.
    pub reader: &'a Path,
    /// `red-launch`, written into the launcher script.
    pub launch: &'a Path,
    /// `node`, which the helper's declared commands run.
    pub node: &'a str,
    /// The PATH the launcher exports, so a shortcut on a desktop finds the tools it needs.
    pub path: &'a str,
}

/// `'…'`, with embedded quotes escaped the way a POSIX shell needs — the launcher is a script and
/// every path in it is data, including one with a space or an apostrophe in it.
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// Is `file` inside `root`? Compared on canonical paths by the caller; this is the containment rule
/// itself, and `root` counts as inside itself.
fn within(root: &Path, file: &Path) -> bool {
    file == root || file.starts_with(root)
}

/// The canonical form of a destination that may not exist yet: the nearest existing ancestor,
/// resolved, with the rest of the path put back. Resolving only what exists is the point — a
/// profile directory that is about to be created still has to be judged against where its PARENT
/// really is.
fn canonical_destination(filename: &Path) -> Result<PathBuf, String> {
    match std::fs::canonicalize(filename) {
        Ok(resolved) => Ok(resolved),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = filename.parent().ok_or_else(|| format!("{} has no parent.", filename.display()))?;
            let name = filename.file_name().ok_or_else(|| format!("{} names no file.", filename.display()))?;
            Ok(canonical_destination(parent)?.join(name))
        }
        Err(error) => Err(format!("{} cannot be resolved: {error}", filename.display())),
    }
}

/// The project's own id, from its directory name: lowercase, and anything else becomes a dash.
fn slug(name: &str) -> String {
    let mut out = String::new();
    for character in name.to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            out.push(character);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "external-project".to_string()
    } else {
        trimmed
    }
}

fn action(id: &str, title: &str, tools: &[&str], node: &str, helper: &Path) -> Value {
    json!({
        "id": id.replace(':', "-"),
        "title": title,
        "kind": "log",
        "command": [node, helper.to_string_lossy(), id],
        "requires": ["package.json"],
        "tools": tools,
    })
}

/// What was installed, or what would be.
pub struct Installed {
    pub project: PathBuf,
    pub declaration_file: PathBuf,
    pub launcher: PathBuf,
    pub state: PathBuf,
    pub files: Vec<PathBuf>,
    pub dry_run: bool,
}

impl Installed {
    pub fn as_json(&self) -> Value {
        json!({
            "project": self.project.to_string_lossy(),
            "declarationFile": self.declaration_file.to_string_lossy(),
            "launcher": self.launcher.to_string_lossy(),
            "state": self.state.to_string_lossy(),
            "files": self.files.iter().map(|file| file.to_string_lossy().into_owned()).collect::<Vec<_>>(),
            "dryRun": self.dry_run,
        })
    }
}

pub fn install(options: &Install) -> Result<Installed, String> {
    for (name, value) in
        [("project", options.project), ("profile", options.profile), ("launcher", options.launcher), ("state", options.state)]
    {
        if value.is_empty() || !Path::new(value).is_absolute() || Path::new(value).components().any(|part| part == Component::ParentDir) {
            return Err(format!("--{name} requires an absolute path."));
        }
    }
    let project = std::fs::canonicalize(options.project).map_err(|error| format!("{}: {error}", options.project))?;
    if !project.is_dir() {
        return Err("Project must be a directory.".to_string());
    }
    let profile = canonical_destination(Path::new(options.profile))?;
    let launcher = canonical_destination(Path::new(options.launcher))?;
    let state = canonical_destination(Path::new(options.state))?;
    for (name, destination) in [("profile", &profile), ("launcher", &launcher), ("state", &state)] {
        if within(&project, destination) {
            return Err(format!("--{name} must be outside the project."));
        }
    }
    let helper = profile.join("commands.mjs");
    let declaration_file = profile.join("project.json");
    if launcher == helper || launcher == declaration_file {
        return Err("Launcher must have its own path.".to_string());
    }

    let base = project.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    /* A title that was GIVEN is used as given, empty included: the declaration reader refuses an
       empty one by name, and this layer silently substituting the directory's name would hide a
       flag the person typed. Only an absent title falls back. */
    let title = options.title.map(str::to_string).unwrap_or_else(|| base.clone());
    let manifest_file = project.join("package.json");
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(&manifest_file).map_err(|error| format!("{}: {error}", manifest_file.display()))?,
    )
    .map_err(|error| format!("{} is not JSON: {error}", manifest_file.display()))?;

    let mut groups = vec![json!({ "id": "project", "title": "Project", "actions": [
        action("status", "Project status", &["git"], options.node, &helper),
        action("scripts", "Package scripts", &[], options.node, &helper),
    ] })];
    if !options.minimal {
        let declared = manifest.get("scripts").and_then(Value::as_object).cloned().unwrap_or_default();
        let controls: Vec<Value> = [
            ("dev", "Start development"),
            ("docs:dev", "Start documentation"),
            ("lint", "Lint"),
            ("typecheck", "Typecheck"),
            ("test", "Tests"),
            ("build", "Build"),
        ]
        .into_iter()
        .filter(|(id, _)| declared.contains_key(*id))
        .map(|(id, name)| action(id, name, &["pnpm"], options.node, &helper))
        .collect();
        if !controls.is_empty() {
            groups.push(json!({ "id": "development", "title": "Development and checks", "actions": controls }));
        }
    }
    let glyph: String = title.chars().take(2).collect();
    let declaration = json!({
        "contract": 5,
        "project": slug(&base),
        "title": title,
        "icon": { "glyph": glyph, "token": "info" },
        "formats": [{ "id": "json", "title": "JSON", "match": ["*.json"], "modes": ["text", "raw", "preview"], "default": "text",
            "preview": { "kind": "text", "command": [options.node, helper.to_string_lossy(), "json", "${file}"],
                         "timeoutMs": 10000, "maxBytes": 4194304 } }],
        "dashboard": { "title": title, "groups": groups },
    });
    check_declaration(options.reader, &project, &declaration)?;

    /* `${a[@]+"${a[@]}"}` rather than `"${a[@]}"`: `--agent` empties agent_flags, and an empty array
       under `set -u` is an UNBOUND VARIABLE in bash 3.2, which is /bin/bash on every macOS. The one
       documented way to open this launcher with an agent died in the shell before exec. */
    let script = format!(
        "#!/bin/bash\nset -euo pipefail\nexport PATH={}\nagent_flags=(--no-agent)\nfor argument in \"$@\"; do\n  \
case \"$argument\" in\n    --agent|--handoff) agent_flags=() ;;\n    \
--project|--declaration|--state) echo 'This launcher is bound to its installed project and state.' >&2; exit 2 ;;\n  \
esac\ndone\nexec {} --project {} --declaration {} --state {} ${{agent_flags[@]+\"${{agent_flags[@]}}\"}} \"$@\"\n",
        quote(options.path),
        quote(&options.launch.to_string_lossy()),
        quote(&project.to_string_lossy()),
        quote(&declaration_file.to_string_lossy()),
        quote(&state.to_string_lossy()),
    );
    let files: Vec<(PathBuf, String, u32)> = vec![
        (helper.clone(), COMMANDS.to_string(), 0o644),
        (declaration_file.clone(), format!("{}\n", serde_json::to_string_pretty(&declaration).map_err(|e| e.to_string())?), 0o644),
        (launcher.clone(), script, 0o755),
    ];
    for (filename, content, _) in &files {
        let resolved = canonical_destination(filename)?;
        if within(&project, &resolved) {
            return Err(format!("Install file must be outside the project: {}", filename.display()));
        }
        match std::fs::read_to_string(filename) {
            Ok(existing) if &existing != content => {
                return Err(format!("Refusing to overwrite differing file: {}", filename.display()))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("{}: {error}", filename.display())),
        }
    }
    if !options.dry_run {
        for (filename, content, mode) in &files {
            if let Some(parent) = filename.parent() {
                std::fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
            }
            write_new(filename, content, *mode)?;
        }
    }
    Ok(Installed {
        project,
        declaration_file,
        launcher,
        state,
        files: files.into_iter().map(|(filename, _, _)| filename).collect(),
        dry_run: options.dry_run,
    })
}

/// Written with `create_new`, so an existing file is never truncated by the attempt. One that is
/// already byte-identical is not an error — rerunning the installer on an unchanged profile is a
/// thing people do.
fn write_new(filename: &Path, content: &str, mode: u32) -> Result<(), String> {
    use std::io::Write;
    match std::fs::OpenOptions::new().write(true).create_new(true).open(filename) {
        Ok(mut file) => {
            file.write_all(content.as_bytes()).map_err(|error| format!("{}: {error}", filename.display()))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing = std::fs::read_to_string(filename).map_err(|error| format!("{}: {error}", filename.display()))?;
            if existing != content {
                return Err(format!("Refusing to overwrite differing file: {}", filename.display()));
            }
        }
        Err(error) => return Err(format!("{}: {error}", filename.display())),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(filename, std::fs::Permissions::from_mode(mode))
            .map_err(|error| format!("{}: {error}", filename.display()))?;
    }
    Ok(())
}

/// The composed declaration, judged by the reader the product itself uses — the contract, the
/// schema and each section's own rules — so the installer refuses exactly what a workspace would
/// refuse to open. The candidate goes to a throwaway directory of its own, because a wrong
/// declaration must leave the profile, the launcher and the project as it found them.
fn check_declaration(reader: &Path, project: &Path, declaration: &Value) -> Result<(), String> {
    let directory = std::env::temp_dir().join(format!("redit-declaration-{}", std::process::id()));
    std::fs::create_dir_all(&directory).map_err(|error| format!("{}: {error}", directory.display()))?;
    let candidate = directory.join("project.json");
    let outcome = (|| {
        std::fs::write(&candidate, format!("{}\n", serde_json::to_string_pretty(declaration).map_err(|e| e.to_string())?))
            .map_err(|error| format!("{}: {error}", candidate.display()))?;
        let done = std::process::Command::new(reader)
            .arg("declaration")
            .arg(project)
            .arg(&candidate)
            .output()
            .map_err(|error| format!("{} would not run: {error}", reader.display()))?;
        let answered: Value = serde_json::from_slice(&done.stdout)
            .map_err(|error| format!("the declaration reader answered something other than JSON: {error}"))?;
        match answered.get("error").and_then(Value::as_str) {
            /* The reader names the file it read; the person installing asked about a declaration
               this command composed, and that path is a temporary directory they never see. */
            Some(message) => {
                let prefix = format!("{}: ", candidate.display());
                Err(message.strip_prefix(&prefix).unwrap_or(message).to_string())
            }
            None => Ok(()),
        }
    })();
    let _ = std::fs::remove_dir_all(&directory);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    /* The containment rule is the one that protects somebody else's repository, and it is asked
       about CANONICAL paths — a profile that is a symlink into the project resolves to inside it. */
    #[test]
    fn a_destination_inside_the_project_is_inside_it_however_it_is_spelled() {
        let project = Path::new("/home/someone/project");
        assert!(within(project, Path::new("/home/someone/project")), "the root counts as inside itself");
        assert!(within(project, Path::new("/home/someone/project/profile")));
        assert!(!within(project, Path::new("/home/someone/profile")));
        /* A sibling whose name merely STARTS with the project's is not inside it. */
        assert!(!within(project, Path::new("/home/someone/project-profile")));
    }

    #[test]
    fn the_project_id_is_its_directory_name_and_never_empty() {
        assert_eq!(slug("Hirebase V2"), "hirebase-v2");
        assert_eq!(slug("my.project_name"), "my-project-name");
        assert_eq!(slug("---"), "external-project");
        assert_eq!(slug(""), "external-project");
    }

    /* Every path in the launcher is DATA, and a person's home directory may have an apostrophe in
       it. A naive `'{}'` would end the quoted string there and the rest would be shell. */
    #[test]
    fn a_path_with_a_quote_in_it_stays_one_word() {
        assert_eq!(quote("/home/o'brien/app"), "'/home/o'\\''brien/app'");
        assert_eq!(quote("/plain/path"), "'/plain/path'");
    }
}
