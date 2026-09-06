# rEngine design system source

Design material for the native C/microui desktop. Nothing here is loaded at runtime; see
[spec 064](../docs/specs/064-design-system-handoff.md) for the boundaries.

| Path | Role |
| --- | --- |
| `tokens.json` | Single source for colours, typography, layout metrics, icon glyphs and UI strings |
| `base.css` | Shared preview styling that mirrors what the native renderer can draw |
| `previews/**/*.html` | Self-contained Claude Design cards; first line is the `@dsCard` marker |
| `tokens.css`, `manifest.json` | Generated; the CSS custom properties and the card index |
| `../orchestrator/native/theme.h` | Generated C header consumed by the desktop |

Commands (standard-library Python):

```
python3 tools/design.py generate   # regenerate header, CSS, manifest and managed preview blocks
python3 tools/design.py check      # fail on stale output or a native colour outside the palette
python3 tools/design.py import design/previews/foundations/colors.html   # pull :root edits back
```

Sync to Claude Design from an interactive Claude Code session: run `/design-login`, then ask to
sync this directory into a design-system project. Only `design/**` belongs in the plan.
