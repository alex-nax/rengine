# Editor syntax highlighting with selectable schemes (F67)

Date: 2026-09-06. Status: owner-directed, during F67. Parent: [design foundations](076-design-foundations.md),
[native desktop](056-native-desktop.md). Owner: “we need to implement syntax highlighting in code
editors (tunable with different presets like all popular IDEs do)”.

F67's editor criterion already requires the card's syntax colours; this records how they are produced
and how the owner's selectable schemes work, because that goes past what the card shows.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | Highlighting is line-based with a small carry state, not a parse tree: the editor draws one line at a time and must colour it without re-reading the file. `orchestrator/native/syntax.h` is the seam. | Codebase-derived: the editor's drawing loop is per line |
| 2 | Nine token roles, chosen so a scheme assigns one colour per role and stays interchangeable across languages: keyword, type, string, number, comment, function, preprocessor, punctuation, and unclaimed text. | Recommended |
| 3 | Schemes are owned data in `orchestrator/native/syntax.json`, resolved by `tools/design.py` into a generated table, exactly like the theme. A scheme may override per theme preset, because a palette that reads well on the dark preset does not on the light one. | Recommended; follows the theme's own generation rule |
| 4 | The card's colours are the `design` scheme and the default. The additional schemes exist because the owner asked for IDE-style choice; they are owned data, not a port of any product's palette. | Owner: “tunable with different presets like all popular IDEs do” |
| 5 | Languages are the ones this workspace actually edits: C family, Python, JavaScript and TypeScript, JSON, Markdown, shell and CMake. Anything else draws as plain text rather than guessing. | Recommended |
| 6 | Colouring never changes layout. Spans carry byte offsets into a line, the editor keeps its cell grid, and a file with no language draws exactly as it does today. | Codebase-derived: the editor is a fixed cell grid |

## Shape

- `syntax.h` declares the roles, the languages, `re_syntax_language`, and `re_syntax_line`, which
  tokenises one line and carries block context in a `uint32_t`. It allocates nothing and holds no
  per-file state, so the editor can call it while drawing.
- `syntax.c` implements the languages. Robustness is a requirement of the module: a 4 KB line of
  punctuation, an unterminated string, an embedded NUL and invalid UTF-8 must all tokenise without
  reading past the line.
- `syntax.json` carries the schemes; `tools/design.py generate` resolves every scheme against every
  theme preset and writes `orchestrator/native/render/syntax_theme.h` with the colour table and the
  scheme names, checked by `design.py check` like the other generated files.
- The editor asks for spans per visible line and draws each span in its role's colour; unspanned
  bytes keep the editor's foreground.

## Verification

- `orchestrator/native/tests/syntax_test.c` under CTest covers each language's keywords, strings,
  numbers, comments and calls, the block-comment carry across lines, the capacity limit, language
  detection including bare file names, and the robustness cases above.
- The native design spec probes a highlighted editor: a keyword pixel matches the scheme's keyword
  colour in the default and light presets, which proves the generated table and the per-preset
  override reach the screen.
- The committed desktop suite and the renderer comparison keep passing; colouring adds no geometry,
  so the existing editor and terminal gates are unchanged.

## Deferred

Choosing a scheme from the interface belongs with the theme panel (F68); until then a scheme is
selected through the automation `syntax` op and the default is the design scheme. Semantic
highlighting, bracket matching and rainbow indentation are not in scope.
