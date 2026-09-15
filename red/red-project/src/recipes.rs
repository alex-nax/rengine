//! The agent recipes, for the parts of this crate that need what every CLI declares.
//!
//! Two things a project's own paths depend on are the recipes': the environment variables a CLI
//! stamps on its children, which a command must not inherit, and where a CLI installs itself, which
//! a command has to look in. Neither is about *which* CLI is running — they are unions over every
//! declared one — so this crate reads the document rather than carrying a copy (F220, spec 141).
//!
//! Finding and parsing that document is `red_agents`' own job, not a third copy of it here.

/// Every declared recipe, shipped and extra.
pub fn recipes() -> Vec<(String, red_agents::Value)> {
    red_agents::shipped_recipes()
}
