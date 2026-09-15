//! What the store asks the agent recipes: the shape a CLI's conversation ids take (F215, spec 141).
//!
//! The store persists conversations for every CLI and knows what none of their ids look like. The
//! id shape is declared once, as a regular expression in the recipe registry, and matched through
//! `red_agents::id_matches` — the one matcher `parsers` and `launch` use too. Before this, the
//! store carried an `IdShape::KimiSession` variant and a hand-rolled copy of the uuid and ULID
//! rules: a third copy of a shape the registry already declared, in the one component that had no
//! business knowing any CLI's format.

/// The pattern this CLI's own recipe declares for its conversation ids. `None` when no recipe
/// declares one, and the store then vouches only for an id rEngine minted itself.
pub fn shape_for(agent: &str) -> Option<String> {
    red_agents::launch::conversation_ids(&red_agents::shipped_recipes(), agent)
}
