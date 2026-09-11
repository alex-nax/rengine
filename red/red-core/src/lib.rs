//! red-core: the protocol contract and shared primitives of the Rust orchestrator
//! (charter D57, spec 128). F139 ships the skeleton: the version constant the façade and its
//! clients will negotiate on, plus a smoke test proving the pinned toolchain builds and tests.

/// The contract version red-link and its clients speak. F140 replaces this placeholder with the
/// protobuf contract, whose proto package and libp2p protocol name carry the same version
/// (spec 128, decision 5).
pub const CONTRACT_VERSION: &str = "0.1.0";

pub fn contract_version() -> &'static str {
    CONTRACT_VERSION
}

#[cfg(test)]
mod tests {
    #[test]
    fn contract_version_is_semver_shaped() {
        let parts: Vec<&str> = super::contract_version().split('.').collect();
        assert_eq!(parts.len(), 3, "CONTRACT_VERSION is major.minor.patch");
        assert!(parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())));
    }
}
