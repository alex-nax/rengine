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
    let (socket, authority) = address(url)?;
    let mut stream = TcpStream::connect(&socket).map_err(|error| format!("cannot reach {socket}: {error}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(15))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(15))).ok();
    let request = format!(
        "GET {path} HTTP/1.0\r\nHost: {authority}\r\nAuthorization: Bearer {token}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).map_err(|error| format!("cannot ask {socket} for {path}: {error}"))?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|error| format!("no answer from {socket} for {path}: {error}"))?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n").ok_or_else(|| format!("{socket} answered {path} with no headers"))?;
    let status = head.lines().next().and_then(|line| line.split_whitespace().nth(1)).unwrap_or("000");
    if status != "200" {
        let said = body.trim();
        return Err(format!(
            "the workspace answered {status} for {path}{}",
            if said.is_empty() { String::new() } else { format!(": {said}") }
        ));
    }
    serde_json::from_str(body).map_err(|error| format!("{path} did not answer JSON: {error}"))
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
    fn a_value_reaches_the_query_string_encoded() {
        assert_eq!(super::encode("a b/c"), "a%20b%2Fc");
    }
}
