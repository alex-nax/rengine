//! The one clock shape the workspace writes down: `new Date(ms).toISOString()`, and its inverse.
//!
//! Every stamp the token ledger, the feed ring and the store persist is this string, and the
//! ledger COMPARES them — a deadline that passed, a cooldown that has not — so the parse is as
//! load-bearing as the format. Both are here rather than beside one caller because a second copy
//! of a civil-calendar algorithm is a second chance to disagree about a leap year.

/// Milliseconds since the epoch as ISO-8601 with milliseconds, exactly as `toISOString` writes it.
pub fn iso(millis: i64) -> String {
    let (seconds, sub) = (millis.div_euclid(1000), millis.rem_euclid(1000));
    let days = seconds.div_euclid(86_400);
    let time = seconds.rem_euclid(86_400);
    // Civil-from-days (Howard Hinnant's algorithm), so no date crate is needed for one field.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{sub:03}Z", time / 3600, (time % 3600) / 60, time % 60)
}

/// The inverse, for the shape [`iso`] writes and nothing else.
///
/// `Date.parse` accepts a great deal more; every stamp this reads was written by [`iso`], and a
/// stamp that is not one is `None` — which is the same branch `Number.isFinite(NaN)` takes on the
/// JavaScript side, so an unreadable deadline never resolves and an unreadable cooldown is dropped
/// rather than silently trusted.
pub fn parse(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() != 24 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' || bytes[13] != b':' || bytes[16] != b':' || bytes[19] != b'.' || bytes[23] != b'Z' {
        return None;
    }
    let number = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let (y, m, d) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second, sub) = (number(11, 13)?, number(14, 16)?, number(17, 19)?, number(20, 23)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    // Days-from-civil, the inverse of the above.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400) + hour * 3600 + minute * 60 + second) * 1000 + sub)
}

/// `Math.round`, which is not Rust's: JavaScript rounds a half *up* — towards positive infinity —
/// where `f64::round` rounds half away from zero. The difference is one second in every elapsed
/// time that lands on a half, and it is the printed half of a refusal.
pub fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `Math.max(0, Math.round(ms / 1000))` on an integer count of milliseconds.
pub fn seconds_from(millis: i64) -> i64 {
    js_round(millis as f64 / 1000.0).max(0.0) as i64
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_stamp_survives_the_round_trip() {
        for millis in [0i64, 1, 1_757_851_200_000, 1_789_387_200_123, -1_000] {
            let text = super::iso(millis);
            assert_eq!(super::parse(&text), Some(millis), "{text}");
        }
    }

    #[test]
    fn the_shape_the_ledger_writes_is_the_shape_it_reads() {
        assert_eq!(super::iso(1_789_387_200_000), "2026-09-14T12:00:00.000Z");
        assert_eq!(super::parse("2026-09-14T12:00:00.000Z"), Some(1_789_387_200_000));
    }

    /// Anything else is `None` rather than a guess, because a guessed deadline transfers a token.
    #[test]
    fn a_stamp_that_is_not_this_shape_is_refused() {
        for text in ["", "2026-09-14", "2026-09-14T12:00:00Z", "2026-09-14T12:00:00.000+00:00", "not a date at all!!!!!!!"] {
            assert_eq!(super::parse(text), None, "{text}");
        }
    }

    /// The half that rounds the other way in Rust.
    #[test]
    fn a_half_rounds_the_way_javascript_rounds_it() {
        assert_eq!(super::js_round(-1.5), -1.0);
        assert_eq!(super::js_round(1.5), 2.0);
        assert_eq!(super::js_round(2.5), 3.0);
    }
}
