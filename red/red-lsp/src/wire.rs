//! The two things about this protocol that are not JSON-RPC: how a message is framed, and how a
//! declaration says which files a server serves.

use serde_json::Value;

/// The protocol frames every message with a Content-Length header, so a reader that splits on
/// newlines works right up until a diagnostic contains one — and a diagnostic quoting source will.
pub struct Framer {
    buffer: Vec<u8>,
}

impl Default for Framer {
    fn default() -> Self {
        Framer { buffer: Vec::new() }
    }
}

impl Framer {
    /// Feed bytes as they arrive — a pipe is under no obligation to align with messages — and take
    /// whatever whole messages that completed.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<Value> {
        self.buffer.extend_from_slice(chunk);
        let mut read = Vec::new();
        loop {
            let Some(header) = find(&self.buffer, b"\r\n\r\n") else { return read };
            let head = String::from_utf8_lossy(&self.buffer[..header]).to_ascii_lowercase();
            let length = head
                .split("content-length:")
                .nth(1)
                .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit() && !c.is_whitespace()).next())
                .and_then(|digits| digits.trim().parse::<usize>().ok());
            let Some(length) = length else {
                /* A header we cannot read is skipped, not a reason to stop reading: the next frame
                   may be perfectly good. */
                self.buffer.drain(..header + 4);
                continue;
            };
            if self.buffer.len() < header + 4 + length {
                return read;
            }
            let body = self.buffer[header + 4..header + 4 + length].to_vec();
            self.buffer.drain(..header + 4 + length);
            /* A frame we cannot parse is not a reason to stop reading either. */
            if let Ok(value) = serde_json::from_slice::<Value>(&body) {
                read.push(value);
            }
        }
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

/// One message, framed to go out.
pub fn frame(message: &Value) -> Vec<u8> {
    let body = message.to_string().into_bytes();
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(&body);
    out
}

/// The same glob rule the format registry uses, so a project declares patterns one way.
///
/// The directory wildcard is matched BEFORE the single star it contains. Expanding `**/` and only
/// then rewriting every remaining star rewrites the star inside that expansion too, and a pattern
/// reaching into a subdirectory stops matching a file directly inside it — which is exactly how
/// this failed when it was first written. Matched directly rather than compiled to a regular
/// expression, so there is no expansion to rewrite.
pub fn matches(pattern: &str, relative: &str) -> bool {
    glob(&pattern.to_ascii_lowercase(), &relative.replace('\\', "/").to_ascii_lowercase())
}

fn glob(pattern: &str, value: &str) -> bool {
    if let Some(after) = pattern.strip_prefix("**/") {
        /* Zero directories, or any number of them: `src/**/*.c` names `src/a.c` as well as
           `src/one/a.c`. */
        if glob(after, value) {
            return true;
        }
        let mut rest = value;
        while let Some(at) = rest.find('/') {
            rest = &rest[at + 1..];
            if glob(after, rest) {
                return true;
            }
        }
        return false;
    }
    let mut characters = pattern.chars();
    match characters.next() {
        None => value.is_empty(),
        Some('*') => {
            let after = characters.as_str();
            /* A single star never crosses a directory boundary. */
            for index in value.char_indices().map(|(index, _)| index).chain(std::iter::once(value.len())) {
                if value[..index].contains('/') {
                    break;
                }
                if glob(after, &value[index..]) {
                    return true;
                }
            }
            false
        }
        Some('?') => {
            let mut rest = value.chars();
            matches!(rest.next(), Some(character) if character != '/') && glob(characters.as_str(), rest.as_str())
        }
        Some(literal) => {
            let mut rest = value.chars();
            rest.next() == Some(literal) && glob(characters.as_str(), rest.as_str())
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    /// A diagnostic with a blank line in it is exactly the input that breaks a naive reader, and a
    /// pipe delivers it a byte at a time if it feels like it.
    #[test]
    fn a_body_containing_the_delimiter_is_read_whole() {
        let body = json!({ "method": "note", "params": { "text": "first\r\n\r\nsecond" } });
        let bytes = super::frame(&body);
        let mut framer = super::Framer::default();
        let mut read = Vec::new();
        for byte in bytes {
            read.extend(framer.feed(&[byte]));
        }
        assert_eq!(read.len(), 1);
        assert_eq!(read[0]["params"]["text"], json!("first\r\n\r\nsecond"));
    }

    /// The directory wildcard reaches a file directly inside the directory too — the bug this glob
    /// had the first time it was written.
    #[test]
    fn a_directory_wildcard_reaches_a_file_directly_inside_it() {
        assert!(super::matches("src/**/*.c", "src/deep.c"));
        assert!(super::matches("src/**/*.c", "src/one/two/deep.c"));
        assert!(!super::matches("src/**/*.c", "other/deep.c"));
        assert!(super::matches("*.c", "a.c"));
        assert!(!super::matches("*.c", "src/a.c"), "a single star does not cross a directory");
        assert!(super::matches("*.C", "a.c"), "patterns are matched without regard to case");
        assert!(super::matches("a?.c", "ab.c"));
        assert!(!super::matches("a?.c", "a/.c"));
    }
}
