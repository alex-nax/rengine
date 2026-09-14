//! What a project says about itself and what it leaves behind (F153–F156, spec 129).
//!
//! This crate is where the JS host's project-file modules land as they are ported. The rule it
//! keeps is the one `red-store` and `red-agents` established: the ANSWER is what moves, word for
//! word — a workspace's refusals are what a person reads when their project will not load, and a
//! port that improved the wording would be a port that broke the record it is judged against.

pub mod declaration;
pub mod recordings;
pub mod rules;
