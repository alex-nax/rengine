//! One HTTP message head, read and replayed (F188/F152a).
//!
//! Only what a front door needs: the request line, the headers it decides on, and enough framing to
//! forward a body without re-writing it. Bodies are copied **as they were framed** — by
//! `Content-Length` or by chunks — because a proxy that re-frames is a proxy that can change what
//! a route said, and every route here belongs to something else.

use std::io;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// What `main.mjs` would read before refusing with a 413. The door does not own that refusal yet —
/// the route behind it does — but it must not RESERVE what a client's header claims.
const MAX_BODY: usize = 8 * 1024 * 1024;

pub struct Head {
    pub raw: String,
    pub method: String,
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub upgrade: bool,
}

impl Head {
    /// Read until the blank line. Bytes after it belong to the body and are handed back in
    /// `buffered`, because a reader that dropped them would eat the first part of every POST.
    pub async fn read(stream: &mut TcpStream, buffered: &mut Vec<u8>) -> io::Result<Option<Head>> {
        let mut collected: Vec<u8> = std::mem::take(buffered);
        loop {
            if let Some(at) = find(&collected, b"\r\n\r\n") {
                let (head, rest) = collected.split_at(at + 4);
                let text = String::from_utf8_lossy(head).to_string();
                *buffered = rest.to_vec();
                return Ok(Head::parse(&text).map(Some).unwrap_or(None));
            }
            let mut chunk = [0u8; 8192];
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                return Ok(None);
            }
            collected.extend_from_slice(&chunk[..read]);
            if collected.len() > 1 << 20 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "a head past a megabyte is not one"));
            }
        }
    }

    pub fn parse(text: &str) -> Option<Head> {
        let mut lines = text.split("\r\n");
        let first = lines.next()?;
        let mut parts = first.split_whitespace();
        let method = parts.next()?.to_string();
        let target = parts.next().unwrap_or("/").to_string();
        let mut headers = Vec::new();
        for line in lines {
            if line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
            }
        }
        let upgrade = headers
            .iter()
            .any(|(name, value)| name == "upgrade" && value.eq_ignore_ascii_case("websocket"));
        Some(Head { raw: text.to_string(), method, target, headers, upgrade })
    }

    pub fn header(&self, name: &str) -> Option<String> {
        self.headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone())
    }

    pub fn path(&self) -> String {
        self.target.split('?').next().unwrap_or("/").to_string()
    }

    /// `URLSearchParams#get`: the FIRST value, and a bare key is the empty string rather than
    /// nothing — `?length` is a length of `''`, which `Number` reads as 0.
    pub fn query(&self, name: &str) -> Option<String> {
        self.query_values(name).into_iter().next()
    }

    /// `Object.fromEntries(query)`: the LAST value wins, which is the other half of the same rule
    /// and the one `/api/bytes` was read with, because that route took the whole query as an object.
    pub fn query_last(&self, name: &str) -> Option<String> {
        self.query_values(name).pop()
    }

    fn query_values(&self, name: &str) -> Vec<String> {
        let Some(query) = self.target.split_once('?').map(|(_, rest)| rest) else { return Vec::new() };
        query
            .split('&')
            .filter_map(|pair| match pair.split_once('=') {
                Some((key, value)) => (key == name).then(|| decode(value)),
                None => (pair == name).then(String::new),
            })
            .collect()
    }

    /// The same head, with this door's credential swapped for the backend's. Nothing else is
    /// touched: a header this process does not understand is a header it must not edit.
    pub fn replayed(&self, front: &crate::Front) -> String {
        let mut out = format!("{} {} HTTP/1.1\r\n", self.method, self.replaced_target(front));
        for (name, value) in &self.headers {
            let line = match name.as_str() {
                "authorization" => format!("Authorization: Bearer {}", front.backend_token),
                /* The backend authenticates an upgrade from the query string, which is rewritten
                   above; the host header names the backend it is going to. */
                "host" => format!("Host: {}", red_core::http::address(&front.backend).map(|(socket, _)| socket).unwrap_or_default()),
                _ => format!("{}: {}", canonical(name), value),
            };
            out.push_str(&line);
            out.push_str("\r\n");
        }
        if self.header("authorization").is_none() && !self.upgrade {
            out.push_str(&format!("Authorization: Bearer {}\r\n", front.backend_token));
        }
        out.push_str("\r\n");
        out
    }

    /// A socket's token rides in the query string, so the swap has to happen there too.
    fn replaced_target(&self, front: &crate::Front) -> String {
        if !self.upgrade {
            return self.target.clone();
        }
        let Some((path, query)) = self.target.split_once('?') else { return self.target.clone() };
        let rewritten: Vec<String> = query
            .split('&')
            .map(|pair| match pair.split_once('=') {
                Some(("token", _)) => format!("token={}", front.backend_token),
                _ => pair.to_string(),
            })
            .collect();
        format!("{path}?{}", rewritten.join("&"))
    }

    pub fn closes(&self) -> bool {
        self.header("connection").is_some_and(|value| value.eq_ignore_ascii_case("close"))
    }

    /// Whether this connection survives the answer. HTTP/1.1 keeps it unless the request says
    /// `close`; **HTTP/1.0 ends it unless the request says `keep-alive`**, and that is not a
    /// detail: `red_core::http` asks in HTTP/1.0 with `Connection: close` and reads to end of
    /// stream, so a door that held the socket open would answer every Rust client in the workspace
    /// correctly and then hang until its read timeout.
    pub fn keeps_alive(&self) -> bool {
        let connection = self.header("connection").unwrap_or_default().to_ascii_lowercase();
        if self.raw.lines().next().is_some_and(|line| line.contains("HTTP/1.0")) {
            return connection.contains("keep-alive");
        }
        !connection.contains("close")
    }

    /// The body as a string, for a route this door answers itself rather than forwards.
    pub async fn read_body(&self, from: &mut TcpStream, buffered: &mut Vec<u8>) -> io::Result<String> {
        Ok(String::from_utf8_lossy(&self.read_body_bytes(from, buffered).await?).to_string())
    }

    /// The body's own bytes. A caller that may still DECLINE the request needs these rather than the
    /// lossy string: the forwarder frames what it sends from `content-length`, and a replacement
    /// character in place of a byte it never saw would be a different request.
    pub async fn read_body_bytes(&self, from: &mut TcpStream, buffered: &mut Vec<u8>) -> io::Result<Vec<u8>> {
        let length: usize = self.header("content-length").and_then(|value| value.trim().parse().ok()).unwrap_or(0);
        /* `content-length` is a number a client chose. `main.mjs` refused a body past 8 MiB with a
           413 rather than reserving what it was told to; reserving it is how an authenticated client
           takes the door down with one header. */
        let mut body = Vec::with_capacity(length.min(MAX_BODY));
        let take = buffered.len().min(length);
        body.extend_from_slice(&buffered[..take]);
        buffered.drain(..take);
        let mut chunk = [0u8; 8192];
        while body.len() < length {
            let read = from.read(&mut chunk[..(length - body.len()).min(8192)]).await?;
            if read == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the body ended early"));
            }
            body.extend_from_slice(&chunk[..read]);
        }
        Ok(body)
    }

    /// Copy the body the way its own head framed it, and nothing more: a byte past the body belongs
    /// to the next request on this connection.
    pub async fn forward_body(&self, from: &mut TcpStream, buffered: &mut Vec<u8>, to: &mut TcpStream) -> io::Result<()> {
        if self.header("transfer-encoding").is_some_and(|value| value.to_ascii_lowercase().contains("chunked")) {
            return copy_chunked(from, buffered, to).await;
        }
        let length: usize = self.header("content-length").and_then(|value| value.trim().parse().ok()).unwrap_or(0);
        if length == 0 {
            /* A response with neither framing header ends at end-of-stream — the shape a HTTP/1.0
               answer takes — and there is nothing after it to protect. */
            if self.method.starts_with("HTTP/") && self.header("content-length").is_none() {
                if !buffered.is_empty() {
                    to.write_all(buffered).await?;
                    buffered.clear();
                }
                tokio::io::copy(from, to).await?;
            }
            return Ok(());
        }
        let mut left = length;
        if !buffered.is_empty() {
            let take = buffered.len().min(left);
            to.write_all(&buffered[..take]).await?;
            buffered.drain(..take);
            left -= take;
        }
        let mut chunk = [0u8; 8192];
        while left > 0 {
            let read = from.read(&mut chunk[..left.min(8192)]).await?;
            if read == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the body ended early"));
            }
            to.write_all(&chunk[..read]).await?;
            left -= read;
        }
        Ok(())
    }
}

async fn copy_chunked(from: &mut TcpStream, buffered: &mut Vec<u8>, to: &mut TcpStream) -> io::Result<()> {
    loop {
        let line = read_line(from, buffered).await?;
        to.write_all(line.as_bytes()).await?;
        let size = usize::from_str_radix(line.trim().split(';').next().unwrap_or("0"), 16)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "a chunk length that is not hex"))?;
        let mut left = size + 2; // the chunk and its trailing CRLF
        while left > 0 {
            if buffered.is_empty() {
                let mut chunk = [0u8; 8192];
                let read = from.read(&mut chunk).await?;
                if read == 0 {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "a chunk ended early"));
                }
                buffered.extend_from_slice(&chunk[..read]);
            }
            let take = buffered.len().min(left);
            to.write_all(&buffered[..take]).await?;
            buffered.drain(..take);
            left -= take;
        }
        if size == 0 {
            return Ok(());
        }
    }
}

async fn read_line(from: &mut TcpStream, buffered: &mut Vec<u8>) -> io::Result<String> {
    loop {
        if let Some(at) = find(buffered, b"\r\n") {
            let line = String::from_utf8_lossy(&buffered[..at + 2]).to_string();
            buffered.drain(..at + 2);
            return Ok(line);
        }
        let mut chunk = [0u8; 8192];
        let read = from.read(&mut chunk).await?;
        if read == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "a line ended early"));
        }
        buffered.extend_from_slice(&chunk[..read]);
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                match u8::from_str_radix(&value[index + 1..index + 3], 16) {
                    Ok(byte) => { out.push(byte); index += 3; }
                    Err(_) => { out.push(bytes[index]); index += 1; }
                }
            }
            b'+' => { out.push(b' '); index += 1; }
            byte => { out.push(byte); index += 1; }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// `content-length` back to `Content-Length`: some clients are particular, and a head that came in
/// one shape should leave in it.
fn canonical(name: &str) -> String {
    name.split('-')
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_http_1_0_request_ends_its_connection_and_an_http_1_1_request_does_not() {
        assert!(!Head::parse("GET /api/state HTTP/1.0\r\nConnection: close\r\n\r\n").expect("parsed").keeps_alive());
        assert!(!Head::parse("GET /api/state HTTP/1.0\r\nHost: x\r\n\r\n").expect("parsed").keeps_alive(),
                "1.0 without keep-alive ends, which is what read-to-end clients rely on");
        assert!(Head::parse("GET /api/state HTTP/1.0\r\nConnection: keep-alive\r\n\r\n").expect("parsed").keeps_alive());
        assert!(Head::parse("GET /api/state HTTP/1.1\r\nHost: x\r\n\r\n").expect("parsed").keeps_alive());
        assert!(!Head::parse("GET /api/state HTTP/1.1\r\nConnection: close\r\n\r\n").expect("parsed").keeps_alive());
    }

    #[test]
    fn a_head_is_its_line_its_headers_and_nothing_after_the_blank_line() {
        let head = Head::parse("POST /api/save HTTP/1.1\r\nContent-Length: 12\r\nX-Rengine-Agent: a\r\n\r\n").expect("parsed");
        assert_eq!(head.method, "POST");
        assert_eq!(head.path(), "/api/save");
        assert_eq!(head.header("content-length").as_deref(), Some("12"));
        assert!(!head.upgrade);
    }

    #[test]
    fn a_query_value_is_decoded_the_way_it_was_encoded() {
        let head = Head::parse("GET /events?token=abc&id=a%20b HTTP/1.1\r\n\r\n").expect("parsed");
        assert_eq!(head.query("token").as_deref(), Some("abc"));
        assert_eq!(head.query("id").as_deref(), Some("a b"));
        assert_eq!(head.query("missing"), None);
    }

    #[test]
    fn an_upgrade_is_recognised_by_its_header_not_its_path() {
        let head = Head::parse("GET /events HTTP/1.1\r\nUpgrade: WebSocket\r\nConnection: Upgrade\r\n\r\n").expect("parsed");
        assert!(head.upgrade, "the header decides, and its value is compared without case");
    }

    #[test]
    fn a_header_name_leaves_in_the_shape_it_arrived_in() {
        assert_eq!(canonical("content-length"), "Content-Length");
        assert_eq!(canonical("x-rengine-agent-label"), "X-Rengine-Agent-Label");
    }
}
