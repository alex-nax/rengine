//! A corpus is a document of identified entries, and there are two shapes of it here.
//!
//! Every flow that searches, aligns or reranks needs the same thing: a list of `(id, title, body)`.
//! Across this family of projects those live in four files of two shapes — a feature inventory in
//! JSON, and Markdown that carries either `## LL-12 — a title` sections or `| AP-3 | … |` table
//! rows. So this reads by SHAPE rather than by project, which is what lets one plugin serve a
//! project with 1,394 features and one with 187 without knowing anything about either.
//!
//! What it deliberately does not do is guess. A file whose shape it does not recognise is a
//! refusal naming the file, not an empty corpus: a flow that silently searched nothing would answer
//! "nothing matches" forever, and that reads exactly like a correct answer.

use std::path::Path;

use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub title: String,
    /// Everything the entry says, for the flows that read one properly rather than ranking it.
    pub body: String,
}

impl Entry {
    /// A description short enough that a whole corpus fits in one request's state.
    pub fn snippet(&self, characters: usize) -> String {
        let text = if self.title.is_empty() { &self.body } else { &self.title };
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.chars().count() <= characters { return text; }
        text.chars().take(characters.saturating_sub(1)).collect::<String>() + "…"
    }
}

/// `## ID — title` sections and `| ID | … |` table rows, both keyed on an identifier that looks
/// like one: letters, a dash, digits. Anything else in the document is not an entry.
/// A title reduced to something quotable: lowercase words joined by dashes, bounded.
fn slug(title: &str) -> String {
    let mut out = String::new();
    for word in title.split_whitespace().take(8) {
        let cleaned: String = word.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        if cleaned.is_empty() { continue; }
        if !out.is_empty() { out.push('-'); }
        out.push_str(&cleaned.to_ascii_lowercase());
    }
    if out.is_empty() { "section".to_string() } else { out }
}

fn from_markdown(text: &str) -> Vec<Entry> {
    let identifier = |word: &str| {
        let (letters, digits) = word.split_once('-')?;
        (!letters.is_empty() && letters.chars().all(|c| c.is_ascii_uppercase())
            && !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
            .then(|| word.to_string())
    };

    let mut entries: Vec<Entry> = Vec::new();
    let mut open: Option<(String, String, Vec<String>)> = None;
    // Entries come out in DOCUMENT ORDER, so an open section is closed before anything else is
    // pushed. Getting this wrong put a table row ahead of the section it followed, and every flow
    // downstream reports "the first match" — which would then have been the wrong one.
    macro_rules! close {
        () => {
            if let Some((id, title, body)) = open.take() {
                entries.push(Entry { id, title, body: body.join("\n").trim().to_string() });
            }
        };
    }
    for line in text.lines() {
        // A heading at any depth: `## LL-12 — the title` or `### AP-3 - the title`.
        let heading = line.trim_start_matches('#');
        if heading.len() < line.len() && line.starts_with('#') {
            // ANY heading ends the open entry, identifier or not. Entries are flat in both
            // documents this reads, and the alternative — only an identifier heading closes one —
            // lets a lesson swallow every unrelated section that follows it, which is a body that
            // answers for text it does not own.
            close!();
            let depth = line.len() - heading.len();
            let rest = heading.trim();
            let (first, tail) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
            // `# A document` is the document's own title, not an entry in it.
            if depth >= 2 && !rest.is_empty() {
                match identifier(first) {
                    Some(id) => {
                        let title = tail.trim_start_matches(['—', '-', ':']).trim().to_string();
                        open = Some((id, title, Vec::new()));
                    }
                    // A section with no identifier is still an entry — one project numbers its
                    // lessons and another titles them, and the second must not be unsearchable for
                    // it. Its id is a SLUG of the title, which is stable exactly as long as the
                    // title is: good enough to point a person at, and not something to record as
                    // though it had been minted.
                    None => open = Some((slug(rest), rest.to_string(), Vec::new())),
                }
            }
            continue;
        }
        // A table row whose first cell is an identifier.
        if line.starts_with('|') {
            let cells: Vec<&str> = line.trim_matches('|').split('|').map(str::trim).collect();
            if let Some(id) = cells.first().and_then(|first| identifier(first)) {
                close!();
                let rest = cells[1..].join(" — ");
                entries.push(Entry { id, title: rest.clone(), body: rest });
                continue;
            }
        }
        if let Some((_, _, body)) = open.as_mut() { body.push(line.to_string()); }
    }
    close!();
    entries
}

/// A feature inventory: `{"features":[{"id":…,"description":…,"acceptance_criteria":[…]}]}`, which
/// is the harness's own shape, or a bare array of the same rows.
fn from_inventory(document: &Value) -> Option<Vec<Entry>> {
    let rows = document.get("features").and_then(Value::as_array)
        .or_else(|| document.as_array())?;
    let mut entries = Vec::new();
    for row in rows {
        let id = match row.get("id") {
            Some(Value::Number(number)) => format!("F{number}"),
            Some(Value::String(text)) => text.clone(),
            _ => continue,
        };
        let title = row.get("description").and_then(Value::as_str).unwrap_or_default().to_string();
        let mut body = title.clone();
        if let Some(criteria) = row.get("acceptance_criteria").and_then(Value::as_array) {
            for criterion in criteria.iter().filter_map(Value::as_str) {
                body.push_str("\n- ");
                body.push_str(criterion);
            }
        }
        entries.push(Entry { id, title, body });
    }
    Some(entries)
}

/// Read a corpus, or refuse naming the file. `root` is the project root and `relative` the path it
/// declared — already checked by `flows::declared`, and joined here rather than trusted as absolute.
pub fn read(root: &Path, relative: &Path) -> Result<Vec<Entry>, String> {
    let path = root.join(relative);
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read the corpus at {}: {e}", path.display()))?;
    let entries = if path.extension().is_some_and(|e| e == "json") {
        let document: Value = serde_json::from_str(&text)
            .map_err(|e| format!("{} is not JSON: {e}", path.display()))?;
        from_inventory(&document).ok_or_else(|| format!(
            "{} is JSON but not an inventory: expected a `features` array, or an array of rows with \
             an `id` each", path.display()))?
    } else {
        from_markdown(&text)
    };
    if entries.is_empty() {
        // Not an empty corpus — a corpus this cannot read. A flow that searched nothing would
        // answer "nothing matches" forever, which reads exactly like a correct answer.
        return Err(format!(
            "{} holds no entries this can read. An entry is a `## ID — title` heading or a table row \
             whose first cell is an ID like LL-12 or AP-3.", path.display()));
    }
    Ok(entries)
}

/// One entry by id, or a refusal that says how many it looked through.
pub fn find<'a>(entries: &'a [Entry], id: &str) -> Result<&'a Entry, String> {
    entries.iter().find(|entry| entry.id == id)
        .ok_or_else(|| format!("{id} is not in this corpus ({} entries)", entries.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_sections_and_table_rows_are_both_entries() {
        let entries = from_markdown(
            "# A document\n\
             Some prose that is not an entry.\n\
             ## LL-12 — a lesson about clocks\n\
             The body of the lesson.\n\
             More body.\n\
             ## Not an entry at all\n\
             ### AP-3 - an antipattern\n\
             Its body.\n\
             | AP-9 | one thing | another |\n\
             | not-an-id | x | y |\n");
        assert_eq!(entries.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
                   ["LL-12", "not-an-entry-at-all", "AP-3", "AP-9"],
                   "a titled section is an entry too, keyed by a slug: one project numbers its \
                    lessons and another titles them");
        assert_eq!(entries[0].title, "a lesson about clocks");
        assert!(entries[0].body.contains("More body"), "the section keeps its body: {:?}", entries[0].body);
        // Whatever kind it is, a heading ENDS the previous entry rather than being swallowed by it.
        assert!(!entries[0].body.contains("Not an entry"), "{:?}", entries[0].body);
        assert_eq!(entries[3].title, "one thing — another");
        // The document's own `# title` is not an entry in it.
        assert!(!entries.iter().any(|e| e.title == "A document"));
    }

    #[test]
    fn an_inventory_carries_its_criteria_in_the_body_and_only_its_description_in_the_title() {
        let entries = from_inventory(&serde_json::json!({ "features": [
            { "id": 1294, "description": "A tree draws through plants",
              "acceptance_criteria": ["The tree is occluded", "The plants are not"] },
            { "id": "KI-7", "description": "A row with a string id" },
            { "nothing": true },
        ] })).expect("inventory");
        assert_eq!(entries.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["F1294", "KI-7"],
                   "a row with no id is skipped rather than given one");
        assert_eq!(entries[0].title, "A tree draws through plants");
        assert!(entries[0].body.contains("The tree is occluded"));
        assert!(!entries[0].title.contains("occluded"), "the title stays short enough to sweep with");
    }

    #[test]
    fn a_corpus_this_cannot_read_is_a_refusal_rather_than_an_empty_one() {
        let directory = std::env::temp_dir().join(format!("jev-corpus-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("dir");
        std::fs::write(directory.join("prose.md"), "Just prose, no entries.\n").expect("write");
        let error = read(&directory, Path::new("prose.md")).expect_err("refused");
        assert!(error.contains("holds no entries"), "{error}");
        assert!(error.contains("LL-12"), "and says what an entry looks like: {error}");

        std::fs::write(directory.join("other.json"), "{\"rows\":[]}").expect("write");
        assert!(read(&directory, Path::new("other.json")).expect_err("refused").contains("not an inventory"));
    }

    #[test]
    fn a_snippet_is_short_enough_to_sweep_a_whole_corpus_with() {
        let entry = Entry { id: "LL-1".into(), title: "a  title\n   with awkward   spacing".into(),
                            body: String::new() };
        assert_eq!(entry.snippet(100), "a title with awkward spacing", "whitespace is normalised");
        assert_eq!(entry.snippet(10), "a title w…");
        assert_eq!(entry.snippet(10).chars().count(), 10, "the cap counts characters, not bytes");
    }
}
