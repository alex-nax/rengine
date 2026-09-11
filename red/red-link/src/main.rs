//! red-link: the libp2p façade/relay of the Rust orchestrator (charter D57, spec 128).
//! F140 gives it the contract to speak: the version line now names the libp2p protocol a peer has
//! to match, which is the string negotiation compares (decision 5). The façade over the session
//! host arrives in F141, pairing in F142, the relay in F143.

fn version_line() -> String {
    format!(
        "red-link {} (red-core contract {}, libp2p protocol {})",
        env!("CARGO_PKG_VERSION"),
        red_core::contract_version(),
        red_core::LIBP2P_PROTOCOL
    )
}

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("--version") | None => println!("{}", version_line()),
        Some(other) => {
            eprintln!("red-link: unknown argument {other}");
            std::process::exit(2);
        }
    }
}
