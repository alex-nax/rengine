//! The game surface wire format (F155/F189, spec 142): frames one way, input the other.
//!
//! This is `server/surface-protocol.mjs` in Rust, and it is deliberately the first piece of the
//! surface to move: it is pure, everything else is built on it, and a divergence here is one a
//! person meets as a corrupt picture rather than as an error.
//!
//! It lives in the contract crate rather than in the door because it IS a protocol — the door
//! decodes these frames, `red-surface` judges them against the JavaScript on a corpus, and the
//! companion (charter D58) streams the same header over the same wire.
//!
//! **A frame** is a 24-byte little-endian header — magic, width, height, sequence, byte count,
//! flags — followed by exactly `width * height * 4` bytes of pixels. The decoder is a streaming
//! one because the producer is a socket: a header can arrive a byte at a time, and a frame can be
//! split anywhere.
//!
//! **The refusals are part of the format.** Each bound below is one the JavaScript makes, and a
//! decoder that accepts more than the one it replaces is not a port — it is a wider door on the
//! same hinge. The producer is a game process, which is exactly the thing that crashes mid-write.
//!
//! **An input packet** is 32 bytes: the kind, then seven little-endian `i32` slots of which each
//! kind uses the first few. The per-kind ranges are the contract with the native side, so a value
//! outside one is refused here rather than delivered and interpreted as something else.

const MAGIC: u32 = 0x3146_4752;
/// The header, and the largest frame the format admits. Both are the JavaScript's.
const HEADER: usize = 24;
const MAX_WIDTH: u32 = 1920;
const MAX_HEIGHT: u32 = 1080;

/// One decoded frame: the metadata its header carried and the pixels that followed.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub sequence: u32,
    pub pixels: Vec<u8>,
}

/// The 24 bytes that introduce a frame — what a producer writes, and what the door writes again
/// when it hands the latest frame to a viewer that has just attached.
pub fn frame_header(width: u32, height: u32, sequence: u32) -> [u8; HEADER] {
    let mut header = [0u8; HEADER];
    for (index, value) in [MAGIC, width, height, sequence, width * height * 4, 0].into_iter().enumerate() {
        header[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
    }
    header
}

/// Reading frames off a stream that owes us nothing about where it splits them.
///
/// The state is the same two-phase one the JavaScript keeps: fill a 24-byte target, judge it, then
/// fill a target the size the header declared. `metadata` being `Some` is what says which phase
/// this is, so a decoder cannot be asked what it is halfway through.
pub struct Decoder {
    target: Vec<u8>,
    offset: usize,
    metadata: Option<(u32, u32, u32)>,
}

impl Default for Decoder {
    fn default() -> Self {
        Decoder { target: vec![0u8; HEADER], offset: 0, metadata: None }
    }
}

impl Decoder {
    pub fn new() -> Decoder {
        Decoder::default()
    }

    /// Push whatever arrived. Returns the frames it completed, or the refusal that ends this
    /// producer — a stream that has sent one bad header has lost its place in the stream, and the
    /// JavaScript destroys the socket for exactly that reason.
    pub fn push(&mut self, mut chunk: &[u8]) -> Result<Vec<Frame>, String> {
        let mut frames = Vec::new();
        while !chunk.is_empty() {
            let count = chunk.len().min(self.target.len() - self.offset);
            self.target[self.offset..self.offset + count].copy_from_slice(&chunk[..count]);
            self.offset += count;
            chunk = &chunk[count..];
            if self.offset != self.target.len() {
                continue;
            }
            match self.metadata {
                None => {
                    let at = |index: usize| {
                        u32::from_le_bytes(self.target[index * 4..index * 4 + 4].try_into().expect("four bytes"))
                    };
                    let (magic, width, height, sequence, bytes, flags) = (at(0), at(1), at(2), at(3), at(4), at(5));
                    /* Every one of these is a refusal the JavaScript makes, and `bytes` is checked
                       against the dimensions rather than trusted: it is the allocation this is
                       about to make on a remote process's say-so. */
                    if magic != MAGIC
                        || !(1..=MAX_WIDTH).contains(&width)
                        || !(1..=MAX_HEIGHT).contains(&height)
                        || bytes != width * height * 4
                        || flags != 0
                    {
                        return Err("Invalid game frame header.".to_string());
                    }
                    self.metadata = Some((width, height, sequence));
                    self.target = vec![0u8; bytes as usize];
                }
                Some((width, height, sequence)) => {
                    frames.push(Frame { width, height, sequence, pixels: std::mem::take(&mut self.target) });
                    self.metadata = None;
                    self.target = vec![0u8; HEADER];
                }
            }
            self.offset = 0;
        }
        Ok(frames)
    }
}

/// What each input kind carries, and the range each slot admits. The shape IS the contract with
/// the native side: a kind this does not know is refused rather than passed through, because the
/// far end reads the bytes positionally and would interpret an unknown kind as something.
fn ranges(kind: i32) -> Option<&'static [(i32, i32)]> {
    Some(match kind {
        1 => &[(0, 511), (0, 1), (0, 1)],
        2 => &[(-32768, 32767), (-32768, 32767), (-32768, 32767), (-32768, 32767)],
        3 => &[(1, 5), (0, 1), (-32768, 32767), (-32768, 32767)],
        4 => &[(-1000, 1000), (-1000, 1000)],
        5 => &[(0, 1)],
        6 => &[],
        _ => return None,
    })
}

/// The 32 bytes one input event becomes. `values` may be SHORT — an omitted slot is zero, which is
/// how the JavaScript reads a missing entry — but never long, because a caller passing more than
/// the kind admits has misunderstood which kind it is sending.
pub fn input_packet(kind: i32, values: &[i32]) -> Result<[u8; 32], String> {
    let Some(rule) = ranges(kind) else { return Err("Unsupported game input.".to_string()) };
    if values.len() > rule.len() {
        return Err("Unsupported game input.".to_string());
    }
    let mut packet = [0u8; 32];
    packet[0..4].copy_from_slice(&kind.to_le_bytes());
    for (index, (low, high)) in rule.iter().enumerate() {
        let value = values.get(index).copied().unwrap_or(0);
        if value < *low || value > *high {
            return Err("Game input is out of range.".to_string());
        }
        packet[(index + 1) * 4..(index + 2) * 4].copy_from_slice(&value.to_le_bytes());
    }
    Ok(packet)
}

/// `RENGINE/1 FRAME <64 hex>` or `RENGINE/1 INPUT <64 hex>`: the one line a producer sends before
/// anything else, naming which channel it is and which reserved surface it belongs to.
///
/// Parsed here rather than at the socket because it is part of the format, and because the length
/// bound matters: the JavaScript destroys a connection whose greeting passes 100 bytes without a
/// newline, so a producer cannot make the door hold an unbounded buffer by never finishing a line.
pub const GREETING_LIMIT: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Frames,
    Input,
}

pub fn greeting(line: &str) -> Option<(Channel, String)> {
    let rest = line.strip_prefix("RENGINE/1 ")?;
    let (word, token) = rest.split_once(' ')?;
    let channel = match word {
        "FRAME" => Channel::Frames,
        "INPUT" => Channel::Input,
        _ => return None,
    };
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) {
        return None;
    }
    Some((channel, token.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /* The suite this replaces drove the decoder a BYTE at a time, because that is the case a
       streaming decoder exists for and the one a producer will actually produce. */
    #[test]
    fn a_frame_arrives_a_byte_at_a_time_and_two_frames_come_out() {
        let pixels = [255u8, 0, 0, 255, 0, 255, 0, 255];
        let mut stream = Vec::new();
        stream.extend_from_slice(&frame_header(2, 1, 7));
        stream.extend_from_slice(&pixels);
        stream.extend_from_slice(&frame_header(1, 1, 8));
        stream.extend_from_slice(&pixels[..4]);

        let mut decoder = Decoder::new();
        let mut frames = Vec::new();
        for byte in stream {
            frames.extend(decoder.push(&[byte]).expect("a valid stream"));
        }
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].sequence, 7);
        assert_eq!(frames[0].pixels, pixels);
        assert_eq!(frames[1].pixels.len(), 4);
    }

    /* Each mutation is one field of the header, and each is a refusal on its own: a decoder that
       accepts any of them accepts more than the one it replaces. */
    #[test]
    fn every_bound_in_the_header_is_its_own_refusal() {
        for (what, index, value) in [
            ("magic", 0usize, 0u32),
            ("width", 1, 50000),
            ("height", 2, 0),
            ("byte count", 4, 0xffff_ffff),
            ("flags", 5, 1),
        ] {
            let mut header = frame_header(2, 1, 1);
            header[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
            let refused = Decoder::new().push(&header);
            assert!(refused.is_err(), "{what} = {value} should be refused");
        }
        /* And the one that is not a field: a byte count that disagrees with the dimensions. */
        let mut header = frame_header(2, 1, 1);
        header[16..20].copy_from_slice(&4u32.to_le_bytes());
        assert!(Decoder::new().push(&header).is_err(), "a byte count the dimensions do not give is refused");
    }

    #[test]
    fn an_input_packet_is_thirty_two_bytes_with_its_values_in_place() {
        let packet = input_packet(1, &[26, 1, 0]).expect("a key event");
        assert_eq!(packet.len(), 32);
        assert_eq!(i32::from_le_bytes(packet[4..8].try_into().unwrap()), 26);
        /* A short list is zero-filled, which is how a caller sends a kind's leading values only. */
        let short = input_packet(1, &[26]).expect("a key event with defaults");
        assert_eq!(i32::from_le_bytes(short[8..12].try_into().unwrap()), 0);
    }

    #[test]
    fn an_input_this_does_not_know_is_refused_rather_than_delivered() {
        assert!(input_packet(99, &[]).is_err(), "an unknown kind");
        assert!(input_packet(1, &[99999, 1]).is_err(), "a value past its range");
        assert!(input_packet(1, &[4, 7]).is_err(), "a value past a LATER slot's range");
        assert!(input_packet(3, &[50, 1, 0, 0]).is_err(), "a button this does not have");
        assert!(input_packet(5, &[0, 0]).is_err(), "more values than the kind admits");
    }

    #[test]
    fn a_greeting_names_one_channel_and_one_reserved_surface() {
        let token = "a".repeat(64);
        assert_eq!(greeting(&format!("RENGINE/1 FRAME {token}")), Some((Channel::Frames, token.clone())));
        assert_eq!(greeting(&format!("RENGINE/1 INPUT {token}")), Some((Channel::Input, token.clone())));
        for bad in [
            format!("RENGINE/1 VIDEO {token}"),
            format!("RENGINE/2 FRAME {token}"),
            format!("RENGINE/1 FRAME {}", "a".repeat(63)),
            format!("RENGINE/1 FRAME {}", "A".repeat(64)),
            format!("RENGINE/1 FRAME {}", "g".repeat(64)),
        ] {
            assert!(greeting(&bad).is_none(), "{bad} is not a greeting");
        }
    }
}
