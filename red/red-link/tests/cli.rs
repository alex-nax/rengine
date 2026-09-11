#[test]
fn version_flag_prints_both_versions() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_red-link"))
        .arg("--version")
        .output()
        .expect("red-link binary runs");
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).expect("version output is utf-8");
    assert!(text.contains("red-link 0.1.0"), "got: {text}");
    assert!(text.contains("red-core contract 0.1.0"), "got: {text}");
}

#[test]
fn unknown_argument_is_refused() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_red-link"))
        .arg("--definitely-not-a-flag")
        .output()
        .expect("red-link binary runs");
    assert_eq!(out.status.code(), Some(2));
}
