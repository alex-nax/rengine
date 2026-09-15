//! What the store asks the agent recipes: the shape a CLI's conversation ids take (F215, spec 141).
//!
//! The store persists conversations for every CLI and knows what none of their ids look like. The
//! id shape is declared once, as a regular expression in the recipe registry, and matched through
//! `red_agents::id_matches` — the one matcher `parsers` and `launch` use too. Before this, the
//! store carried an `IdShape::KimiSession` variant and a hand-rolled copy of the uuid and ULID
//! rules: a third copy of a shape the registry already declared, in the one component that had no
//! business knowing any CLI's format.

/// The registry document, from the environment when a caller names one, else beside the running
/// binary. `None` is an honest "no registry here", and the caller then vouches only for an id
/// rEngine minted itself rather than guessing a shape.
fn registry_text() -> Option<String> {
    if let Ok(declared) = std::env::var("RENGINE_AGENT_REGISTRY") {
        return std::fs::read_to_string(declared).ok();
    }
    let exe = std::env::current_exe().ok()?;
    let path = exe
        .parent()
        .and_then(|directory| directory.ancestors().nth(3))
        .map(|root| root.join("orchestrator/agents/registry.toml"))?;
    std::fs::read_to_string(path).ok()
}

/// An extra registry document, when a caller names one. A recipe added as DATA is the registry's
/// central promise, and a conversation shape it declares has to reach the store the same way every
/// other atom of it does — this lookup read only the shipped document before F215, so a declared
/// CLI's ids were refused by a store that had never heard of it.
fn extra_text() -> Option<(String, String)> {
    let path = std::env::var("RENGINE_AGENT_REGISTRY_EXTRA").ok().filter(|path| !path.is_empty())?;
    let text = std::fs::read_to_string(&path).ok()?;
    Some((text, path))
}

/// The pattern this CLI's own recipe declares for its conversation ids.
pub fn shape_for(agent: &str) -> Option<String> {
    let text = registry_text()?;
    let extra = extra_text();
    let recipes = red_agents::load_registry(
        &text,
        "registry.toml",
        extra.as_ref().map(|(text, path)| (text.as_str(), path.as_str())),
    )
    .ok()?;
    red_agents::launch::conversation_ids(&recipes, agent)
}
