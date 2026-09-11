//! One version, three places it has to appear (spec 128, decision 5).
//!
//! The proto package is `red.v1`, the libp2p protocol name is `/red/1`, and a peer that speaks
//! neither is refused. Those three could drift apart in three different files, so they are all
//! built from [`PROTOCOL_VERSION`] and a test reads the `.proto` on disk to prove its `package`
//! line agrees. A contract whose version is a comment is a contract nobody can check.

/// The version the whole contract carries. Bumping it is a deliberate, breaking act: the proto
/// package changes, the libp2p protocol name changes, and every older peer is refused by name.
pub const PROTOCOL_VERSION: u32 = 1;

/// The protobuf package, which is also the prefix of every generated Rust type's module path.
pub const PROTO_PACKAGE: &str = "red.v1";

/// The libp2p protocol name negotiated on every stream. libp2p matches these by exact string, so
/// a version bump makes an old peer fail negotiation rather than speak a contract it misreads.
pub const LIBP2P_PROTOCOL: &str = "/red/1";

/// Why a peer was refused, with both versions named — the companion shows this to a person, so it
/// says what it met and what it wanted rather than "handshake failed".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionMismatch {
    pub theirs: String,
    pub ours: &'static str,
    pub our_version: u32,
}

impl std::fmt::Display for VersionMismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "peer speaks {} but this build speaks {} (red contract v{}); upgrade the older side",
            if self.theirs.is_empty() { "no protocol" } else { &self.theirs },
            self.ours,
            self.our_version
        )
    }
}

impl std::error::Error for VersionMismatch {}

/// Accept a peer only when it names exactly our protocol.
pub fn negotiate(theirs: &str) -> Result<(), VersionMismatch> {
    if theirs == LIBP2P_PROTOCOL {
        return Ok(());
    }
    Err(VersionMismatch { theirs: theirs.to_string(), ours: LIBP2P_PROTOCOL, our_version: PROTOCOL_VERSION })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_three_spellings_carry_the_same_version() {
        assert_eq!(PROTO_PACKAGE, format!("red.v{PROTOCOL_VERSION}"));
        assert_eq!(LIBP2P_PROTOCOL, format!("/red/{PROTOCOL_VERSION}"));
    }

    /// The one that catches a real edit: the `.proto` on disk is what protoc compiled, and a
    /// package line changed there without touching this file would leave the constants lying.
    #[test]
    fn the_proto_file_declares_that_package() {
        let proto = include_str!("../proto/red/v1/red.proto");
        let declared = proto
            .lines()
            .find_map(|line| line.trim().strip_prefix("package ")?.strip_suffix(';'))
            .expect("the contract declares a package");
        assert_eq!(declared, PROTO_PACKAGE, "the .proto package and PROTO_PACKAGE must agree");
    }

    #[test]
    fn a_mismatched_peer_is_refused_with_the_version_named() {
        assert!(negotiate(LIBP2P_PROTOCOL).is_ok());
        let refused = negotiate("/red/2").expect_err("a different version is refused");
        let said = refused.to_string();
        assert!(said.contains("/red/2"), "it names what the peer speaks: {said}");
        assert!(said.contains(LIBP2P_PROTOCOL), "and what we speak: {said}");
        assert!(said.contains("v1"), "and the contract version: {said}");
        assert!(negotiate("").is_err(), "a peer naming no protocol is refused too");
    }
}
