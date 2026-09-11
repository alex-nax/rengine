//! red-core: the protocol contract and shared primitives of the Rust orchestrator
//! (charter D57, spec 128).
//!
//! F140 lands the contract itself: the `.proto` the façade and the companion speak, the prost types
//! generated from it, the strict translation from the session host's JSON, and the one version the
//! proto package and the libp2p protocol name are both built from.

pub mod translate;
pub mod version;

pub use translate::pb;
pub use version::{negotiate, LIBP2P_PROTOCOL, PROTOCOL_VERSION, PROTO_PACKAGE};

/// The contract version red-link and its clients speak, as a semver string.
///
/// Kept for the F139 callers that already print it; [`PROTOCOL_VERSION`] is what the wire uses.
pub const CONTRACT_VERSION: &str = "1.0.0";

pub fn contract_version() -> &'static str {
    CONTRACT_VERSION
}

#[cfg(test)]
mod tests {
    #[test]
    fn contract_version_is_semver_shaped() {
        let parts: Vec<&str> = super::contract_version().split('.').collect();
        assert_eq!(parts.len(), 3, "CONTRACT_VERSION is major.minor.patch");
        assert!(parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())));
    }

    /// The spoken version and the wire version are the same number, so a release note and a
    /// negotiation failure cannot disagree.
    #[test]
    fn the_spoken_version_matches_the_wire_version() {
        let major = super::contract_version().split('.').next().unwrap();
        assert_eq!(major, super::PROTOCOL_VERSION.to_string());
    }
}
