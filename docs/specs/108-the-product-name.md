# The product is Red, and the name is generated (charter D41, F110)

Date: 2026-09-07. Status: implemented. Parent: [packs, editions, and the name](105-packs-editions-and-the-name.md),
charter D41, which revises D36. Revises the default word of [project identity](084-project-identity.md).

The owner settled two things in one decision, and the second is the one with engineering in it:

> The product is **Red** and the umbrella is **Red Suite**. … The name stops being hard-coded and
> becomes generated the way theme tokens are, so the rename is a data edit.

So this spec is not a rename. It is the removal of a class of edit: after it, the product's name is a
declared value with one home, every consumer reads a generated artifact, and a guard fails the build
when someone types the word into shipping code again. The rename to Red is then the first data edit,
and the next one costs the same.

## What the name reached before this

Four strings in shipping code, and nothing else:

| Where | What it is | Who sees it |
| --- | --- | --- |
| `RE_DEFAULT_TITLE` in `orchestrator/native/app.h` | the workspace title a project has not overridden (spec 084) | anyone running the desktop |
| `IDE_NAME` in `orchestrator/runtime/ide.mjs` | `ideName` in the `~/.claude/ide/<port>.lock` file | **other people**, in their `/ide` menu beside VS Code and Cursor |
| `clientInfo.name` in `orchestrator/runtime/lsp.mjs` | what we call ourselves to a language server | whoever reads a server's log |
| the callback page `<title>` in `orchestrator/server/tracker-auth.mjs` | the tab a Linear sign-in returns into | the person signing in |

Spec 105 counted them before any of this was built, and the count held.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | The name is **declared once**, in `orchestrator/native/theme.json`, beside the other values the desktop's generator turns into constants. | Owner's D41 wording — "generated the way theme tokens are" — taken literally: the tokens' declaration file is the tokens' declaration file. |
| 2 | The C side is generated into `theme.h` by `tools/design.py generate`, as `RE_PRODUCT_NAME` and `RE_PRODUCT_SUITE`. `RE_DEFAULT_TITLE` becomes an alias of `RE_PRODUCT_NAME` rather than a second literal. | Follows decision 1 and the existing `RE_COLOR_*` / `RE_METRIC_*` path; `theme.h` is already included everywhere through `common.h`. |
| 3 | The JS side is a **generated ES module**, `orchestrator/runtime/product.mjs`, written by the same `generate` run and checked by the same `check`. | Recommended over reading `theme.json` at run time. The reasoning is below; it is a layering argument, not a taste one. |
| 4 | A guard in `tools/design.py check` fails when the product name — or a retired name — appears as a **string literal** in shipping code outside the declaration, the generated files, and one named test. | The deliverable is "the name is not hard-coded"; without a guard that is an intention, not a property. |
| 5 | Comments are not scanned. Prose that names the product is not hard-coding it. | Otherwise the guard would forbid explaining what the file is, and would fire on `docs/`, evidence and the progress log, which are dated records. |
| 6 | Exactly one test may hold the literal `Red`, and it is the test that asserts the declaration equals it. `IDE_NAME` is published into other people's editor menus, so a rename should have to change a line that says so out loud. | Recommended: an externally visible name wants a canary, not silent agreement between two generated things. |
| 7 | Retired names are listed in the declaration (`retired: ["rEdit"]`) and are guarded exactly like the current one, so a half-finished rename fails rather than lingering. | Recommended; the cost of the list is one string per rename. |

### Why a generated module rather than reading the JSON

`orchestrator/runtime/` is the replaceable workspace layer (spec 101): it is what a layered update
ships. `orchestrator/native/theme.json` belongs to the desktop's build inputs. Having the worker read
the native tree's JSON at run time would make a shipping layer depend on a path in another layer,
which is exactly the dependency layered updates exist to avoid — and it would add an I/O failure to
the act of knowing your own name. A generated module is content rather than a path: it is imported
like any other constant, it cannot be half-read, and a stale one is caught by `design.py check` in
the same breath as a stale `theme.h`.

It also gives the loud failure the work protocol asks for. Delete the generated module and every
consumer fails at import; delete the macro and the desktop fails to compile. Neither falls back to a
remembered string, because there is no fallback to write.

## Shape

```
orchestrator/native/theme.json   "product": { "name": "Red", "suite": "Red Suite", "retired": ["rEdit"] }
        │
        └── python3 tools/design.py generate
                ├── orchestrator/native/theme.h        RE_PRODUCT_NAME, RE_PRODUCT_SUITE
                │        └── app.h  #define RE_DEFAULT_TITLE RE_PRODUCT_NAME  → main.c, app.c
                └── orchestrator/runtime/product.mjs   PRODUCT_NAME, PRODUCT_SUITE
                         ├── runtime/ide.mjs      IDE_NAME = PRODUCT_NAME   → the lock file
                         ├── runtime/lsp.mjs      clientInfo.name
                         └── server/tracker-auth.mjs   the callback page
```

`orchestrator/agents/ide-connect.mjs` needs no change: it already decides "is this editor ours?" by
comparing a lock's `ideName` against the imported `IDE_NAME`, so it follows the rename by
construction. That indirection is load-bearing — a workspace that stopped recognising its own editor
would silently stop auto-connecting agent panes (F103) with no error anywhere.

`python3 tools/design.py product` prints the declaration and any hard-coded occurrences as JSON, and
exits non-zero when it finds one. It is the same function `check` calls, so the npm suite can assert
the guard without inheriting an unrelated failure from another lane's colour literal.

## Verification

- The declared name reaches all four consumers, asserted through their real values rather than by
  reading their source: the published lock's `ideName`, the LSP `clientInfo`, the callback page's
  title, and the desktop's default chrome and window title.
- A literal product name reintroduced in shipping code fails `design.py check` and the npm suite,
  naming the file and line.
- A retired name reintroduced fails the same way; the guard does not fire on comments, on `docs/`,
  or on the dated records in `Codex-progress.md` and `docs/evidence/`.
- Removing the generated artifacts fails loudly: the desktop does not compile, and the JS consumers
  throw at import rather than serving a stale name.
- The generated files cannot be hand-edited into agreement: `design.py check` compares them against
  what the declaration would produce.

The sabotage runs behind each of those are in `docs/evidence/product-name-2026-09-07.md`.

## Where the old name deliberately survives

- `Codex-progress.md`, `docs/evidence/**` and the `passes: true` rows of `features.json` are dated
  records of what was true when written. Rewriting them would be falsifying a log.
- Charter **D36** keeps its own wording, because it is the decision that D41 revises; a decision row
  that silently agrees with its successor destroys the record of there having been a change.
- Prose comments in files owned by other lanes (`orchestrator/runtime/worker.mjs`,
  `orchestrator/tests/native-client.mjs`, `orchestrator/tests/hot-update.test.mjs`) still say the old
  word. They are comments, so decision 5 leaves them; they are also not this lane's files.

## Not done here

- `rEngine` is untouched. It is the project that builds Red, and D41 renamed the product, not the
  repository. The MCP server name, the package name and the harness documents keep it.
- `RE_PRODUCT_SUITE` is generated and exported but nothing consumes it yet. D40's editions are the
  first thing that will, and inventing a use for it now would be inventing the edition manifest.
- The declaration lives in the desktop's `theme.json` because that is the file the generator already
  reads. If a later spec gives packs and editions their own manifest (D39, D40), the product name is
  a plain move: one block, two generated outputs, and the guard keeps pointing at whichever file
  holds it.
