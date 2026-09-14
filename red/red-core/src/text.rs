//! How long a string is, as JavaScript counts it.
//!
//! Every bound this workspace ports was written against `String.prototype.length`, which counts
//! **UTF-16 code units** — and the obvious Rust spelling, `chars().count()`, counts code points.
//! The two agree on every character below U+10000 and disagree by a factor of two above it, so a
//! port reads correctly, passes a corpus of ASCII fixtures, and quietly accepts twice the emoji the
//! rule allows. `docs/evidence/utf16-lengths-2026-09-14.md` has the six sites this was found at.
//!
//! This is the same seam the PTY scrollback sits on from the other side (spec 060): a lone
//! surrogate at a slice boundary is a legal JavaScript string and not a legal Rust `String`.

/// `value.length` — the number of UTF-16 code units.
pub fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// `value.slice(0, limit)`, to the extent Rust can hold the answer.
///
/// JavaScript would cut between the halves of a surrogate pair and keep the lone high surrogate;
/// a Rust `String` cannot hold one, so the pair is dropped instead and the result is one code unit
/// shorter than JavaScript's. Everything below U+10000 — which is everything these budgets meet in
/// practice — is cut identically.
pub fn truncate_utf16(value: &str, limit: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for character in value.chars() {
        let width = character.len_utf16();
        if used + width > limit {
            break;
        }
        used += width;
        out.push(character);
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_string_is_as_long_as_javascript_says_it_is() {
        assert_eq!(super::utf16_len("hello"), 5);
        // "😀".length === 2 in JavaScript, and one `char` in Rust.
        assert_eq!(super::utf16_len("😀"), 2);
        assert_eq!("😀".chars().count(), 1, "which is the mistake this module exists to stop");
        assert_eq!(super::utf16_len("é😀e"), 4);
    }

    #[test]
    fn a_cut_never_leaves_half_a_pair() {
        assert_eq!(super::truncate_utf16("ab😀cd", 3), "ab", "the pair does not fit in one unit, so it is dropped whole");
        assert_eq!(super::truncate_utf16("ab😀cd", 4), "ab😀");
        assert_eq!(super::truncate_utf16("abcd", 2), "ab");
        assert_eq!(super::truncate_utf16("abcd", 99), "abcd");
    }
}
