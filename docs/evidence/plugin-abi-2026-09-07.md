# Blind-regression evidence: the in-process plugin ABI (F108)

Date: 2026-09-07. Feature: [spec 106](../specs/106-plugin-abi.md), implementing charter D38 from
[spec 105](../specs/105-packs-editions-and-the-name.md). Suites: CTest `native_plugin`
(`orchestrator/native/tests/plugin_test.c`) and `orchestrator/tests/native-plugin.spec.mjs`
(added to `test:desktop`). Platform: macOS 15.7, Metal backend for the window spec.

A test that has never failed is an assertion with no evidence behind it. Every row below is one
edit applied alone to the finished code by a runner that rebuilt, ran the named suite, recorded the
failure and restored the file; the runner opened with both suites green and closed with both
suites green again, and the tree was confirmed clean after the last restore.

## What the fixtures actually are

Nothing is mocked. `orchestrator/native/tests/plugins/fixture_plugin.c` is compiled seven times by
the desktop build into `.cache/desktop/plugins/`: the plugin proper, and variants that declare
plugin ABI 0, plugin ABI 2, draw list 3, draw list 1, or decline in `start`, plus a module that
exports a symbol but not the entry point. The variants the desktop must refuse call `abort()` in
`start` after printing their name, so "start is never called" is the test process surviving, and
a loader that lets one through is caught by the fixture rather than by an assertion about the
loader. The CTest loads the real files with the real `dlopen` and checks the commands the plugin
appended to a real `ReDrawList`; the window spec loads the same file into a running desktop over
the automation channel and reads the plugin's magenta and cyan back out of a snapshot with
`tools/bmp_find.py`, inside and outside the tab's rectangle.

## The sabotage table: the registry (`native_plugin`)

| # | The break (all in `plugin.c`) | What went red, and for what |
| --- | --- | --- |
| S1 | `register_tab` stores the record without counting it | `re_plugins_tab_count(plugins, old) == 1` — the first loaded plugin has no tab |
| S2 | the frame never calls the tab's `draw` | `list.count == 10` with "the frame holds 2 commands" — only the frame's own clip and reset |
| S3 | the `abi_version` comparison is dropped | `fixture-abi-old: start of a module the desktop must refuse ran`, SIGABRT from the fixture |
| S4 | the `draw_list_version` upper bound is dropped | `fixture-list-new: start of a module the desktop must refuse ran`, SIGABRT from the fixture |
| S5 | the no-entry-point refusal omits the module path | `has(error, blank)` — refused, but not by name |
| S6 | the declared-`abi` check moves after `dlopen` | `!has(error, "cannot open")` — a nonexistent path plus a bad claim reports dlopen's message, so the file was touched first |
| S7 | the by-name lookup never matches | the second `re_plugins_load("fixture")` returns a new index |
| S8 | `start`'s return value is ignored | `declined == -1` — the declining fixture is loaded |
| S9 | `clip` uses the plugin's rectangle without intersecting | `c[4]` is the plugin's 500×400 request, not its 300×200 area |
| S10 | the closing `re_draw_list_clip(list, NULL)` is dropped | `list.count == 10` with "the frame holds 9 commands" — the reset is the missing one |
| S11 | `colour` never matches a token | `c[5]` is magenta, the fixture's fallback, not `--ui-fg` |
| S12 | `register_tab` accepts a call outside `start` | `c[7]` is `(9,9,9,9)`, the fixture's "accepted" colour, not black |
| S13 | `refuse` keeps the tabs a declining `start` registered | `!"a declined plugin keeps no tab"` — `fixture-decline/hello` is still listed |
| S14 | `text_width` returns 0 instead of asking the lent measurer | `c[2].rect.x == 100 + 300 - 7 * 14 - 8` — the label sits at the edge |

S2 and S10 fail on the same assertion, which is why the count is printed before it: 2 and 9 are
different reasons, and the record says which.

## The sabotage table: the window (`native-plugin.spec.mjs`)

| # | The break | What went red, and for what |
| --- | --- | --- |
| P1 | `re_plugin_view_draw` draws the placeholder instead of calling `re_plugins_draw` | `'magenta reached the frame'`: 0 magenta pixels in the 40×40 at the area's origin |
| P2 | `re_app_plugin_load` opens no tab after a successful load | `plugin tab visible not reached` — the plugin is `loaded` and no tab of type 9 exists |
| P3 | the frame's opening clip is dropped | `'clipped to the tab'`: expected 0, actual 6080 magenta pixels in the pane to the right |
| P4 | `restore` keeps the old type ceiling (`> RE_TRACKER`) | `restored plugin tab not reached` — the saved layout is refused whole and the window opens fresh |
| P5 | `refuse` calls `stop` through the descriptor it has not set | `Native desktop exited: null/SIGSEGV` on the first refused module — the window did not keep answering |
| P6 | the desktop's `measure` returns 0 | `'the label body landed where text_width put it'`: no cyan in the 100px body region |

## The test that did not test what its name claimed

P6's first run stayed **green**. The assertion was "cyan somewhere in the right 120px of the
area". With a zero width the label starts 8px before the right edge, and the first glyph's ink
lands inside those 8px — inside the region — before the clip removes the rest. The registry-side
S14 was red because the CTest checks the command's x coordinate exactly; the window-side check
was looking at pixels and looking too loosely. The assertion is now two: ink in the 100px body
that ends 8px before the edge, and none in the final 8px strip. Under the same sabotage that is
red on the body region, and green restored. This is the same shape as the second finding in
session 71: a test that passes first time is not evidence until it has been made to fail.

## Gates at the merge

CTest `native_plugin` passes among the native tests; `native-plugin.spec.mjs` passes (two tests,
about 2.5 s); `npm test`, `npm run build`, `python3 tools/features.py validate`,
`python3 tools/design.py check` and `./init.sh` are recorded in the session entry. No test makes a
network call. The fixture modules are built into `.cache/desktop/plugins/` and read from there;
nothing is installed and no search path is consulted — a relative path is refused before `dlopen`.

## Not verified

Windows. The wrapper compiles to `LoadLibraryA`/`GetProcAddress` and the fixtures build as DLLs
from the same TOML, by construction only: no plugin has been loaded on the Windows host while the
desktop suite's repair (KI-038) is outstanding, and F108 stays `passes: false` for that criterion.
