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

/* ---- one printable line -------------------------------------------------------------------- */

/// The longest message a relay may carry (F222, spec 148). A nudge, not a document: anything that
/// needs more than this belongs in the repository, which is where a project's content channel is.
pub const ONE_LINE_LIMIT: usize = 400;

/// A message that may be typed into somebody's composer, or a refusal naming what is wrong with it.
///
/// **Refused rather than cleaned.** Stripping a control byte would type a line the caller did not
/// write and report success for it; a caller told what is wrong can fix it. The consequence is the
/// point: a tool held to this can never send a bare Enter, a Ctrl-C or an arrow key, so answering a
/// dialog and interrupting a turn stay out of its reach whatever it is asked to send.
pub fn one_printable_line(value: &str) -> Result<&str, String> {
    if value.is_empty() {
        return Err("A message is one line of text; this one is empty. Nothing was typed.".to_string());
    }
    if utf16_len(value) > ONE_LINE_LIMIT {
        return Err(format!(
            "A message is at most {ONE_LINE_LIMIT} characters and this one is {}. A nudge belongs here; anything longer belongs in the repository. Nothing was typed.",
            utf16_len(value)
        ));
    }
    if let Some(found) = value.chars().find(|c| c.is_control() || *c == '\u{7f}' || ('\u{80}'..='\u{9f}').contains(c)) {
        let named = match found {
            '\n' => "a newline".to_string(),
            '\r' => "a carriage return".to_string(),
            '\t' => "a tab".to_string(),
            other => format!("the control character U+{:04X}", other as u32),
        };
        return Err(format!(
            "A message is one printable line, and this one carries {named}. It is refused rather than cleaned, because a stripped line is not the line that was written. Nothing was typed."
        ));
    }
    Ok(value)
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

    /* F222, spec 148. The blast radius of a relay, decided here: one printable line and nothing
       else, so the tool that carries it can never press Enter, interrupt a turn or answer a
       dialog whatever a caller asks it to send. */
    #[test]
    fn a_message_is_one_printable_line_and_a_control_byte_is_refused_rather_than_stripped() {
        assert_eq!(super::one_printable_line("Re-read the notes, then continue.").expect("plain"), "Re-read the notes, then continue.");
        for (bad, says) in [("two\nlines", "a newline"), ("submit\r", "a carriage return"), ("a\tb", "a tab"), ("kill\u{15}line", "U+0015")] {
            let refusal = super::one_printable_line(bad).expect_err(bad);
            assert!(refusal.contains(says), "{refusal}");
            assert!(refusal.contains("rather than cleaned"), "{refusal}");
            assert!(refusal.ends_with("Nothing was typed."), "{refusal}");
        }
        assert!(super::one_printable_line("").is_err(), "an empty message is not a message");
        assert!(super::one_printable_line(&"x".repeat(super::ONE_LINE_LIMIT)).is_ok());
        assert!(super::one_printable_line(&"x".repeat(super::ONE_LINE_LIMIT + 1)).is_err());
        assert!(super::one_printable_line("ok \u{7f}").is_err(), "DEL is a control byte too");
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
