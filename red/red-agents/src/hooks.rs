//! The codex hook trust math (F171, spec 129, KI-093): codex runs a non-managed hook only when
//! `hooks.state."<key>".trusted_hash` equals the sha256 of its normalized identity, keyed to the
//! synthetic session-flags layer `-c` overrides live in. Ported from config.mjs's
//! codexHookKey/codexHookTrustHash; the formula was verified against codex 0.153.4
//! (docs/evidence/codex-sessionstart-hook-2026-09-11.md).
//!
//! Canonical JSON means keys sorted recursively, compact separators, UTF-8 — which a
//! serde_json::Value gives for free (its Map is a BTreeMap), so the hash input is byte-identical
//! to the JS side's JSON.stringify of its canonically rebuilt object.

use serde_json::json;
use sha2::{Digest, Sha256};

/// `<key_source>:session_start:<group>:<handler>` — the key source for `-c` overrides is codex's
/// synthetic session-flags layer path, spelled per platform (`config_toml_source_path`).
pub fn hook_key(platform: &str, group: u32, handler: u32) -> String {
    let source = if platform == "win32" {
        r"C:\<session-flags>\config.toml"
    } else {
        "/<session-flags>/config.toml"
    };
    format!("{source}:session_start:{group}:{handler}")
}

/// `sha256:<hex>` over the compact canonical JSON of the hook's normalized identity. Unset
/// fields stay omitted, exactly as codex's `version_for_toml` produces them: event_name,
/// matcher, and the one command hook with codex's own defaults filled (timeout 600, async
/// false).
pub fn hook_trust_hash(command: &str, matcher: &str) -> String {
    let identity = json!({
        "event_name": "session_start",
        "matcher": matcher,
        "hooks": [{ "type": "command", "command": command, "timeout": 600, "async": false }],
    });
    let canonical = serde_json::to_string(&identity).expect("the identity serializes");
    let digest = Sha256::digest(canonical.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    format!("sha256:{hex}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_names_the_session_flags_layer() {
        assert_eq!(hook_key("linux", 0, 0), "/<session-flags>/config.toml:session_start:0:0");
        assert_eq!(hook_key("darwin", 1, 2), "/<session-flags>/config.toml:session_start:1:2");
        assert_eq!(hook_key("win32", 0, 0), r"C:\<session-flags>\config.toml:session_start:0:0");
    }

    #[test]
    fn the_hash_matches_the_recorded_formula() {
        // Computed by the JS codexHookTrustHash on this fixed command (the 2026-09-11 evidence
        // recorded a live hash with machine paths embedded; the formula is what is pinned here).
        let command = "/usr/local/bin/node /repo/orchestrator/agents/report-session.mjs --provider codex --context /state/context.json";
        assert_eq!(hook_trust_hash(command, "startup|resume"),
            "sha256:12f31cc1e970b72812fdbf48aad7d942ae48cbdf1293a490f430831b16651e2a");
        assert_eq!(hook_trust_hash(command, "startup"),
            "sha256:8626ba99e1506308944b1ebc1f2dfcbcbb97057a8ff478807fba46080a38ed60");
        assert_ne!(hook_trust_hash(&format!("{command} --tampered"), "startup|resume"),
            hook_trust_hash(command, "startup|resume"));
    }
}
