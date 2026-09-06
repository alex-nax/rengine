# The workspace wears the project's name (F79)

Date: 2026-09-06. Status: recorded after a design interview. Owner request: a project should override
the default logo and title, so that `~/nolf-improved` reads "re:Lith"; and the default itself becomes
"rEdit" rather than "rEngine".

Parent: [design foundations](076-design-foundations.md), charter D33. Shares contract 5 with
[task tracking](083-task-tracking.md).

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | The default title is **rEdit**, not rEngine. The workspace is the editor; rEngine is the project that builds it. | Owner |
| 2 | A project declares a display title and a logo, and the chrome wears them. The example is `~/nolf-improved` reading "re:Lith". | Owner |
| 3 | Identity comes from the **window's primary root**: the root the window was opened on, and for a dedicated project window its target root. It does not follow the focused tab. | Owner, against following focus and against restricting the feature to dedicated windows |
| 4 | The operating system window title follows the same rule, so the title bar and the chrome cannot disagree. | Owner, implied by decision 3 and recorded because `main.c` hardcodes the word today |
| 5 | A logo is a short glyph plus a **design token name**, resolved against the live theme. Not a raw hex colour. | Owner, against raw hex and against accepting either |
| 6 | `project` stays the stable identity used for binding and paths. Display title is a separate key and never overloads it. | Recommended, peer-derived; a display string must not become a join key |
| 7 | Image icons are deferred until the native layer can decode one. Nothing in the desktop decodes an image today; textures take raw pixels. | Recommended, confirmed by two sessions independently |

## Why the token rather than a hex value

The design system already pairs the accent with an ink colour chosen to stay legible against it. A
project naming a token inherits that guarantee, follows theme presets and the accent hue the settings
popover exposes, and cannot produce an unreadable letter. A hex value would make contrast a
per-project accident and would clash with the light preset, which the workspace supports.

## Shape

- Contract 5 adds two optional root keys: a display `title`, and an `icon` object carrying a short
  glyph of one or two characters and a token name. The chip is a fixed square, which is what bounds
  the glyph length.
- `toolbar_brand` draws the declared glyph and token colour instead of the literal `r` and the
  literal word, falling back to rEdit and the accent when a project declares neither.
- The window title is composed from the same source rather than a second literal.
- An undeclared project is unchanged apart from the new default word.

## Verification

- A project declaring a title and glyph shows both in the chrome and in the operating system window
  title, and a project declaring neither shows rEdit with the default mark.
- Binding a second root does not change the chrome, which is decision 3 made observable: the test
  opens a window on one root, binds another, focuses a tab in the second, and asserts the brand is
  unchanged. That assertion fails if identity is taken from the focused tab.
- A declared token name that does not resolve is refused at declaration time with the token named,
  rather than drawing an invisible letter.
- A glyph longer than the chip allows is refused by the schema, not truncated at draw time.
- The trailing-cell fixture still measures the same right edge, since the brand's width is part of
  the toolbar's layout arithmetic.

## Deferred

Image icons, which wait on native image decoding, the same work the dashboard's captured frames wait
on. Per-root chrome inside one window. Any use of the display title as an identifier.
