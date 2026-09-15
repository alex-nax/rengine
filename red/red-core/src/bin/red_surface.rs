//! Answers a corpus of surface-protocol cases so the JS suite can compare the two implementations
//! (F155/F189, spec 142 decision 1).
//!
//! A binary rather than a Rust test for the same reason `red-contract` is one: the corpus belongs
//! to the JavaScript side, which owns the implementation being replaced. This end answers, that end
//! compares. A port whose refusals differ from the original's is not a port, so the refusals are
//! answers here too — a case that is refused reports `refused` and the message, never an exit code.
//!
//!   red-surface <corpus.json>
//!
//! The corpus is a list of cases, each `{"case": "frame"|"input"|"greeting", ...}`, and the answer
//! is a list in the same order. Frames are answered by their decoded metadata and a digest of the
//! pixels rather than the pixels themselves, because a megabyte of red per case would make the
//! corpus unreadable and prove nothing the digest does not.

use std::process::ExitCode;

use red_core::surface::{frame_header, greeting, input_packet, Channel, Decoder};
use serde_json::{json, Value};

/// A cheap, order-sensitive digest. Not a cryptographic one — its only job is to notice that two
/// implementations produced different bytes, and both sides compute it the same way.
fn digest(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// The bytes a case feeds the decoder: either `chunks` of hex, or a header built from fields and
/// followed by `pixels` bytes of a repeating filler — which is how a corpus asks for a megabyte
/// without carrying one.
fn stream_of(case: &Value) -> Result<Vec<Vec<u8>>, String> {
    if let Some(chunks) = case.get("chunks").and_then(Value::as_array) {
        return chunks
            .iter()
            .map(|chunk| {
                let text = chunk.as_str().ok_or("a chunk is hex")?;
                (0..text.len())
                    .step_by(2)
                    .map(|at| u8::from_str_radix(&text[at..at + 2], 16).map_err(|_| "a chunk is hex".to_string()))
                    .collect::<Result<Vec<u8>, String>>()
            })
            .collect();
    }
    let number = |key: &str| case.get(key).and_then(Value::as_u64).unwrap_or(0) as u32;
    let mut stream = frame_header(number("width"), number("height"), number("sequence")).to_vec();
    /* An override writes one header field AFTER the header is built, which is how a corpus asks for
       a frame whose byte count disagrees with its dimensions. */
    if let Some(overrides) = case.get("header").and_then(Value::as_object) {
        for (index, value) in overrides {
            let at: usize = index.parse().map_err(|_| "a header override is an index".to_string())?;
            let value = value.as_u64().ok_or("a header override is a number")? as u32;
            stream[at * 4..at * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
    }
    let pixels = case.get("pixels").and_then(Value::as_u64).unwrap_or(0) as usize;
    stream.extend((0..pixels).map(|at| (at % 251) as u8));
    /* `split` says how the producer fragmented it: 1 is the byte-at-a-time case a streaming decoder
       exists for, absent is one chunk. */
    let split = case.get("split").and_then(Value::as_u64).unwrap_or(stream.len().max(1) as u64) as usize;
    Ok(stream.chunks(split.max(1)).map(<[u8]>::to_vec).collect())
}

fn answer(case: &Value) -> Value {
    match case.get("case").and_then(Value::as_str).unwrap_or("") {
        "frame" => {
            let chunks = match stream_of(case) {
                Ok(chunks) => chunks,
                Err(message) => return json!({ "refused": message }),
            };
            let mut decoder = Decoder::new();
            let mut frames = Vec::new();
            for chunk in chunks {
                match decoder.push(&chunk) {
                    Ok(done) => frames.extend(done),
                    Err(message) => return json!({ "refused": message }),
                }
            }
            json!({
                "frames": frames
                    .iter()
                    .map(|frame| json!({
                        "width": frame.width,
                        "height": frame.height,
                        "sequence": frame.sequence,
                        "bytes": frame.pixels.len(),
                        "digest": digest(&frame.pixels),
                    }))
                    .collect::<Vec<_>>(),
            })
        }
        "input" => {
            let kind = case.get("kind").and_then(Value::as_i64).unwrap_or(i64::MIN);
            let values: Vec<i32> = case
                .get("values")
                .and_then(Value::as_array)
                .map(|items| items.iter().map(|item| item.as_i64().unwrap_or(i64::MIN) as i32).collect())
                .unwrap_or_default();
            /* The JavaScript refuses in TWO stages and they carry different messages: the kind and
               the arity are "Unsupported game input.", and anything wrong with a VALUE — including
               a value that is not a whole number — is "Game input is out of range.". The corpus
               caught this end reporting the first message for the second case, which is the whole
               reason the refusals are compared and not just the acceptances. */
            if kind < i32::MIN as i64 || kind > i32::MAX as i64 {
                return json!({ "refused": "Unsupported game input." });
            }
            let fractional = case
                .get("values")
                .and_then(Value::as_array)
                .is_some_and(|items| items.iter().any(|item| item.as_i64().is_none()));
            if fractional {
                /* Only once the kind and the arity have passed, exactly as the JavaScript orders
                   it: a bad value on an unknown kind is still "Unsupported". */
                let known = input_packet(kind as i32, &vec![0; values.len()]);
                return match known {
                    Err(message) if message == "Unsupported game input." => json!({ "refused": message }),
                    _ => json!({ "refused": "Game input is out of range." }),
                };
            }
            match input_packet(kind as i32, &values) {
                Ok(packet) => json!({ "packet": packet.iter().map(|byte| format!("{byte:02x}")).collect::<String>() }),
                Err(message) => json!({ "refused": message }),
            }
        }
        "greeting" => match greeting(case.get("line").and_then(Value::as_str).unwrap_or("")) {
            Some((Channel::Frames, token)) => json!({ "channel": "frames", "token": token }),
            Some((Channel::Input, token)) => json!({ "channel": "input", "token": token }),
            None => json!({ "refused": "not a greeting" }),
        },
        other => json!({ "refused": format!("unknown case {other}") }),
    }
}

fn main() -> ExitCode {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: red-surface <corpus.json>");
        return ExitCode::from(2);
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) => {
            eprintln!("red-surface: cannot read {path}: {error}");
            return ExitCode::from(2);
        }
    };
    let cases: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("red-surface: {path} is not JSON: {error}");
            return ExitCode::from(2);
        }
    };
    let Some(cases) = cases.as_array() else {
        eprintln!("red-surface: the corpus is a list of cases");
        return ExitCode::from(2);
    };
    let answers: Vec<Value> = cases.iter().map(answer).collect();
    println!("{}", serde_json::to_string(&answers).expect("answers serialize"));
    ExitCode::SUCCESS
}
