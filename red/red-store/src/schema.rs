//! The bounded JSON Schema 2020-12 subset of orchestrator/server/schema.mjs, ported with
//! identical error strings, order included (F169, F147a, spec 129, KI-091).
//!
//! Order matters twice: `required` errors follow the schema's order, property errors follow the
//! ITEM's key order — preserve_order JSON keeps both. Patterns are JS RegExp with the u flag;
//! the committed contracts use negative lookahead (`\$(?!\{)`), which the regex crate refuses
//! by design, so this uses fancy-regex. Where JS and fancy-regex could disagree (lookbehind,
//! backreferences, unicode properties), no contract pattern goes today; the corpus judges.

use serde_json::Value;

fn type_of(item: &Value) -> &'static str {
    match item {
        Value::Array(_) => "array",
        Value::Null => "null",
        Value::Number(number) => {
            if is_integer(number) { "integer" } else { "number" }
        }
        Value::Bool(_) => "boolean",
        Value::String(_) => "string",
        Value::Object(_) => "object",
    }
}

fn is_integer(number: &serde_json::Number) -> bool {
    number.is_i64() || number.is_u64() || number.as_f64().is_some_and(|value| value.is_finite() && value.fract() == 0.0)
}

fn matches_type(expected: &str, item: &Value) -> bool {
    match expected {
        "number" => item.is_number(),
        "integer" => item.as_number().is_some_and(is_integer),
        other => type_of(item) == other,
    }
}

fn compact(value: &Value) -> String {
    serde_json::to_string(value).expect("values serialize")
}

pub fn validate_schema(schema: &Value, value: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    check(schema, value, schema, "$", &mut errors);
    errors
}

fn check(node: &Value, item: &Value, root: &Value, at: &str, errors: &mut Vec<String>) {
    if let Some(reference) = node.get("$ref").and_then(Value::as_str) {
        if !reference.starts_with("#/") {
            panic!("Unsupported $ref {reference}");
        }
        let target = reference[2..].split('/').fold(Some(root), |current, key| current.and_then(|value| value.get(key)));
        check(target.unwrap_or(&Value::Null), item, root, at, errors);
    }
    if let Some(branches) = node.get("allOf").and_then(Value::as_array) {
        for branch in branches {
            check(branch, item, root, at, errors);
        }
    }
    if let Some(kind) = node.get("type") {
        let types: Vec<&str> = match kind {
            Value::String(one) => vec![one.as_str()],
            Value::Array(many) => many.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        if !types.iter().any(|expected| matches_type(expected, item)) {
            errors.push(format!("{at} must be {}", types.join(" or ")));
            return;
        }
    }
    if let Some(constant) = node.get("const") {
        if compact(item) != compact(constant) {
            errors.push(format!("{at} must equal {}", compact(constant)));
        }
    }
    if let Some(options) = node.get("enum").and_then(Value::as_array) {
        if !options.iter().any(|option| compact(option) == compact(item)) {
            errors.push(format!("{at} must be one of {}", options.iter().map(compact).collect::<Vec<_>>().join(", ")));
        }
    }
    if let Value::String(text) = item {
        if let Some(min) = node.get("minLength").and_then(Value::as_u64) {
            if (text.encode_utf16().count() as u64) < min {
                errors.push(format!("{at} is shorter than {min}"));
            }
        }
        if let Some(max) = node.get("maxLength").and_then(Value::as_u64) {
            if (text.encode_utf16().count() as u64) > max {
                errors.push(format!("{at} is longer than {max}"));
            }
        }
        if let Some(pattern) = node.get("pattern").and_then(Value::as_str) {
            let matched = fancy_regex::Regex::new(pattern)
                .map_err(|error| error.to_string())
                .and_then(|regex| regex.is_match(text).map_err(|error| error.to_string()));
            match matched {
                Ok(true) => {}
                Ok(false) => errors.push(format!("{at} does not match {pattern}")),
                Err(error) => panic!("invalid pattern {pattern}: {error}"),
            }
        }
    }
    if let Value::Number(number) = item {
        if let Some(min) = node.get("minimum").and_then(Value::as_f64) {
            if number.as_f64().is_some_and(|value| value < min) {
                errors.push(format!("{at} is below {min}"));
            }
        }
        if let Some(max) = node.get("maximum").and_then(Value::as_f64) {
            if number.as_f64().is_some_and(|value| value > max) {
                errors.push(format!("{at} is above {max}"));
            }
        }
    }
    if let Value::Array(items) = item {
        if let Some(min) = node.get("minItems").and_then(Value::as_u64) {
            if (items.len() as u64) < min {
                errors.push(format!("{at} needs at least {min} items"));
            }
        }
        if let Some(max) = node.get("maxItems").and_then(Value::as_u64) {
            if (items.len() as u64) > max {
                errors.push(format!("{at} allows at most {max} items"));
            }
        }
        if node.get("uniqueItems") == Some(&Value::Bool(true)) {
            let mut seen = std::collections::HashSet::new();
            let mut repeated = false;
            for element in items {
                if !seen.insert(compact(element)) {
                    repeated = true;
                }
            }
            if repeated {
                errors.push(format!("{at} repeats an item"));
            }
        }
        for (index, element) in items.iter().enumerate() {
            let sub = node
                .get("prefixItems")
                .and_then(Value::as_array)
                .and_then(|prefix| prefix.get(index))
                .or_else(|| node.get("items"));
            if let Some(sub) = sub {
                check(sub, element, root, &format!("{at}[{index}]"), errors);
            }
        }
    }
    if let Value::Object(map) = item {
        if let Some(required) = node.get("required").and_then(Value::as_array) {
            for key in required {
                let key = key.as_str().unwrap_or("");
                if !map.contains_key(key) {
                    errors.push(format!("{at} requires {key}"));
                }
            }
        }
        for (key, element) in map {
            let known = node
                .get("properties")
                .and_then(Value::as_object)
                .and_then(|properties| properties.get(key));
            if let Some(sub) = known {
                check(sub, element, root, &format!("{at}.{key}"), errors);
                continue;
            }
            match node.get("additionalProperties") {
                Some(Value::Bool(false)) => errors.push(format!("{at} has unknown key {key}")),
                Some(sub @ Value::Object(_)) => check(sub, element, root, &format!("{at}.{key}"), errors),
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_error_kind_in_order() {
        assert_eq!(validate_schema(&json!({"type": "string"}), &json!(42)), ["$ must be string"]);
        assert_eq!(validate_schema(&json!({"type": ["string", "null"]}), &json!(42)), ["$ must be string or null"]);
        assert_eq!(validate_schema(&json!({"type": "integer"}), &json!(1.5)), ["$ must be integer"]);
        assert_eq!(validate_schema(&json!({"minLength": 3}), &json!("ab")), ["$ is shorter than 3"]);
        assert_eq!(validate_schema(&json!({"pattern": "^[a-z]+$"}), &json!("ABC")), ["$ does not match ^[a-z]+$"]);
        assert_eq!(validate_schema(&json!({"pattern": "^(?:[^$]|\\$(?!\\{))*$"}), &json!("a ${b}")), ["$ does not match ^(?:[^$]|\\$(?!\\{))*$"]);
        assert_eq!(validate_schema(&json!({"uniqueItems": true}), &json!([{"a": 1}, {"a": 1}])), ["$ repeats an item"]);
        assert_eq!(
            validate_schema(&json!({"properties": {"z": {"type": "integer"}, "a": {"type": "integer"}}, "required": ["m1", "m2"]}), &json!({"z": "no", "a": "no"})),
            ["$ requires m1", "$ requires m2", "$.z must be integer", "$.a must be integer"]
        );
        assert_eq!(
            validate_schema(&json!({"prefixItems": [{"type": "string"}], "items": {"type": "integer"}}), &json!(["ok", 1, "no"])),
            ["$[2] must be integer"]
        );
        assert_eq!(validate_schema(&json!({"$ref": "#/definitions/thing", "definitions": {"thing": {"type": "integer"}}}), &json!("x")), ["$ must be integer"]);
        assert_eq!(validate_schema(&json!({"const": {"a": 1}}), &json!({"a": 2})), ["$ must equal {\"a\":1}"]);
        assert_eq!(validate_schema(&json!({"enum": ["a", 2, null]}), &json!("b")), ["$ must be one of \"a\", 2, null"]);
    }
}
