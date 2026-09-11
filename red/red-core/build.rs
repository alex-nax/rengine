//! Generates the prost types from the contract. protoc does the parsing; see third_party/README.md
//! for why it is a prerequisite the build checks for rather than a binary this repository ships.
fn main() {
    println!("cargo:rerun-if-changed=proto/red/v1/red.proto");
    prost_build::compile_protos(&["proto/red/v1/red.proto"], &["proto"])
        .expect("the red contract compiles; is protoc installed? init.sh checks for it");
}
