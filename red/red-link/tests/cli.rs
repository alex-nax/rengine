#[test]
fn version_flag_prints_both_versions() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_red-link"))
        .arg("--version")
        .output()
        .expect("red-link binary runs");
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).expect("version output is utf-8");
    // F146: the line opens with the product name from the generated theme module — the rename
    // rehearsal's proof that the binary speaks the declaration rather than a literal.
    assert!(text.starts_with(red_core::theme::PRODUCT_NAME), "got: {text}");
    assert!(text.contains("red-link 0.1.0"), "got: {text}");
    // F140 replaced F139's placeholder: the contract is v1, and the line names the libp2p protocol
    // a peer must match so an operator can read the two versions off one command.
    assert!(text.contains(&format!("red-core contract {}", red_core::contract_version())), "got: {text}");
    assert!(text.contains(red_core::LIBP2P_PROTOCOL), "got: {text}");
}

#[test]
fn unknown_argument_is_refused() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_red-link"))
        .arg("--definitely-not-a-flag")
        .output()
        .expect("red-link binary runs");
    assert_eq!(out.status.code(), Some(2));
}
