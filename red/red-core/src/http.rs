//! The one authenticated GET the Rust side makes against a workspace (F180, F184).
//!
//! Hand-rolled, for the reason `red-agents`'s bind is: one request to a loopback port with a bearer
//! token does not justify a TLS stack and an async HTTP client in the dependency tree. It asks in
//! **HTTP/1.0**, which is what makes the answer a whole body rather than a chunked stream this
//! would have to reassemble.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

/// `http://127.0.0.1:PORT` split into the address a socket wants and the host header it needs.
pub fn address(url: &str) -> Result<(String, String), String> {
    let rest = url.strip_prefix("http://").ok_or_else(|| format!("{url} is not an http:// workspace URL"))?;
    let authority = rest.split('/').next().unwrap_or_default().to_string();
    if authority.is_empty() {
        return Err(format!("{url} names no host"));
    }
    let socket = if authority.contains(':') { authority.clone() } else { format!("{authority}:80") };
    Ok((socket, authority))
}

/// One GET, one JSON body, or the host's own words about why not.
pub fn get(url: &str, token: &str, path: &str) -> Result<serde_json::Value, String> {
    request(url, token, "GET", path, None, &[])
}

/// One POST with a JSON body. `headers` carries the caller's own lines — the X-Rengine-Agent
/// family, which is arbitration and never authentication (spec 095).
pub fn post(url: &str, token: &str, path: &str, body: &serde_json::Value, headers: &[(String, String)]) -> Result<serde_json::Value, String> {
    request(url, token, "POST", path, Some(body), headers)
}

/// A GET that carries the caller's identity lines.
pub fn get_as(url: &str, token: &str, path: &str, headers: &[(String, String)]) -> Result<serde_json::Value, String> {
    request(url, token, "GET", path, None, headers)
}

fn request(url: &str, token: &str, method: &str, path: &str, body: Option<&serde_json::Value>, headers: &[(String, String)]) -> Result<serde_json::Value, String> {
    let (socket, authority) = address(url)?;
    let mut stream = TcpStream::connect(&socket).map_err(|error| format!("cannot reach {socket}: {error}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(15))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(15))).ok();
    let payload = body.map(|value| value.to_string()).unwrap_or_default();
    let mut lines = format!("{method} {path} HTTP/1.0\r\nHost: {authority}\r\nAuthorization: Bearer {token}\r\nAccept: application/json\r\n");
    for (name, value) in headers {
        /* Only printable ASCII reaches a header line, because a value with a newline in it would
           be another header — the same rule the JS side's `carried` applies. */
        if value.bytes().all(|byte| (0x20..=0x7e).contains(&byte)) {
            lines.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    if body.is_some() {
        lines.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", payload.len()));
    }
    lines.push_str("Connection: close\r\n\r\n");
    lines.push_str(&payload);
    stream.write_all(lines.as_bytes()).map_err(|error| format!("cannot ask {socket} for {path}: {error}"))?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|error| format!("no answer from {socket} for {path}: {error}"))?;
    let text = String::from_utf8_lossy(&raw);
    let (head, raw_body) = text.split_once("\r\n\r\n").ok_or_else(|| format!("{socket} answered {path} with no headers"))?;
    /* HTTP/1.0 asks for a whole body, and the session host gives one — but the workspace worker
       PROXIES the host, copying its `Transfer-Encoding: chunked` header onto a reply it forwards
       verbatim. So a client that only ever spoke to the host can read every answer and still fail
       the first time it is pointed at the worker, with "trailing characters" from the chunk
       framing. Decoded here rather than avoided by asking the worker to do something else. */
    let decoded;
    let body: &str = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        decoded = dechunk(raw_body).ok_or_else(|| format!("{socket} answered {path} with a chunked body this client could not read"))?;
        &decoded
    } else {
        raw_body
    };
    let status = head.lines().next().and_then(|line| line.split_whitespace().nth(1)).unwrap_or("000");
    if status != "200" {
        /* The workspace's own words when it gave any: its routes answer `{error}` and a caller
           should see that sentence, not an HTTP status it cannot act on. */
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
            if let Some(said) = value.get("error").and_then(serde_json::Value::as_str) {
                return Err(said.to_string());
            }
        }
        let said = body.trim();
        return Err(format!(
            "the workspace answered {status} for {path}{}",
            if said.is_empty() { String::new() } else { format!(": {said}") }
        ));
    }
    serde_json::from_str(body).map_err(|error| format!("{path} did not answer JSON: {error}"))
}

/// `<hex length>\r\n<bytes>\r\n` until a zero-length chunk. Only what a proxied JSON answer uses:
/// chunk extensions and trailers are not accepted, because nothing here sends them.
fn dechunk(body: &str) -> Option<String> {
    let mut rest = body;
    let mut out = String::new();
    loop {
        let (header, remainder) = rest.split_once("\r\n")?;
        let size = usize::from_str_radix(header.trim(), 16).ok()?;
        if size == 0 {
            return Some(out);
        }
        if remainder.len() < size {
            return None;
        }
        out.push_str(&remainder[..size]);
        rest = remainder.get(size + 2..)?;
    }
}

/// Percent-encoding for the things that reach a query string here: ids and paths.
pub fn encode(value: &str) -> String {
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
    #[test]
    fn a_url_becomes_a_socket_address_and_a_host_header() {
        assert_eq!(super::address("http://127.0.0.1:8931").unwrap(), ("127.0.0.1:8931".into(), "127.0.0.1:8931".into()));
    }

    #[test]
    fn a_chunked_body_is_read_whole() {
        assert_eq!(super::dechunk("5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n").unwrap(), "hello world");
        assert_eq!(super::dechunk("0\r\n\r\n").unwrap(), "");
        assert!(super::dechunk("zz\r\nnope\r\n").is_none(), "a length that is not hex is refused, not guessed");
    }

    #[test]
    fn a_value_reaches_the_query_string_encoded() {
        assert_eq!(super::encode("a b/c"), "a%20b%2Fc");
    }
}
