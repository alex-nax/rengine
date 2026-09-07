# The in-process plugin ABI (F108)

Date: 2026-09-07. Status: implementation spec for charter **D38**, written before the code as the
work protocol requires. Parent: [spec 105](105-packs-editions-and-the-name.md), whose decisions
D38–D41 are the owner's and are implemented here rather than reconsidered. This spec answers 105's
open questions 1 (the ABI's own versioning) and 4 (Windows) and leaves 2 and 3 open.

## What D38 settled, restated as the contract this spec implements

An extension is an **in-process native plugin**. It draws by **appending to the draw list**
(`render/draw_list.h`, already `RE_DRAW_LIST_VERSION 2`, replayed identically by the SDL, OpenGL,
Metal and Vulkan adapters), so a plugin author never touches a graphics API. It registers tabs
through the **owned control layer** (D33), never through pristine microui's `mu_Context`, which
stays private. A plugin fault costs the desktop window and its layout and never a session, because
sessions, drafts and agents belong to the retained session host — so plugin access to the store,
to sessions and to the host connection is **outside the grant**, and nothing in the table below
reaches any of them.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | **The ABI is versioned separately from the draw list, and a plugin declares both numbers.** `RE_PLUGIN_ABI_VERSION` moves when the registration surface — the descriptor, the host table, the tab record — changes shape. `RE_DRAW_LIST_VERSION` moves when a primitive is added. They move for different reasons at different times, and folding one into the other would force a plugin rebuild for a change that cannot affect it. The desktop accepts a plugin only when its ABI version is **equal** to the desktop's and its draw-list version is **at most** the desktop's: the draw list is additive by spec 067 ("a version 1 adapter meets version 2 by handling one added command"), so a plugin built against an older list emits only commands this desktop knows, while one built against a newer list could emit a command no adapter here has. | Recommended |
| 2 | **Everything a plugin may call arrives by pointer.** A plugin makes no reference to any desktop symbol: its one export is the entry point, and the host hands it a table of function pointers. This is what makes the module portable — a Windows DLL cannot import from the executable that loads it without an import library, and a macOS bundle would need `-undefined dynamic_lookup` to do the same — and it makes *what a plugin may do* exactly the contents of one struct rather than whatever happens to be exported. | Recommended |
| 3 | **The entry point and the head of the descriptor are frozen across every future ABI version.** `const RePluginDesc *re_plugin_entry(void)` returns a pointer to static storage and does nothing else; the first two fields of the descriptor, `size` and `abi_version`, keep their offsets forever. The loader reads only those two before deciding, so calling the entry point of a module built against any ABI — older, newer, or one that does not exist yet — is safe. Everything after those fields is version-specific and is read only once the version has matched. | Recommended; the `cbSize`/`sType` convention |
| 4 | **The declaration's `abi` string is `re-plugin/<major>`**, and the desktop refuses a declaration whose major is not its own **before mapping the module**. Mapping a module runs whatever initialisers it carries, so the declared claim is checked first and the module's own descriptor second; the two must agree, and a module whose descriptor contradicts its declaration is refused by name for that. The declaring lane (contract and server) passes the plugin's `name`, the **absolute** module `path` the server resolved beside the declaration (the way spec 104 resolves artwork), and the `abi` string, to `re_app_plugin_load`. This spec does not own the declaration block's shape. | Recommended |
| 5 | **Refusal is by name, and the desktop continues.** Every plugin the desktop was asked to load has a row in `plugins` of the inspected state: `loaded`, or `refused` with a reason naming the module path and, for a version refusal, both versions. A path that will not open, a module without `re_plugin_entry`, a descriptor with the wrong ABI or too new a draw list, a `start` that returns false — each is reported and skipped, nothing of it is called past the point of refusal, and the window keeps running. A refused plugin is not retried within the same window; the next window (or a reload) reads the declaration again. | Recommended, from the task's requirement |
| 6 | **The loader takes an absolute path and opens exactly that file.** A bare name handed to `dlopen` consults the dynamic loader's search paths, which is a hidden-download-adjacent behaviour; a relative path depends on the working directory of whichever process launched the window. Both are refused before the loader is consulted. | Recommended (charter: no hidden downloads, no required `~/...` path) |
| 7 | **What a plugin may do in v1**: during `start`, register up to eight tabs; while one of its tabs is visible, append to that frame's draw list every primitive the contract has except `TEXTURE` — rect, rrect, frame, shadow, ring, text, icon, gradient — clip within its own area, measure text with the desktop's faces, and read a theme colour by its token name. That is the whole table. Textures are deferred because they are backend-owned objects whose lifetime is the renderer's, and a plugin holding one across a backend switch is a use-after-free the desktop cannot see. Input is deferred: v1 is an extension that can draw. | Recommended; "as small as can be defended while still able to draw" |
| 8 | **Tabs are registered through the owned layer; controls are not in v1.** D38 names both. The tab strip *is* the owned layer (`re_ui_tab`), so a plugin's tab is drawn by it like every other view's. The owned controls, by D33's own design, take `mu_Context *` as their first argument so they interleave with microui's — handing them to a plugin hands it the context D38 keeps private. A plugin-facing control surface needs a handle that is not `mu_Context`, and that is a later ABI version's work, not a reason to widen v1. | Recommended; recorded as the one tension in D38 as written |
| 9 | **A theme colour is read by token name, never by enum.** `colour(frame, "--ui-fg", &out)` resolves against the live theme's bound tokens (`re_theme_field_tokens`), so a plugin follows presets, theme files and the accent hue without a copy of the palette, and adding a token is a data edit rather than an ABI edit. A plugin that hard-codes RGBA is wrong in the light preset and that is its own choice. | Recommended (charter D34) |
| 10 | **Tab identity is `<plugin>/<key>`, persisted like any other view.** The workspace's layout records a plugin tab by type and that path; restoring a layout before the plugin has loaded draws a placeholder naming the plugin, and the tab comes alive when the plugin registers the same key. A plugin's registered tabs open when it loads; v1 has no menu to reopen a closed one, which is a follow-up rather than a reason to add a menu here. | Recommended |
| 11 | **A plugin's clip cannot leak.** The frame opens with the clip set to the tab's content area, every clip the plugin sets is intersected with that area, and the frame closes with a clip reset regardless of what the plugin did. Overflow is the list's own rule: the command is dropped, the frame renders what was accepted. | Recommended |
| 12 | **No unloading in v1.** `stop` is called for every started plugin when the window closes, in reverse load order; the module stays mapped until the process exits. `dlclose` on a module whose code may still be referenced by a pointer the desktop holds is a classic fault, and the process is about to exit anyway. | Recommended |
| 13 | **Faults are not caught.** No signal handler, no guard page, no watchdog: D38 accepted that a plugin fault costs the window, and the supervisor restart of 2026-09-07 is the evidence that the window is the whole cost. What this spec adds is that the loader never *causes* one: nothing is called on a module that has not passed every check above. | Owner (D38); the non-catching is recommended |
| 14 | **Windows.** The wrapper compiles to `LoadLibraryA`/`GetProcAddress` behind the same three functions, `RE_PLUGIN_EXPORT` is `__declspec(dllexport)` there, and the fixture targets build as DLLs by the same TOML. That is construction, not evidence: the desktop suite's Windows repair (KI-038) is outstanding and no plugin has been loaded on Windows. Until it is, a project that declares a plugin on Windows gets the same by-name refusal path if the module will not open, and a loaded plugin's behaviour is unverified. | Recommended; answers spec 105 open question 4 honestly |
| 15 | **The icon table is part of what a plugin freezes.** `render/icons.h` is included by the draw-list header, so a plugin built today carries today's `RE_ICON_*` numbering. `icons.json` should therefore be **append-only** from here; a renumbering is a draw-list version bump. This constrains the design lane's file and is recorded as a recommendation for it, not enforced by this spec. | Recommended |

## The header a plugin compiles against

`orchestrator/native/plugin_abi.h`. It includes `render/draw_list.h` for the value types
(`ReColor`, `ReRect`, the face, corner, gradient and icon enums) and nothing else — no microui,
no SDL, no cJSON, no workspace header.

```c
#define RE_PLUGIN_ABI_VERSION 1
#define RE_PLUGIN_ENTRY_NAME "re_plugin_entry"

typedef struct RePluginDesc {
  uint32_t size, abi_version;        /* frozen head: read before anything else */
  uint32_t draw_list_version;        /* RE_DRAW_LIST_VERSION the plugin compiled against */
  const char *name, *version;        /* name: [a-z0-9-], 1-32 bytes; version is informational */
  bool (*start)(RePlugin *self, const RePluginHost *host, void **state);   /* register tabs here */
  void (*stop)(RePlugin *self, void *state);
} RePluginDesc;

typedef struct RePluginTab {
  uint32_t size;
  const char *key, *title;           /* key: [a-z0-9-], 1-32; the tab's identity is "<name>/<key>" */
  void (*draw)(RePluginFrame *frame, void *state);
} RePluginTab;

struct RePluginHost {
  uint32_t size, abi_version, draw_list_version;   /* the desktop's */
  bool (*register_tab)(RePlugin *self, const RePluginTab *tab);            /* start only */
  ReRect (*area)(const RePluginFrame *frame);
  bool (*rect)(RePluginFrame *, ReRect, ReColor);
  bool (*rrect)(RePluginFrame *, ReRect, ReColor, float radius, uint8_t corners);
  bool (*frame)(RePluginFrame *, ReRect, ReColor border, ReColor highlight, float radius);
  bool (*shadow)(RePluginFrame *, ReRect, ReColor, float radius, int width);
  bool (*ring)(RePluginFrame *, ReRect, ReColor, float radius, int width);
  bool (*text)(RePluginFrame *, uint8_t face, int size, int x, int y, ReColor, const char *, int length);
  bool (*icon)(RePluginFrame *, uint8_t icon, int size, ReRect, ReColor);
  bool (*gradient)(RePluginFrame *, ReRect, ReColor from, ReColor to, float radius, uint8_t corners, uint8_t axis);
  bool (*clip)(RePluginFrame *, const ReRect *rect);                       /* NULL: the tab's own area */
  int (*text_width)(const RePluginFrame *, uint8_t face, int size, const char *, int length);
  bool (*colour)(const RePluginFrame *, const char *token, ReColor *out);
};
```

`size` on every struct is the forward-compatibility mechanism decision 3 relies on: a later ABI
that only *adds* members can keep its number, because a plugin reads host members only within
`host->size` and the desktop reads descriptor members only within `desc->size`. A change that
moves or removes a member bumps `RE_PLUGIN_ABI_VERSION`.

## The loader

`orchestrator/native/plugin.{h,c}` owns the registry and the one platform wrapper
(`dlopen`/`dlsym` on POSIX, `LoadLibraryA`/`GetProcAddress` on Windows). Nothing else in the tree
calls either. The registry is independent of the workspace — it takes a draw list and an area,
not an `ReApp` — so the CTest exercises it headlessly and the desktop glue is thin:

- `re_plugins_load(registry, name, path, abi, error)` — the checks of decisions 4–6 in that order,
  then `start`; returns the plugin's index or −1 with the reason in `error`. Idempotent by name:
  a second call for a loaded or refused name returns its existing state without touching the
  module again, because the workspace state that will carry declarations arrives repeatedly.
- `re_plugins_draw(registry, identity, list, area, measure)` — the frame of decision 11 around one
  registered tab's `draw`.
- `re_plugins_inspect(registry)` — the `plugins` rows of decision 5.
- `re_app_plugin_load(app, name, path, abi)` — the glue: load, then open each registered tab as a
  view of type `RE_PLUGIN` with path `<name>/<key>`. This is the function the declaring lane calls.

The automation channel gains `{op: "plugin", name, path, abi}` so a test can load a module into a
real window without a declaration format that does not exist yet. Automation is an explicitly
enabled stdin channel (`--automation`), the same door `scene` uses; there is no environment
variable and no search path.

## Verification

| Check | Establishes |
| --- | --- |
| `orchestrator/native/tests/plugin_test.c` (`native_plugin`) against real modules built from `tests/plugins/` | the fixture loads and registers its tab; its commands reach a draw list with the identifiable colour and text; a wrong ABI (older and newer) is refused naming the path and both versions and its `start` is never called; a newer draw list is refused, an older one accepted; a module without the entry point and a path that will not open are refused by name and the registry stays usable; a bad `abi` string is refused before the file is opened; a second load of the same name is one plugin; a declining `start` is reported, not drawn, and not stopped; the clip is the tab's area on entry, cannot widen, and is reset on exit; a colour resolves by token name and an unknown token does not |
| `orchestrator/tests/native-plugin.spec.mjs` in `test:desktop` | in a real window the fixture's tab appears in the layout with its title and type, its magenta reaches the snapshot inside the tab's rectangle and its right-aligned label lands where `text_width` put it; a refused module is listed by name and the window keeps answering; the plugin tab survives a window restart |
| `docs/evidence/plugin-abi-2026-09-07.md` | the sabotage table: each regression observed red for its own reason |

## What this spec does not do

It does not define the declaration block (another lane owns `contracts/project-v1.schema.json`
and `formats.mjs`), does not acquire a pack's bytes (KI-008, spec 105 question 2), does not give a
plugin input, textures, controls, a menu, unloading, or any reach into the store, sessions or the
host (D38's paragraph), and does not claim Windows evidence.
