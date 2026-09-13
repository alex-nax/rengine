//! `/api/image`: a project's own image bytes, for a pane that is showing one (F156a, spec 129).
//!
//! The route hands a file back verbatim, so every judgement is about whether it is safe to: inside
//! the project root (the store's rule, symlinks included), a regular file, small enough to hold, and
//! image data whose header this workspace can read. Nothing is transcoded — the bytes on disk are
//! the bytes a client gets — which is why the header has to be understood rather than trusted: a
//! `.png` that is markup is served to a viewer as whatever the viewer decides it is.
//!
//! The dimensions come from the header for the same reason the JS side used a parser rather than a
//! guess: an 8,192-pixel limit is a limit on what a pane will try to draw, and a file that lies
//! about its size is the case the limit exists for.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::routes::faulted;
use crate::{ask, Front};

pub(crate) const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

/// The answer is bytes, not JSON, so this route writes its own head.
pub(crate) async fn image(front: &Arc<Front>, root_id: &str, path: &str) -> Vec<u8> {
    match read_image(front, root_id, path).await {
        Ok((mime, bytes)) => {
            let mut head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\r\n",
                bytes.len()
            )
            .into_bytes();
            head.extend_from_slice(&bytes);
            head
        }
        Err(fault) => faulted(&fault).into_bytes(),
    }
}

async fn read_image(front: &Arc<Front>, root_id: &str, path: &str) -> Result<(String, Vec<u8>), String> {
    /* The store owns what "inside this root" means — `..`, an absolute path and a symlink out are
       all its 403 — and this asks it rather than repeating the rule. */
    let resolved = ask(front, "resolve", json!([root_id, path, false])).await?;
    let absolute = resolved.get(0).and_then(Value::as_str).unwrap_or_default().to_string();
    let file = std::path::PathBuf::from(&absolute);
    let info = std::fs::metadata(&file).map_err(|error| format!("500|{error}"))?;
    if !info.is_file() {
        return Err("415|Image previews require a regular file.".to_string());
    }
    if info.len() > MAX_IMAGE_BYTES {
        return Err("413|Image previews support regular files up to 8 MiB.".to_string());
    }
    let bytes = std::fs::read(&file).map_err(|error| format!("500|{error}"))?;
    /* The size is read, then the file is: a file that grew between the two is a file this answer
       would describe wrongly, and saying so is better than serving half of one. */
    if bytes.len() as u64 != info.len() {
        return Err("409|Image changed during the read. Refresh to retry.".to_string());
    }
    if !sniffed(&bytes) {
        return Err("415|Preview supports PNG, JPEG, GIF and WebP image data.".to_string());
    }
    let Some((mime, width, height)) = dimensions(&bytes) else {
        return Err("415|Image header is invalid or unsupported.".to_string());
    };
    if width == 0 || height == 0 || width > 8192 || height > 8192 || width as u64 * height as u64 > 16_777_216 {
        return Err("413|Image preview exceeds the 8,192-pixel dimension or 16-megapixel limit.".to_string());
    }
    Ok((mime.to_string(), bytes))
}

/// The four signatures this workspace serves, checked before anything parses the file.
fn sniffed(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x89, b'P', b'N', b'G'])
        || bytes.starts_with(&[0xff, 0xd8, 0xff])
        || bytes.starts_with(b"GIF8")
        || (bytes.starts_with(b"RIFF") && bytes.len() >= 12 && &bytes[8..12] == b"WEBP")
}

/// Width and height from the header, the way `image-dimensions` read them. A file whose header
/// cannot be read is refused rather than guessed at.
fn dimensions(bytes: &[u8]) -> Option<(&'static str, u32, u32)> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        /* IHDR is the first chunk and its length is fixed, so the two dimensions are at a known
           offset — but only if the file is long enough to have them. */
        if bytes.len() < 24 || &bytes[12..16] != b"IHDR" {
            return None;
        }
        return Some(("image/png", be32(bytes, 16)?, be32(bytes, 20)?));
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return jpeg(bytes).map(|(width, height)| ("image/jpeg", width, height));
    }
    if bytes.starts_with(b"GIF8") {
        if bytes.len() < 10 {
            return None;
        }
        return Some(("image/gif", le16(bytes, 6)? as u32, le16(bytes, 8)? as u32));
    }
    if bytes.starts_with(b"RIFF") && bytes.len() >= 16 && &bytes[8..12] == b"WEBP" {
        return webp(bytes).map(|(width, height)| ("image/webp", width, height));
    }
    None
}

/// JPEG says its size in a start-of-frame marker, which is somewhere after a run of other segments.
/// Walk the segment chain rather than scanning for bytes that look like one: a marker's value can
/// appear inside entropy-coded data, and a scan finds that first.
fn jpeg(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut at = 2;
    while at + 3 < bytes.len() {
        if bytes[at] != 0xff {
            return None;
        }
        let marker = bytes[at + 1];
        /* Padding and the standalone markers carry no length. */
        if marker == 0xff {
            at += 1;
            continue;
        }
        if (0xd0..=0xd9).contains(&marker) || marker == 0x01 {
            at += 2;
            continue;
        }
        let length = be16(bytes, at + 2)? as usize;
        if length < 2 {
            return None;
        }
        /* SOF0-SOF15, except the four that are not frame headers. */
        if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
            if at + 9 >= bytes.len() {
                return None;
            }
            return Some((be16(bytes, at + 7)? as u32, be16(bytes, at + 5)? as u32));
        }
        at += 2 + length;
    }
    None
}

/// WebP in its three shapes: lossy (VP8), lossless (VP8L) and extended (VP8X).
fn webp(bytes: &[u8]) -> Option<(u32, u32)> {
    let kind = bytes.get(12..16)?;
    match kind {
        b"VP8 " => {
            /* The frame header's start code, then two 14-bit dimensions. */
            let frame = bytes.get(23..30)?;
            if frame[0] != 0x9d || frame[1] != 0x01 || frame[2] != 0x2a {
                return None;
            }
            Some((le16(bytes, 26)? as u32 & 0x3fff, le16(bytes, 28)? as u32 & 0x3fff))
        }
        b"VP8L" => {
            let bits = u32::from_le_bytes(bytes.get(21..25)?.try_into().ok()?);
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        b"VP8X" => {
            let width = u32::from(bytes[24]) | u32::from(bytes[25]) << 8 | u32::from(*bytes.get(26)?) << 16;
            let height = u32::from(*bytes.get(27)?) | u32::from(*bytes.get(28)?) << 8 | u32::from(*bytes.get(29)?) << 16;
            Some((width + 1, height + 1))
        }
        _ => None,
    }
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}
fn be16(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}
fn le16(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    /* A 1x1 PNG, and the same bytes with a size that would ask a pane to draw 8,193 pixels. */
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes
    }

    #[test]
    fn a_header_says_the_size_and_a_truncated_one_says_nothing() {
        assert_eq!(dimensions(&png(1, 1)), Some(("image/png", 1, 1)));
        assert_eq!(dimensions(&png(8192, 8192)), Some(("image/png", 8192, 8192)));
        assert_eq!(dimensions(&png(1, 1)[..12]), None, "a file that stops before IHDR has no size to read");
    }

    #[test]
    fn only_the_four_shapes_this_workspace_serves_are_recognised() {
        assert!(sniffed(&png(1, 1)));
        assert!(sniffed(&[0xff, 0xd8, 0xff, 0xe0]));
        assert!(sniffed(b"GIF89a"));
        assert!(sniffed(b"RIFF\0\0\0\0WEBPVP8 "));
        assert!(!sniffed(b"<svg onload=\"throw 1\"></svg>"), "markup named .png is not an image");
        assert!(!sniffed(b"RIFF\0\0\0\0WAVE"), "a RIFF container that is not WebP is not one either");
    }

    #[test]
    fn a_gif_and_a_webp_say_their_size_where_their_own_formats_put_it() {
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&[0x40, 0x00, 0x20, 0x00]);
        assert_eq!(dimensions(&gif), Some(("image/gif", 64, 32)));
        let mut lossless = b"RIFF\0\0\0\0WEBPVP8L".to_vec();
        lossless.extend_from_slice(&[0, 0, 0, 0, 0x2f]);
        lossless.extend_from_slice(&(((31u32) | (15u32 << 14)) as u32).to_le_bytes());
        assert_eq!(dimensions(&lossless), Some(("image/webp", 32, 16)));
    }
}
