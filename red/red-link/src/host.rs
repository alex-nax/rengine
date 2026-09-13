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

use red_core::http::encode;
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

    /// One GET, one JSON body. `path` is workspace-relative and already query-encoded.
    pub fn get(&self, path: &str) -> Result<serde_json::Value, String> {
        red_core::http::get(&self.url, &self.token, path)
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

#[cfg(test)]
mod tests {
    use super::*;

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

}

/* ---- the lifecycle ring (F183/F181b) ---------------------------------------------------------- */

/// The worker's feed as a stream of translated frames.
///
/// `/feed?rootId&after=N` replays the ring from the cursor and then stays open with live frames on
/// the same socket — so a subscriber's resume and its live subscription are one connection, which
/// is what makes the cursor mean what it means. The token rides in the query string because that is
/// how the worker authenticates this socket (`worker.mjs`'s upgrade handler reads it from there and
/// puts it back in an Authorization header); it never leaves this process in any other direction.
pub fn feed_url(worker: &Endpoint, root_id: &str, after: u64) -> Result<String, String> {
    let rest = worker
        .url
        .strip_prefix("http://")
        .ok_or_else(|| format!("{} is not an http:// workspace URL", worker.url))?;
    let authority = rest.split('/').next().unwrap_or_default();
    Ok(format!(
        "ws://{authority}/feed?rootId={}&token={}&after={after}",
        encode(root_id),
        encode(&worker.token)
    ))
}
