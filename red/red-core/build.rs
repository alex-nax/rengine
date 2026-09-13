//! Generates the prost types from the contract. protoc does the parsing; see third_party/README.md
//! for why it is a prerequisite the build checks for rather than a binary this repository ships.
fn main() {
    println!("cargo:rerun-if-changed=proto/red/v1/red.proto");
    /* Serialize on every generated type, so a client can print what it received without a
       hand-written mirror of the contract beside the contract. Deserialize is deliberately not
       derived: JSON is never an input to this contract — the host's JSON arrives through
       `translate`, which refuses what it cannot carry, and letting a message be built from JSON
       would be a second, unchecked way in. */
    prost_build::Config::new()
        .type_attribute(".", "#[derive(serde::Serialize)]")
        .compile_protos(&["proto/red/v1/red.proto"], &["proto"])
        .expect("the red contract compiles; is protoc installed? init.sh checks for it");
}
