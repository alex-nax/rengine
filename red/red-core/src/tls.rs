//! HTTPS, for the one thing in this workspace that talks to the internet (F154, spec 083).
//!
//! A tracker's OAuth exchange and its API are the only outbound calls rEngine makes: everything else
//! is loopback. So this is deliberately small — a request, an answer, and no client object to
//! configure — and it exists at all because a credential exchange over plain TCP is not a thing to
//! do.
//!
//! **The trust roots are the MACHINE's** (`rustls-native-certs`), not a bundled CA set. A person
//! behind a corporate proxy that inspects TLS has their organisation's root installed in the OS
//! store and nowhere else; a binary carrying its own copy of Mozilla's list would fail for them with
//! nothing they could do about it. It also means rEngine does not ship a trust decision that ages
//! with the binary. This is the same deference the rest of the workspace shows the machine it runs
//! on — the shell it was told about, the PATH it was given, the CLI's own configuration directory.

use std::io::{Read, Write};
use std::sync::Arc;

/// One answer: the status a caller acts on, and the body.
pub struct Answer {
    pub status: u16,
    pub body: String,
}

impl Answer {
    /// `response.ok` — any 2xx, which is the range the JavaScript checked.
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn json(&self) -> Option<serde_json::Value> {
        serde_json::from_str(&self.body).ok()
    }
}

/// `https://host[:port]/path` — split, because there is no URL type here and one call site.
fn parts(url: &str) -> Result<(String, u16, String), String> {
    let rest = url.strip_prefix("https://").ok_or_else(|| format!("{url} is not https"))?;
    let (authority, path) = match rest.find('/') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host.to_string(), port.parse::<u16>().map_err(|_| format!("{url} names no port"))?),
        None => (authority.to_string(), 443),
    };
    if host.is_empty() {
        return Err(format!("{url} names no host"));
    }
    Ok((host, port, path.to_string()))
}

fn roots() -> Result<rustls::RootCertStore, String> {
    let found = rustls_native_certs::load_native_certs();
    let mut store = rustls::RootCertStore::empty();
    for certificate in found.certs {
        let _ = store.add(certificate);
    }
    if store.is_empty() {
        /* Named, because the alternative is a TLS error a person cannot act on. */
        return Err(format!(
            "this machine's certificate store could not be read, so nothing outside it can be trusted: {}",
            found.errors.iter().map(ToString::to_string).collect::<Vec<_>>().join("; ")
        ));
    }
    Ok(store)
}

/// One request, and its answer. Blocking, like every other client here.
pub fn request(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&str>) -> Result<Answer, String> {
    let (host, port, path) = parts(url)?;
    let config = rustls::ClientConfig::builder().with_root_certificates(roots()?).with_no_client_auth();
    let server = rustls::pki_types::ServerName::try_from(host.clone()).map_err(|_| format!("{host} is not a server name"))?;
    let mut session = rustls::ClientConnection::new(Arc::new(config), server).map_err(|error| error.to_string())?;
    let mut socket = std::net::TcpStream::connect((host.as_str(), port)).map_err(|error| format!("cannot reach {host}:{port}: {error}"))?;
    socket.set_read_timeout(Some(std::time::Duration::from_secs(30))).ok();
    socket.set_write_timeout(Some(std::time::Duration::from_secs(30))).ok();
    let mut stream = rustls::Stream::new(&mut session, &mut socket);

    let payload = body.unwrap_or_default();
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nAccept: application/json\r\n");
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if body.is_some() {
        head.push_str(&format!("Content-Length: {}\r\n", payload.len()));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).map_err(|error| format!("cannot ask {host}: {error}"))?;
    stream.write_all(payload.as_bytes()).map_err(|error| format!("cannot ask {host}: {error}"))?;
    stream.flush().ok();

    let mut raw = Vec::new();
    /* `Connection: close`, so end-of-stream is the end of the answer — and a close_notify this peer
        did not send is not a failure to report to a person who asked about their tasks. */
    match stream.read_to_end(&mut raw) {
        Ok(_) => {}
        Err(error) if !raw.is_empty() && error.kind() == std::io::ErrorKind::UnexpectedEof => {}
        Err(error) => return Err(format!("no answer from {host}: {error}")),
    }
    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, body) = text.split_once("\r\n\r\n").ok_or_else(|| format!("{host} answered with no headers"))?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| format!("{host} answered with no status"))?;
    let body = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        dechunk(body).ok_or_else(|| format!("{host} answered with a chunked body this client could not read"))?
    } else {
        body.to_string()
    };
    Ok(Answer { status, body })
}

/// `application/x-www-form-urlencoded`, which is what an OAuth endpoint takes.
pub fn post_form(url: &str, body: &str) -> Result<Answer, String> {
    request("POST", url, &[("Content-Type", "application/x-www-form-urlencoded")], Some(body))
}

fn dechunk(body: &str) -> Option<String> {
    let mut rest = body;
    let mut out = String::new();
    loop {
        let (size, remainder) = rest.split_once("\r\n")?;
        let size = usize::from_str_radix(size.trim(), 16).ok()?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_url_is_split_into_what_a_request_needs() {
        assert_eq!(parts("https://api.linear.app/oauth/token").expect("split"),
                   ("api.linear.app".to_string(), 443, "/oauth/token".to_string()));
        assert_eq!(parts("https://example.test:8443/a/b?c=d").expect("split"),
                   ("example.test".to_string(), 8443, "/a/b?c=d".to_string()));
        assert_eq!(parts("https://example.test").expect("split").2, "/");
        /* Plain HTTP is refused rather than upgraded: this client exists BECAUSE a credential
           exchange must not go out in the clear, and silently doing it over TCP would be the one
           failure nobody would see. */
        assert!(request("POST", "http://example.test/", &[], None).is_err());
        assert!(parts("http://example.test/").is_err());
        assert!(parts("https:///nothing").is_err());
    }

    #[test]
    fn a_chunked_answer_is_read_back_whole() {
        assert_eq!(dechunk("4\r\n{\"a\"\r\n5\r\n:1}\r\n\r\n0\r\n\r\n").expect("decoded"), "{\"a\":1}\r\n");
        assert_eq!(dechunk("0\r\n\r\n").expect("decoded"), "");
        assert_eq!(dechunk("zz\r\nnope\r\n"), None, "a length that is not a length is not read past");
    }

    /* `response.ok` is any 2xx, which is the range the JavaScript checked — and the difference
       matters: a 201 or a 204 from a token endpoint is a success. */
    #[test]
    fn an_answer_is_ok_over_the_range_a_caller_checks() {
        for status in [200u16, 201, 204, 299] {
            assert!(Answer { status, body: String::new() }.ok(), "{status}");
        }
        for status in [199u16, 300, 400, 401, 500] {
            assert!(!Answer { status, body: String::new() }.ok(), "{status}");
        }
    }
}
