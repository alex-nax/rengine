//! What a project says about itself and what it leaves behind (F153–F156, spec 129).
//!
//! This crate is where the JS host's project-file modules land as they are ported. The rule it
//! keeps is the one `red-store` and `red-agents` established: the ANSWER is what moves, word for
//! word — a workspace's refusals are what a person reads when their project will not load, and a
//! port that improved the wording would be a port that broke the record it is judged against.

pub mod command;
pub mod dashboard;
pub mod declaration;
pub mod devices;
pub mod games;
pub mod recordings;
pub mod rules;
pub mod tasks;
pub mod tracker;

/// tmp + rename, so a reader never sees half a document. The probe cache is the only thing this
/// crate writes; everything else here answers questions about files it did not make.
pub(crate) fn write_atomically(file: &std::path::Path, value: &serde_json::Value) -> std::io::Result<()> {
    let temporary = file.with_file_name(format!(
        "{}.{}.tmp",
        file.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    std::fs::write(&temporary, value.to_string()).and_then(|()| std::fs::rename(&temporary, file)).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })
}

/// A name unique enough for a scratch directory in a test. Not an identifier anything keeps.
#[cfg(test)]
pub(crate) fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    format!("{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0))
}
