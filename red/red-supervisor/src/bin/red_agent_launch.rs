//! red-agent-launch: the launcher a person's CLI actually runs inside (F163, spec 146, charter D57).
//!
//! `orchestrator/agents/launch.mjs`, which `scripts/agent.sh` execs at the end of a pane launch.
//! It is the last live JavaScript entry point in a pane, and deleting it takes nine modules with
//! it — everything it imported existed only to serve this one file.
//!
//! **This is the acting half and nothing more.** The plan is already Rust's and already proved:
//! `red_agents::launch::launch_plan` composes it, and `red-agents-launch.test.mjs` judges that
//! against what `config.mjs` composed for every declared CLI, out of a record frozen while the
//! JavaScript still existed (F173). Nothing here re-decides any of it. What had no Rust is the
//! half that DOES things: the handoff gate, the sentences printed into the pane, the report back to
//! the workspace, and the child process with its signals and its exit code.
//!
//! It lives in `red-supervisor` beside `red-launch` because the two are siblings — the workspace's
//! launcher and the pane's — and because this is the crate that can reach both `red-agents` and
//! `red-ide` without a cycle (`red-ide` depends on `red-agents`, so `red-agents` cannot host it).
//!
//! **Optional things that do not answer do not fail a launch.** The ancestor chain, the session
//! list and the conversation report are each best-effort, each for its own reason, and each says so
//! and continues. A person whose editor probe timed out still gets their CLI.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use red_core::descriptor;
use serde_json::{json, Map, Value};

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code as u8),
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(1)
        }
    }
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn run() -> Result<i32, String> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let (agent, executable, context_file) = match (argv.first(), argv.get(1), argv.get(2)) {
        (Some(agent), Some(executable), Some(file)) if !agent.is_empty() && !executable.is_empty() && !file.is_empty() => {
            (agent.clone(), executable.clone(), file.clone())
        }
        _ => return Err("Expected agent identity, executable and workspace context.".to_string()),
    };
    let mut args: Vec<String> = argv.iter().skip(3).cloned().collect();
    let recipes = red_agents::recipes()?;

    /* ---- the handoff, when this pane is one ------------------------------------------------- */
    let mut handoff = Value::Null;
    if let Some(gate) = env("RENGINE_HANDOFF_GATE") {
        wait_for_presentation(Path::new(&gate));
        let manifest = env("RENGINE_HANDOFF_FILE").ok_or("A handoff gate needs RENGINE_HANDOFF_FILE.")?;
        let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
        let declared = red_agents::launch::conversation_handoff(&recipes, &agent).unwrap_or(Value::Null);
        let ids = red_agents::launch::conversation_ids(&recipes, &agent);
        let environment = environment_json();
        let read = red_agents::handoff::read_handoff(&manifest, Some(&cwd), &environment, &declared, ids.as_deref()).map_err(plain)?;
        let bash = env("RENGINE_BASH").unwrap_or_else(|| "/bin/bash".to_string());
        let project = text(&read, "project").unwrap_or_default().to_string();
        red_agents::handoff::check_resume(&bash, &agent, Path::new(&project), &environment).map_err(plain)?;
        args.extend(resume_args(&read));
        handoff = read;
    }

    /* ---- the inputs the plan is a function of ------------------------------------------------ */
    let context = read_context(&context_file)?;
    let connection = descriptor::check_connection(&context).ok();
    let sessions = listed_sessions(connection.as_ref());
    let our_pids = ancestors();
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?.to_string_lossy().into_owned();
    let ide = probe_editor(&recipes, &agent, &cwd, &our_pids);

    let mut inputs = Map::new();
    inputs.insert("agent".into(), json!(agent));
    inputs.insert("executable".into(), json!(executable));
    inputs.insert("args".into(), json!(args));
    inputs.insert("contextFile".into(), json!(context_file));
    inputs.insert("context".into(), context.clone());
    inputs.insert("directory".into(), Value::Null);
    inputs.insert("identity".into(), Value::Null);
    inputs.insert("handoff".into(), handoff);
    inputs.insert("conversation".into(), env("RENGINE_AGENT_CONVERSATION").map(Value::String).unwrap_or(Value::Null));
    inputs.insert("resume".into(), json!(env("RENGINE_AGENT_RESUME").as_deref() == Some("1")));
    inputs.insert("env".into(), environment_json());
    inputs.insert("cwd".into(), json!(cwd));
    inputs.insert("sessions".into(), json!(sessions));
    inputs.insert("ide".into(), ide);
    inputs.insert("ptySessionId".into(), pty_session_id(&sessions));
    inputs.insert("platform".into(), json!(platform()));
    inputs.insert("pid".into(), json!(std::process::id()));
    inputs.insert("nodeExecutable".into(), json!(red_core::env::node_path()));
    /* The pane's MCP server, as the whole command rather than a script for an interpreter: the
       facade mode of `red-mcp`, which holds this CLI's stdio connection while the worker behind it
       is replaced by an update (spec 146). `mcpMain` — the older shape — is what the frozen record
       is taken through and is left for it. */
    let facade = red_core::service::serve_binary("RENGINE_RED_MCP", "red-mcp")?;
    inputs.insert("mcpCommand".into(), json!([facade.to_string_lossy(), "--facade"]));
    inputs.insert("redAgents".into(), json!(red_core::service::serve_binary("RENGINE_RED_AGENTS", "red-agents")?.to_string_lossy()));

    let mut mint = || uuid();
    let mut now = || red_core::time::iso(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|since| since.as_millis() as i64).unwrap_or(0));
    let plan = red_agents::launch::launch_plan(&recipes, &Value::Object(inputs), &mut mint, &mut now)?;

    /* ---- what the person reads, in the order they read it ------------------------------------ */
    if let Some(reason) = plan.get("ide").and_then(|ide| ide.get("reason")).and_then(Value::as_str) {
        println!("Editor: {reason}");
    }
    report_conversation(&plan, connection.as_ref(), &agent);
    if plan.get("custom").and_then(Value::as_bool) == Some(true) {
        println!(
            "Custom agent MCP configuration: {} (also RENGINE_MCP_CONFIG). Configure this CLI to consume it.",
            text(&plan, "generic").unwrap_or_default()
        );
    } else {
        println!("Workspace MCP: {}", text(&plan, "name").unwrap_or_default());
    }
    let identity = plan.get("identity").cloned().unwrap_or(Value::Null);
    let described = red_agents::launch::describe_session(&identity);
    let said = described.as_str().unwrap_or_default();
    println!(
        "Workspace identity: {}{}",
        identity.get("label").and_then(Value::as_str).unwrap_or_default(),
        if said.is_empty() { String::new() } else { format!(" — {said}") }
    );

    spawn_cli(&plan)
}

/* ---- the handoff gate ------------------------------------------------------------------------ */

/// The pane has to be PRESENTED before the CLI is started, or a person is handed a conversation in
/// a tab they cannot see. The desktop makes the gate file; this waits for it.
fn wait_for_presentation(gate: &Path) {
    println!("Handoff paused: waiting for the agent pane to be presented in rEngine.");
    while !gate.exists() {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// The arguments that put a CLI back into a paused conversation. They live HERE rather than in
/// `red_agents::handoff` for the reason that module gives: they run inside the pane, in its own
/// launcher, and belong to whatever starts that.
fn resume_args(handoff: &Value) -> Vec<String> {
    let session = text(handoff, "sessionId").unwrap_or_default();
    let project = text(handoff, "project").unwrap_or_default();
    let checkpoint = text(handoff, "checkpoint").unwrap_or_default();
    vec![
        "resume".to_string(),
        session.to_string(),
        "--cd".to_string(),
        project.to_string(),
        format!(
            "The user authorized resuming development in this rEngine orchestrator pane. Read AGENTS.md and {} before acting. \
Verify the root-bound rEngine MCP connection and RENGINE_ORCHESTRATOR_SESSION environment, then continue the paused goal from that checkpoint. \
Preserve all remaining constraints and outstanding approval boundaries. Do not start a duplicate goal or another copy of this conversation. \
This continuation was delivered once after native presentation; desktop reloads retain this CLI.",
            serde_json::to_string(checkpoint).unwrap_or_default()
        ),
    ]
}

/// The refusals the host encodes as `status|message`; a pane has no status to carry.
fn plain(message: String) -> String {
    message.split_once('|').map(|(_, said)| said.to_string()).unwrap_or(message)
}

/* ---- the best-effort inputs ------------------------------------------------------------------ */

fn read_context(file: &str) -> Result<Value, String> {
    let source = std::fs::read_to_string(file).map_err(|error| format!("{file} cannot be read: {error}"))?;
    serde_json::from_str(&source).map_err(|error| format!("{file} is not a workspace context: {error}"))
}

/// The workspace's session list, so the identity can say which retained PTY this launch runs in.
/// Best-effort exactly as it was: a launch is not refused because the host did not answer in time.
fn listed_sessions(connection: Option<&descriptor::Connection>) -> Vec<Value> {
    let Some(connection) = connection else { return Vec::new() };
    match descriptor::request(connection, "state", None, &[]) {
        Ok(state) => state.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Which retained PTY this launch is running inside. A fact about this process tree rather than a
/// decision, which is why it is an input. Windows never looked, and still does not.
fn pty_session_id(sessions: &[Value]) -> Value {
    if platform() == "win32" {
        return Value::Null;
    }
    let ours = [std::process::id() as i64, std::os::unix::process::parent_id() as i64];
    sessions
        .iter()
        .find(|session| {
            text(session, "type") == Some("agent")
                && session.get("pid").and_then(Value::as_i64).is_some_and(|pid| pid > 1 && ours.contains(&pid))
        })
        .and_then(|session| session.get("id").cloned())
        .unwrap_or(Value::Null)
}

/// Every pid between this process and the top of the tree, which tells this workspace's own editor
/// from a machine-mate's. One `ps` parser for the whole workspace, and it is this crate's.
fn ancestors() -> Vec<Value> {
    match red_supervisor::stop::list_processes() {
        Ok(table) => red_supervisor::replace::ancestors_of(std::process::id() as i64, &table).into_iter().map(|pid| json!(pid)).collect(),
        /* The editor decision is not worth failing a pane launch over. */
        Err(_) => Vec::new(),
    }
}

/// The editor probe. A recipe that declares an auto-connect option always gets an ANSWER, including
/// when the answer is no — a pane that silently does not connect is a support question.
fn probe_editor(recipes: &[(String, red_agents::Value)], agent: &str, cwd: &str, our_pids: &[Value]) -> Value {
    let declared = recipes
        .iter()
        .find(|(name, _)| name == agent)
        .map(|(_, raw)| red_agents::project(raw))
        .and_then(|view| view.get("ide").cloned())
        .filter(|value| !value.is_null());
    let Some(declared) = declared else { return Value::Null };
    let option = red_ide::discovery::IdeOption {
        flags: declared
            .get("flags")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default(),
        env_var: text(&declared, "envVar").unwrap_or_default().to_string(),
    };
    /* An explicit directory wins; otherwise the declaring recipe says where the locks live. No
       recipe declaring an editor protocol means there is none to speak, and the probe is skipped
       rather than guessed at. */
    let locks = match env("RENGINE_IDE_DIRECTORY") {
        Some(named) => named,
        None => match protocol_of(recipes) {
            Some(protocol) => red_ide::lock::directory(&|name| env(name), &protocol),
            None => return Value::Null,
        },
    };
    red_ide::discovery::auto_connect(Some(&option), agent, cwd, &PathBuf::from(locks), cwd, our_pids, &red_ide::discovery::living)
}

/// The editor protocol this run speaks, from the recipe that declares one — the same composition
/// root `red-ide`'s own binary uses. The library names no CLI; the recipe does (F220, spec 141).
fn protocol_of(recipes: &[(String, red_agents::Value)]) -> Option<red_ide::lock::Protocol> {
    recipes
        .iter()
        .find_map(|(_, raw)| red_agents::view(raw).get("ide").and_then(red_ide::lock::Protocol::declared))
}

fn environment_json() -> Value {
    Value::Object(std::env::vars().map(|(name, value)| (name, Value::String(value))).collect())
}

fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn uuid() -> String {
    red_core::service::uuid_v4()
}

/* ---- telling the workspace which conversation this pane holds -------------------------------- */

/// The identity decided by the plan is the single source: the workspace may have minted a
/// conversation, the person at the pane may have chosen another from the offered list, and their
/// own `--resume` beats both. A launch that continues or forks reports `null`, so no record claims
/// an id rEngine cannot resume.
fn report_conversation(plan: &Value, connection: Option<&descriptor::Connection>, agent: &str) {
    let Some(conversation) = plan.get("conversation") else { return };
    let Some(session) = env("RENGINE_ORCHESTRATOR_SESSION") else { return };
    let Some(connection) = connection else { return };
    let ask = json!({ "id": session, "conversation": conversation, "agent": agent });
    if let Err(why) = descriptor::request(connection, "agent-conversation", Some(&ask), &[]) {
        /* A workspace that was not told is a lost RECORD, not a lost session. */
        eprintln!("The workspace was not told which conversation this pane holds: {why}");
    }
}

/* ---- the child ------------------------------------------------------------------------------- */

/// Start the CLI and become a shell around it: SIGINT belongs to the CLI, SIGTERM is forwarded, and
/// the code that comes back out is the CLI's own.
fn spawn_cli(plan: &Value) -> Result<i32, String> {
    let executable = text(plan, "executable").unwrap_or_default().to_string();
    let args: Vec<String> = plan
        .get("args")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let windows = platform() == "win32";
    let (command, argv) = if windows {
        let bash = env("RENGINE_BASH").ok_or("Windows workspace bootstrap requires RENGINE_BASH.")?;
        let mut wrapped = vec!["--noprofile".to_string(), "--norc".to_string(), "-c".to_string(), "exec \"$@\"".to_string(), "rengine-agent".to_string(), executable.clone()];
        wrapped.extend(args);
        (bash, wrapped)
    } else {
        (executable.clone(), args)
    };

    let mut child = std::process::Command::new(&command);
    child.args(&argv).env_clear();
    if let Some(values) = plan.get("env").and_then(Value::as_object) {
        for (name, value) in values {
            if let Some(said) = value.as_str() {
                child.env(name, said);
            }
        }
    }
    /* Ctrl-C belongs to the CLI: the launcher ignoring SIGINT is what lets a CLI handle its own
       interrupt rather than dying beside its parent. */
    #[cfg(unix)]
    unsafe {
        libc_ignore_sigint();
    }
    let mut running = child.spawn().map_err(|error| format!("{command}: {error}"))?;
    let pid = running.id() as i64;
    #[cfg(unix)]
    forward_sigterm(pid);
    let status = running.wait().map_err(|error| format!("{command}: {error}"))?;
    Ok(match status.code() {
        Some(code) => code,
        None => {
            /* A signal, mapped as the JavaScript mapped it. */
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                if status.signal() == Some(2) {
                    return Ok(130);
                }
            }
            1
        }
    })
}

#[cfg(unix)]
extern "C" {
    fn signal(number: i32, handler: usize) -> usize;
}

#[cfg(unix)]
unsafe fn libc_ignore_sigint() {
    const SIGINT: i32 = 2;
    const SIG_IGN: usize = 1;
    signal(SIGINT, SIG_IGN);
}

/// SIGTERM reaches the CLI rather than only the launcher, so a workspace stopping a pane stops what
/// the person is actually talking to.
#[cfg(unix)]
fn forward_sigterm(pid: i64) {
    use std::sync::atomic::{AtomicI64, Ordering};
    static CHILD: AtomicI64 = AtomicI64::new(0);
    CHILD.store(pid, Ordering::SeqCst);
    extern "C" fn handler(_: i32) {
        let pid = CHILD.load(Ordering::SeqCst);
        if pid > 1 {
            red_core::descriptor::signal(pid, 15);
        }
    }
    const SIGTERM: i32 = 15;
    unsafe {
        signal(SIGTERM, handler as usize);
    }
}
