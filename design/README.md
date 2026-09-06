# rEngine design system source

The Claude Design project “rEngine native workspace” (`9e977c1b-7cbd-4a89-90a4-5524771712d7`) is the
authority for this directory; pull edited files back verbatim. Nothing here is loaded at runtime.
Boundaries: [spec 064](../docs/specs/064-design-system-handoff.md); rendering plan: [spec 066](../docs/specs/066-gpu-rendering.md).

| Path | Role |
| --- | --- |
| `tokens.css` | Authoritative tokens: three `:root` layers (palette, semantic, per-view) plus `[data-theme]` presets |
| `tokens.json` | Generated mirror of `tokens.css` layers and presets; keeps the design notes and renderer primitive list |
| `base.css`, `styles.css` | Component styling and the stylesheet every card links |
| `previews/**/*.html` | Claude Design cards; first line is the `@dsCard` marker, head links `../../styles.css` |
| `manifest.json` | Generated card index |
| `../orchestrator/native/theme.json` | Interim source of the shipping desktop's theme until the GPU renderer lands |
| `../orchestrator/native/theme.h` | Generated from `theme.json` |

Commands (standard-library Python):

```
python3 tools/design.py generate        # theme.h, the tokens.json mirror and manifest.json
python3 tools/design.py check           # stale output, malformed cards, mirror drift, native literals
python3 tools/design.py resolve teal    # a preset's tokens with colours resolved to sRGB 8-bit
```

Sync from an interactive Claude Code session: run `/design-login`, then ask to sync this directory
into the project above. Only `design/**` belongs in the plan.
