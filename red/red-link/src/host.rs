//! The half of the façade that faces the workspace (spec 128 decision 2; F180/F141a).
//!
//! red-link speaks the existing internal HTTP API to the host — the same surface the worker and
//! the MCP connector already use — so a running workspace does not change at all to gain a remote
//! client. Two endpoints, because the read surface genuinely spans two processes and F140's own
//! contract bundle already records that: `/api/state` and `/api/dashboard` come from the **session
//! host**, and `tracker`, `token` and `agents-menu` from the root-bound **worker**.
//!
//! The HTTP is hand-rolled for the same reason `red-agents`'s bind does it: one authenticated GET
//! against a loopback port does not justify a TLS stack and an async HTTP client in the dependency
//! tree. It asks in **HTTP/1.0**, which is what makes the answer a whole body and not a chunked
//! stream this code would have to reassemble.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use red_core::pb;
use red_core::translate::{self, Drift};

/// One authenticated workspace surface: where it listens and the bearer token it expects.
#[derive(Clone, Debug)]
pub struct Endpoint {
    pub url: String,
    pub token: String,
}

impl Endpoint {
    pub fn new(url: impl Into<String>, token: impl Into<String>) -> Self {
        Endpoint { url: url.into(), token: token.into() }
    }

    /// `http://127.0.0.1:PORT` split into the address a socket wants and the host header it needs.
    fn address(&self) -> Result<(String, String), String> {
        let rest = self
            .url
            .strip_prefix("http://")
            .ok_or_else(|| format!("{} is not an http:// workspace URL", self.url))?;
        let authority = rest.split('/').next().unwrap_or_default().to_string();
        if authority.is_empty() {
            return Err(format!("{} names no host", self.url));
        }
        let socket = if authority.contains(':') { authority.clone() } else { format!("{authority}:80") };
        Ok((socket, authority))
    }

    /// One GET, one JSON body. `path` is workspace-relative and already query-encoded.
    pub fn get(&self, path: &str) -> Result<serde_json::Value, String> {
        let (socket, authority) = self.address()?;
        let mut stream = TcpStream::connect(&socket).map_err(|error| format!("cannot reach {socket}: {error}"))?;
        stream.set_read_timeout(Some(Duration::from_secs(15))).ok();
        stream.set_write_timeout(Some(Duration::from_secs(15))).ok();
        let request = format!(
            "GET {path} HTTP/1.0\r\nHost: {authority}\r\nAuthorization: Bearer {}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
            self.token
        );
        stream.write_all(request.as_bytes()).map_err(|error| format!("cannot ask {socket} for {path}: {error}"))?;
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).map_err(|error| format!("no answer from {socket} for {path}: {error}"))?;
        let text = String::from_utf8_lossy(&raw);
        let (head, body) = text
            .split_once("\r\n\r\n")
            .ok_or_else(|| format!("{socket} answered {path} with no headers"))?;
        let status = head
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("000");
        if status != "200" {
            /* The host's own words, not a generic failure: a phone shows this to a person. */
            let said = body.trim();
            return Err(format!("the workspace answered {status} for {path}{}", if said.is_empty() { String::new() } else { format!(": {said}") }));
        }
        serde_json::from_str(body).map_err(|error| format!("{path} did not answer JSON: {error}"))
    }
}

/// The workspace as the façade reaches it. Both endpoints are inputs — nothing here goes looking
/// for a port, because a façade that guesses at a workspace is a façade that can attach to the
/// wrong one.
#[derive(Clone, Debug)]
pub struct Workspace {
    pub host: Endpoint,
    pub worker: Endpoint,
}

/// Drift is reported, never hidden: a shape the contract could not carry whole is the thing F140's
/// harness exists to make loud, and answering the client with a half-translated message while
/// saying nothing would undo that.
fn carried<T>(what: &str, value: (T, Vec<Drift>)) -> Result<T, String> {
    let (message, drift) = value;
    if drift.is_empty() {
        return Ok(message);
    }
    Err(format!(
        "the workspace and the red.v1 contract disagree about {what} in {} place(s): {}",
        drift.len(),
        drift.iter().map(|item| item.to_string()).collect::<Vec<_>>().join("; ")
    ))
}

fn root_of(root_id: &str, what: &str) -> Result<(), String> {
    if root_id.is_empty() {
        return Err(format!("{what} is asked per project root, and this request named none"));
    }
    Ok(())
}

impl Workspace {
    /// Answer one contract request by asking the workspace and translating what it said.
    pub fn answer(&self, request: &pb::Request) -> pb::Response {
        let outcome = self.resolve(request);
        pb::Response {
            response: Some(match outcome {
                Ok(response) => response,
                Err(message) => pb::response::Response::Error(pb::RequestError { message }),
            }),
        }
    }

    fn resolve(&self, request: &pb::Request) -> Result<pb::response::Response, String> {
        let Some(kind) = request.request.as_ref() else {
            return Err("the request named nothing this contract carries".into());
        };
        Ok(match kind {
            pb::request::Request::Workspace(_) => {
                pb::response::Response::Workspace(carried("the workspace", translate::workspace(&self.host.get("/api/state")?))?)
            }
            pb::request::Request::Dashboard(ask) => {
                root_of(&ask.root_id, "the dashboard")?;
                let value = self.host.get(&format!("/api/dashboard?rootId={}", encode(&ask.root_id)))?;
                pb::response::Response::Dashboard(carried("the dashboard", translate::dashboard(&value))?)
            }
            pb::request::Request::Tasks(ask) => {
                root_of(&ask.root_id, "the task list")?;
                let value = self.worker_read("tracker", &ask.root_id)?;
                pb::response::Response::Tasks(carried("the task list", translate::task_list(&value))?)
            }
            pb::request::Request::Token(ask) => {
                root_of(&ask.root_id, "the token")?;
                let value = self.worker_read("token", &ask.root_id)?;
                pb::response::Response::Token(carried("the token", translate::token(&value))?)
            }
            pb::request::Request::Agents(ask) => {
                root_of(&ask.root_id, "the agent menu")?;
                let value = self.worker_read("agents-menu", &ask.root_id)?;
                pb::response::Response::Agents(carried("the agent menu", translate::agent_menu(&value))?)
            }
        })
    }

    /* The worker answers `{ok, value}` for its read routes, and its refusals are in that envelope
       rather than in the HTTP status — so unwrapping it here is what turns "ok: false" into an
       error the client is told about instead of a default-constructed answer. */
    fn worker_read(&self, route: &str, root_id: &str) -> Result<serde_json::Value, String> {
        let value = self.worker.get(&format!("/api/{route}?rootId={}", encode(root_id)))?;
        if value.get("ok").and_then(serde_json::Value::as_bool) == Some(false) {
            let said = value.get("error").and_then(serde_json::Value::as_str).unwrap_or("no reason given");
            return Err(format!("the workspace refused {route}: {said}"));
        }
        Ok(value)
    }
}

/// Percent-encoding for the one thing that ever reaches a query string here: a root id.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
            other => format!("%{other:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_url_becomes_a_socket_address_and_a_host_header() {
        let endpoint = Endpoint::new("http://127.0.0.1:8931", "t");
        assert_eq!(endpoint.address().unwrap(), ("127.0.0.1:8931".into(), "127.0.0.1:8931".into()));
    }

    #[test]
    fn a_request_that_names_nothing_is_refused_rather_than_answered() {
        let workspace = Workspace {
            host: Endpoint::new("http://127.0.0.1:1", "t"),
            worker: Endpoint::new("http://127.0.0.1:1", "t"),
        };
        let answer = workspace.answer(&pb::Request { request: None });
        let Some(pb::response::Response::Error(error)) = answer.response else {
            panic!("a request naming nothing is an error, not an answer");
        };
        assert!(error.message.contains("carries"), "{}", error.message);
    }

    #[test]
    fn a_root_scoped_request_without_a_root_says_so_before_asking_anything() {
        let workspace = Workspace {
            /* Port 1 would refuse instantly; the point is that nothing is asked at all. */
            host: Endpoint::new("http://127.0.0.1:1", "t"),
            worker: Endpoint::new("http://127.0.0.1:1", "t"),
        };
        let answer = workspace.answer(&pb::Request {
            request: Some(pb::request::Request::Dashboard(pb::DashboardRequest { root_id: String::new() })),
        });
        let Some(pb::response::Response::Error(error)) = answer.response else { panic!("expected a refusal") };
        assert!(error.message.contains("named none"), "{}", error.message);
    }

    #[test]
    fn a_root_id_reaches_the_query_string_encoded() {
        assert_eq!(encode("a b/c"), "a%20b%2Fc");
    }
}
