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

/// `pathToFileURL(file).href` — the shape the LSP store is keyed by.
///
/// Here, and used by both sides, because it is one string fact that TWO processes have to agree
/// about: `red-lsp` keys its diagnostic store by the URI it computes when a file is opened, and the
/// worker asks for that key on behalf of the editor pane and of a connected CLI. A URI that differed
/// by one character would be a file that was broken for one of them and fine for the other, which is
/// exactly what spec 133's D3 says must not be possible.
///
/// The set is Node's own, measured rather than assumed. The two easy mistakes are in it: `~` IS
/// encoded, and `!$&'()*+,` are NOT — the opposite of the usual unreserved set, and the reason the
/// two copies of this rule had drifted apart before it was moved here.
pub fn file_uri(path: &str) -> String {
    const KEPT: &[u8] = b"!$&'()*+,-.:;=@_/";
    let mut out = String::from("file://");
    for byte in path.as_bytes() {
        if byte.is_ascii_alphanumeric() || KEPT.contains(byte) {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod uri_tests {
    use super::file_uri;

    /* Read off `pathToFileURL` character by character, because both sides of a store are keyed with
       it and the JavaScript that still calls them computes it that way. */
    #[test]
    fn a_path_becomes_the_url_node_would_have_made() {
        assert_eq!(file_uri("/work/project/src/main.rs"), "file:///work/project/src/main.rs");
        assert_eq!(file_uri("/work/my project/a b.rs"), "file:///work/my%20project/a%20b.rs");
        assert_eq!(file_uri("/work/proj/ünïcode.rs"), "file:///work/proj/%C3%BCn%C3%AFcode.rs");
        /* The tilde, which the previous copy of this rule kept and Node encodes. A project under
           a path with one in it had no diagnostics at all and nothing said why. */
        assert_eq!(file_uri("/w/~notes/a.rs"), "file:///w/%7Enotes/a.rs");
        assert_eq!(file_uri("/a-b_c.d~e!f'g(h)i"), "file:///a-b_c.d%7Ee!f'g(h)i");
        assert_eq!(file_uri("/w/a#b?c.rs"), "file:///w/a%23b%3Fc.rs");
        assert_eq!(file_uri("/w/a%b.rs"), "file:///w/a%25b.rs");
        assert_eq!(file_uri("/w/a[b]c^d`e{f}g|h\"i<j>k.rs"),
                   "file:///w/a%5Bb%5Dc%5Ed%60e%7Bf%7Dg%7Ch%22i%3Cj%3Ek.rs");
        assert_eq!(file_uri("/w/$&*+,:;=@!'().rs"), "file:///w/$&*+,:;=@!'().rs", "and the punctuation it keeps");
    }
}
