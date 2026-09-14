use serde_json::Value;

#[test]
fn native_split_ratios_survive_json_decoding_exactly() {
    for native in [0.23_f32, 0.65_f32, 0.1_f32, 0.9_f32] {
        let expected = f64::from(native);
        let wire = format!("{{\"ratio\":{expected:?}}}");
        let value: Value = serde_json::from_str(&wire).unwrap();
        assert_eq!(value["ratio"].as_f64().unwrap().to_bits(), expected.to_bits(),
            "JSON decoding changed the native split ratio in {wire}");
        let encoded = serde_json::to_string(&value).unwrap();
        let decoded: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded["ratio"].as_f64().unwrap().to_bits(), expected.to_bits(),
            "another JSON hop changed the native split ratio");
    }
}
