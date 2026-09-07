# The workspace wears the project's name (F79)

Date: 2026-09-06. Status: recorded after a design interview. Owner request: a project should override
the default logo and title, so that `~/nolf-improved` reads "re:Lith"; and the default itself becomes
"rEdit" rather than "rEngine".

> Revised 2026-09-07 by charter D41: the product is **Red**, so the default title is Red. The
> decisions below keep their original wording, because D41 is a revision and a decision that
> silently agrees with its successor destroys the record of there having been a change. The
> default word is no longer written in the source at all — it is declared and generated
> ([spec 108](108-the-product-name.md)), so read every "rEdit" below as "the product's own
> name". The declared-title and glyph behaviour this spec specifies is unchanged.

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

## What shipped (F79, 2026-09-07)

Contract 5 carries an optional display `title` and an `icon` of a glyph plus a design token name.
Both are plain root keys rather than a block, so their contract floor is checked directly, and a
project on contract 4 that sets either is refused by name and required version instead of having them
accepted in silence. A token outside the design set is refused naming the token, so an unresolvable
colour cannot reach the chip.

The chrome and the operating system window title both read the primary root's declared identity, and
both fall back to rEdit. The window title follows in the frame loop rather than at window creation,
because the declaration arrives after the window exists; it is composed from the same source rather
than a second literal, which is what makes them unable to disagree.

Identity is fixed to the root the window opened on and never follows the focused tab. That is the
decision most worth having a test for, and it is asserted by selecting a second, declared root and
requiring the chrome to be unchanged — an assertion that fails the moment identity reads the
selected root instead.

To wear a name, a project adds to `.rengine/project.json`:

```json
{ "contract": 5, "title": "re:Lith", "icon": { "glyph": "rL", "token": "ok" } }
```

Four tokens beside `accent` are accepted: `ok`, `warn`, `err` and `info`. The glyph's ink is the
on-accent ink for every one of them, which is the pairing the design system guarantees against a
saturated fill.

## Deferred

Image icons, which wait on native image decoding, the same work the dashboard's captured frames wait
on. Per-root chrome inside one window. Any use of the display title as an identifier.
