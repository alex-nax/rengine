//! red-link: the libp2p façade and relay of the Rust orchestrator (charter D57, spec 128).
//!
//!   red-link --version
//!   red-link relay  [--listen <multiaddr>]
//!   red-link attach --state <dir> --worker <url> --worker-token <token> --relay <multiaddr>
//!   red-link probe  --relay <multiaddr> --peer <peer-id> --get <section> [--root <id>]
//!
//! F140 gave it the contract; F180 (F141a) gives it the wire and the workspace behind it. The
//! façade reaches the workspace over the internal HTTP API the worker and the MCP connector
//! already use (decision 2) and serves clients **only** through a circuit relay (decision 4) —
//! see `net` for why that is the forced path rather than the preferred one.
//!
//! Everything the workspace is reached by is an **input**: the state directory whose `sidecar.json`
//! names the session host, and the worker's URL and token. Nothing here scans for a workspace,
//! because a façade that guesses can attach to the wrong one — the same rule the agent launcher
//! arrived at (F173).

use std::process::ExitCode;

use libp2p::{Multiaddr, PeerId};
use red_core::pb;
use red_link::host::{Endpoint, Workspace};
use red_link::net;

fn version_line() -> String {
    format!(
        "{} red-link {} (red-core contract {}, libp2p protocol {})",
        red_core::theme::PRODUCT_NAME,
        env!("CARGO_PKG_VERSION"),
        red_core::contract_version(),
        red_core::LIBP2P_PROTOCOL
    )
}

const USAGE: &str = "usage: red-link --version
       red-link relay [--listen <multiaddr>]
       red-link attach --state <dir> --worker <url> --worker-token <token> --relay <multiaddr>
       red-link probe --relay <multiaddr> --peer <peer-id> --get workspace|dashboard|tasks|token|agents [--root <id>]";

/// `--name value` pairs, refused by name rather than ignored: a flag nobody read is a launch that
/// silently did something else.
fn options(args: &[String]) -> Result<std::collections::HashMap<String, String>, String> {
    let mut map = std::collections::HashMap::new();
    let mut rest = args.iter();
    while let Some(flag) = rest.next() {
        let Some(name) = flag.strip_prefix("--") else {
            return Err(format!("red-link: {flag} is not an option"));
        };
        let Some(value) = rest.next() else {
            return Err(format!("red-link: --{name} needs a value"));
        };
        map.insert(name.to_string(), value.clone());
    }
    Ok(map)
}

fn want<'a>(options: &'a std::collections::HashMap<String, String>, name: &str) -> Result<&'a String, String> {
    options.get(name).ok_or_else(|| format!("red-link: --{name} is required"))
}

/// The session host, read from the descriptor it writes at startup — the same document
/// `discoverSidecar` reads, checked the same way.
fn session_host(state: &str) -> Result<Endpoint, String> {
    let path = std::path::Path::new(state).join("sidecar.json");
    let text = std::fs::read_to_string(&path).map_err(|error| format!("red-link: cannot read {}: {error}", path.display()))?;
    let document: serde_json::Value = serde_json::from_str(&text).map_err(|error| format!("red-link: {} is not JSON: {error}", path.display()))?;
    let url = document.get("url").and_then(serde_json::Value::as_str).unwrap_or_default();
    let token = document.get("token").and_then(serde_json::Value::as_str).unwrap_or_default();
    if !url.starts_with("http://127.0.0.1:") || token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("red-link: {} does not describe a loopback session host with a 64-hex token", path.display()));
    }
    Ok(Endpoint::new(url, token))
}

fn request_for(section: &str, root: Option<&String>) -> Result<pb::Request, String> {
    let root_id = || root.cloned().unwrap_or_default();
    let request = match section {
        "workspace" => pb::request::Request::Workspace(pb::WorkspaceRequest {}),
        "dashboard" => pb::request::Request::Dashboard(pb::DashboardRequest { root_id: root_id() }),
        "tasks" => pb::request::Request::Tasks(pb::TasksRequest { root_id: root_id() }),
        "token" => pb::request::Request::Token(pb::TokenRequest { root_id: root_id() }),
        "agents" => pb::request::Request::Agents(pb::AgentsRequest { root_id: root_id() }),
        other => return Err(format!("red-link: {other} is not a section of the v0.1 read surface")),
    };
    Ok(pb::Request { request: Some(request) })
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None | Some("--version") => {
            println!("{}", version_line());
            ExitCode::SUCCESS
        }
        Some("relay") => report(relay(&args[1..])),
        Some("attach") => report(attach(&args[1..])),
        Some("probe") => report(probe(&args[1..])),
        Some(other) => {
            eprintln!("red-link: unknown argument {other}\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn report(outcome: Result<(), String>) -> ExitCode {
    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(1)
        }
    }
}

fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("red-link: no async runtime: {error}"))
}

fn relay(args: &[String]) -> Result<(), String> {
    let options = options(args)?;
    let listen: Multiaddr = options
        .get("listen")
        .cloned()
        .unwrap_or_else(|| "/ip4/127.0.0.1/tcp/0".to_string())
        .parse()
        .map_err(|error| format!("red-link: --listen is not a multiaddr: {error}"))?;
    runtime()?.block_on(net::run_relay(listen))
}

fn attach(args: &[String]) -> Result<(), String> {
    let options = options(args)?;
    let workspace = Workspace {
        host: session_host(want(&options, "state")?)?,
        worker: Endpoint::new(want(&options, "worker")?, want(&options, "worker-token")?),
    };
    let relay_address: Multiaddr = want(&options, "relay")?
        .parse()
        .map_err(|error| format!("red-link: --relay is not a multiaddr: {error}"))?;
    runtime()?.block_on(net::run_facade(workspace, relay_address))
}

fn probe(args: &[String]) -> Result<(), String> {
    let options = options(args)?;
    let relay_address: Multiaddr = want(&options, "relay")?
        .parse()
        .map_err(|error| format!("red-link: --relay is not a multiaddr: {error}"))?;
    let facade: PeerId = want(&options, "peer")?
        .parse()
        .map_err(|error| format!("red-link: --peer is not a peer id: {error}"))?;
    let request = request_for(want(&options, "get")?, options.get("root"))?;
    let response = runtime()?.block_on(net::run_probe(relay_address, facade, request))?;
    /* The whole answer, as the contract carries it: a client that printed a summary would be a
       second description of the contract, and this repository has learned what those cost. */
    println!("{}", serde_json::to_string(&response).map_err(|error| format!("red-link: cannot render the answer: {error}"))?);
    match response.response {
        Some(pb::response::Response::Error(error)) => Err(format!("red-link: the façade refused: {}", error.message)),
        _ => Ok(()),
    }
}
