//! MCP over the socket, answered byte for byte as the SDK answered it (spec 133, D8).
//!
//! The JavaScript bridge handed every frame to `@modelcontextprotocol/sdk`'s `Server`, so what a
//! CLI gets back — the key order of an answer, `Method not found`, a handler that throws, and the
//! frames that are NOT answered because the SDK's request schema is strict — is the SDK's. This
//! module is that surface, to the depth the record pins: the strict envelope, the per-method
//! parameter validation in zod's own sentences, and the one tool.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::bridge::Bridge;

/// What the SDK on the other end knows how to speak (`SUPPORTED_PROTOCOL_VERSIONS`). A client
/// asking for one of these is answered in its own version; anything else in the latest.
const SUPPORTED: [&str; 5] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const LATEST: &str = "2025-11-25";

/// A frame the SDK would dispatch as a request: `jsonrpc: "2.0"`, an id that is a string or an
/// integer, a method, optional params — and nothing else at the top level.
pub struct Request {
    pub id: Value,
    pub method: String,
    pub params: Option<Value>,
}

pub enum Reply {
    Now(String),
    Later(Pin<Box<dyn Future<Output = String> + Send>>),
    Silent,
}

/// The SDK's `isJSONRPCRequest`, or nothing: a frame that is not JSON, not an object, not this
/// exact shape, or a notification or a response, is not answered.
pub fn request_from(text: &str) -> Option<Request> {
    let value: Value = serde_json::from_str(text).ok()?;
    let value = normalize_numbers(value);
    let object = value.as_object()?;
    if object.keys().any(|key| !matches!(key.as_str(), "jsonrpc" | "id" | "method" | "params")) {
        return None;
    }
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return None;
    }
    let id = match object.get("id")? {
        Value::String(text) => Value::String(text.clone()),
        Value::Number(number) if number.is_i64() || number.is_u64() => Value::Number(number.clone()),
        _ => return None,
    };
    let method = object.get("method")?.as_str()?.to_string();
    let params = match object.get("params") {
        None => None,
        Some(params) => {
            valid_base_params(params)?;
            Some(params.clone())
        }
    };
    Some(Request { id, method, params })
}

/// `BaseRequestParamsSchema.loose()`: an object, whose `_meta` — if there is one — is an object
/// whose `progressToken` — if there is one — is a string or an integer.
fn valid_base_params(params: &Value) -> Option<()> {
    let object = params.as_object()?;
    if let Some(meta) = object.get("_meta") {
        let meta = meta.as_object()?;
        if let Some(token) = meta.get("progressToken") {
            match token {
                Value::String(_) => {}
                Value::Number(number) if number.is_i64() || number.is_u64() => {}
                _ => return None,
            }
        }
    }
    Some(())
}

/// A JSON number that is integral is an integer in JavaScript: `5.0` is `5`, and `1e2` is `100`,
/// in the id that is echoed and in the uri that is passed through.
fn normalize_numbers(value: Value) -> Value {
    match value {
        Value::Number(number) => match number.as_f64() {
            Some(float) if number.as_i64().is_none() && number.as_u64().is_none() && float.is_finite() && float.fract() == 0.0 && float.abs() < 9.007_199_254_740_992e15 => {
                json!(float as i64)
            }
            _ => Value::Number(number),
        },
        Value::Array(items) => Value::Array(items.into_iter().map(normalize_numbers).collect()),
        Value::Object(entries) => Value::Object(entries.into_iter().map(|(key, value)| (key, normalize_numbers(value))).collect()),
        other => other,
    }
}

/// `{ result, jsonrpc, id }` — the SDK's order.
pub fn result(id: &Value, result: Value) -> String {
    json!({ "result": result, "jsonrpc": "2.0", "id": id }).to_string()
}

/// `{ jsonrpc, id, error: { code, message } }` — the SDK's order.
pub fn error(id: &Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

/* ---- zod, to the depth the record pins ---------------------------------------------------------- */

struct Issue {
    expected: &'static str,
    path: Vec<&'static str>,
    received: &'static str,
}

/// zod's name for what it received.
fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// `JSON.stringify(issues, null, 2)`, which is the `message` of the error the SDK answers with.
fn issues_text(issues: &[Issue]) -> String {
    let list: Vec<Value> = issues
        .iter()
        .map(|issue| {
            json!({
                "expected": issue.expected,
                "code": "invalid_type",
                "path": issue.path,
                "message": format!("Invalid input: expected {}, received {}", issue.expected, issue.received),
            })
        })
        .collect();
    serde_json::to_string_pretty(&list).expect("issues serialise")
}

fn expect_type(issues: &mut Vec<Issue>, value: Option<&Value>, expected: &'static str, path: Vec<&'static str>, required: bool) {
    let ok = match (expected, value) {
        (_, None) => !required,
        ("string", Some(Value::String(_))) | ("object", Some(Value::Object(_))) | ("record", Some(Value::Object(_))) | ("array", Some(Value::Array(_))) => true,
        _ => false,
    };
    if !ok {
        issues.push(Issue { expected, path, received: received(value) });
    }
}

/// `InitializeRequestParamsSchema`: `protocolVersion`, `capabilities`, `clientInfo { name, title?,
/// icons?, version, websiteUrl? }`, in the schema's own order.
fn validate_initialize(params: Option<&Value>) -> Vec<Issue> {
    let mut issues = Vec::new();
    let Some(params) = params else {
        issues.push(Issue { expected: "object", path: vec!["params"], received: "undefined" });
        return issues;
    };
    expect_type(&mut issues, params.get("protocolVersion"), "string", vec!["params", "protocolVersion"], true);
    expect_type(&mut issues, params.get("capabilities"), "object", vec!["params", "capabilities"], true);
    match params.get("clientInfo") {
        Some(Value::Object(info)) => {
            expect_type(&mut issues, info.get("name"), "string", vec!["params", "clientInfo", "name"], true);
            expect_type(&mut issues, info.get("title"), "string", vec!["params", "clientInfo", "title"], false);
            expect_type(&mut issues, info.get("icons"), "array", vec!["params", "clientInfo", "icons"], false);
            expect_type(&mut issues, info.get("version"), "string", vec!["params", "clientInfo", "version"], true);
            expect_type(&mut issues, info.get("websiteUrl"), "string", vec!["params", "clientInfo", "websiteUrl"], false);
        }
        other => expect_type(&mut issues, other, "object", vec!["params", "clientInfo"], true),
    }
    issues
}

/// `PaginatedRequestParamsSchema`: an optional `cursor` string.
fn validate_list(params: Option<&Value>) -> Vec<Issue> {
    let mut issues = Vec::new();
    if let Some(params) = params {
        expect_type(&mut issues, params.get("cursor"), "string", vec!["params", "cursor"], false);
    }
    issues
}

/// `CallToolRequestParamsSchema`: `name`, and `arguments` as a record when it is there at all.
fn validate_call(params: Option<&Value>) -> Vec<Issue> {
    let mut issues = Vec::new();
    let Some(params) = params else {
        issues.push(Issue { expected: "object", path: vec!["params"], received: "undefined" });
        return issues;
    };
    expect_type(&mut issues, params.get("name"), "string", vec!["params", "name"], true);
    expect_type(&mut issues, params.get("arguments"), "record", vec!["params", "arguments"], false);
    issues
}

/* ---- the handlers ------------------------------------------------------------------------------ */

pub fn tool_list() -> Value {
    json!({ "tools": [{
        "name": "getDiagnostics",
        "description": format!("Diagnostics {} holds for a file, from the language servers the project declares. A project that declares none answers an empty list rather than refusing.", red_core::PRODUCT_NAME),
        "inputSchema": { "type": "object", "properties": { "uri": { "type": "string" } } },
    }] })
}

fn negotiated(asked: Option<&str>) -> &'static str {
    match asked {
        Some(version) => SUPPORTED.iter().copied().find(|known| *known == version).unwrap_or(LATEST),
        None => LATEST,
    }
}

/// The answer to one request, now or later. A handler that "throws" answers `-32603` with the
/// message, exactly as the SDK wrapped a rejected handler.
pub fn reply(bridge: &Arc<Bridge>, request: Request) -> Reply {
    let id = request.id;
    let params = request.params.as_ref();
    let refused = |issues: Vec<Issue>| Reply::Now(error(&id, -32603, &issues_text(&issues)));
    match request.method.as_str() {
        "initialize" => {
            let issues = validate_initialize(params);
            if !issues.is_empty() {
                return refused(issues);
            }
            let asked = params.and_then(|p| p.get("protocolVersion")).and_then(Value::as_str);
            Reply::Now(result(&id, json!({
                "protocolVersion": negotiated(asked),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "rengine-ide", "version": "1.0.0" },
            })))
        }
        "ping" => Reply::Now(result(&id, json!({}))),
        "tools/list" => {
            let issues = validate_list(params);
            if !issues.is_empty() {
                return refused(issues);
            }
            Reply::Now(result(&id, tool_list()))
        }
        "tools/call" => {
            let issues = validate_call(params);
            if !issues.is_empty() {
                return refused(issues);
            }
            let params = params.expect("validated");
            let name = params.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
            if name != "getDiagnostics" {
                return Reply::Now(error(&id, -32603, &format!("{name} is not a tool {} serves yet.", red_core::PRODUCT_NAME)));
            }
            /* `request.params.arguments?.uri ?? ''`: absent and null are the empty uri; anything
               else is passed through as it came, a number included. */
            let uri = match params.get("arguments").and_then(|arguments| arguments.get("uri")) {
                None | Some(Value::Null) => Value::String(String::new()),
                Some(other) => other.clone(),
            };
            let source = bridge.source();
            Reply::Later(Box::pin(async move {
                let answered = match source {
                    Some(source) => source(uri.clone()).await,
                    None => Ok(Value::Null),
                };
                match answered {
                    Ok(items) => {
                        let diagnostics = if items.is_null() { json!([]) } else { items };
                        let mut entry = Map::new();
                        entry.insert("uri".into(), uri);
                        entry.insert("diagnostics".into(), diagnostics);
                        let text = Value::Array(vec![Value::Object(entry)]).to_string();
                        result(&id, json!({ "content": [{ "type": "text", "text": text }] }))
                    }
                    Err(message) => error(&id, -32603, &message),
                }
            }))
        }
        _ => Reply::Now(error(&id, -32601, "Method not found")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_sdks_exact_request_shape_is_a_request() {
        assert!(request_from(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#).is_some());
        assert!(request_from(r#"{"jsonrpc":"2.0","id":"five","method":"ping","params":{}}"#).is_some());
        assert!(request_from(r#"{"jsonrpc":"2.0","id":1,"method":"ping","extra":true}"#).is_none(), "strict: no extra keys");
        assert!(request_from(r#"{"id":1,"method":"ping"}"#).is_none(), "jsonrpc is required");
        assert!(request_from(r#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#).is_none());
        assert!(request_from(r#"{"jsonrpc":"2.0","id":9.5,"method":"ping"}"#).is_none(), "an id is an integer or a string");
        assert!(request_from(r#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#).is_none());
        assert!(request_from(r#"{"jsonrpc":"2.0","method":"ping"}"#).is_none(), "a notification is not answered");
        assert!(request_from(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#).is_none(), "a response is not answered");
        assert!(request_from(r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":null}"#).is_none(), "params must be an object");
        assert!(request_from(r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":"x"}"#).is_none());
        assert!(request_from(r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{"_meta":5}}"#).is_none());
        assert!(request_from(r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{"_meta":{"progressToken":"p"},"extra":1}}"#).is_some(), "loose inside");
        assert!(request_from("this is not json").is_none());
        assert_eq!(request_from(r#"{"jsonrpc":"2.0","id":5.0,"method":"ping"}"#).unwrap().id, json!(5), "5.0 is the integer 5");
    }

    #[test]
    fn answers_carry_the_sdks_key_order() {
        assert_eq!(result(&json!(3), json!({})), r#"{"result":{},"jsonrpc":"2.0","id":3}"#);
        assert_eq!(error(&json!("x"), -32601, "Method not found"), r#"{"jsonrpc":"2.0","id":"x","error":{"code":-32601,"message":"Method not found"}}"#);
    }

    #[test]
    fn zods_sentences_are_reproduced() {
        let issues = validate_initialize(None);
        assert_eq!(issues_text(&issues), "[\n  {\n    \"expected\": \"object\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"params\"\n    ],\n    \"message\": \"Invalid input: expected object, received undefined\"\n  }\n]");
        let issues = validate_initialize(Some(&json!({ "protocolVersion": 5, "capabilities": null, "clientInfo": { "name": "x" } })));
        assert_eq!(issues.iter().map(|i| (i.expected, i.path.join("."), i.received)).collect::<Vec<_>>(), [
            ("string", "params.protocolVersion".to_string(), "number"),
            ("object", "params.capabilities".to_string(), "null"),
            ("string", "params.clientInfo.version".to_string(), "undefined"),
        ]);
        let issues = validate_call(Some(&json!({ "name": "getDiagnostics", "arguments": [] })));
        assert_eq!(issues.iter().map(|i| (i.expected, i.received)).collect::<Vec<_>>(), [("record", "array")]);
        assert!(validate_call(Some(&json!({ "name": "getDiagnostics" }))).is_empty(), "arguments may be absent");
        assert_eq!(validate_list(Some(&json!({ "cursor": 5 }))).len(), 1);
        assert!(validate_list(None).is_empty());
    }

    #[test]
    fn a_version_the_sdk_knows_is_echoed_and_another_is_answered_in_the_latest() {
        assert_eq!(negotiated(Some("2024-11-05")), "2024-11-05");
        assert_eq!(negotiated(Some("1999-01-01")), "2025-11-25");
        assert_eq!(negotiated(None), "2025-11-25");
    }
}
