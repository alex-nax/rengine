# The product name, generated: sabotage runs (F110, spec 108)

Date: 2026-09-07, macOS (Darwin 24.6.0), worktree `agent-aa0f44cd3e0e7f2f1`. Everything below was run
by hand, in order, restoring after each. Node 22, Python 3, clang.

The claim under test is not "the rename happened" — a diff shows that. It is **the name cannot be
hard-coded again, and the generated path cannot fail quietly.** So each row breaks one specific
thing and records what went red, and for which reason.

## Baseline

```
$ python3 tools/design.py check
Native theme, 19 design cards, the token mirror and 3 presets are consistent; native sources use
theme constants only, and the product name is read rather than typed.

$ npm test                      # 219 tests, 219 pass, 0 fail
$ npm run build                 # Built target rengine
$ node --test --test-concurrency=1 orchestrator/tests/native-ide-selection.spec.mjs   # 1 pass
$ node --test --test-concurrency=1 orchestrator/tests/native-identity.spec.mjs        # 5 pass
$ node --test orchestrator/tests/product-name.test.mjs                                # 6 pass
```

`native-identity.spec.mjs` is the one that proves the running desktop wears the new word: it drives
a real window and asserts the chrome title and the operating system window title against
`PRODUCT_NAME`.

## Sabotage

| # | What was broken | What was expected | What actually happened |
| --- | --- | --- | --- |
| S1 | `ide.mjs`: `export const IDE_NAME = 'Red';` — the current name typed back in | the guard names the file and line; the suite goes red on the guard, not on a consumer | `design.py check` → `ERROR: orchestrator/runtime/ide.mjs:23: hard-coded product name 'Red'; import PRODUCT_NAME from orchestrator/runtime/product.mjs (spec 108)`, exit 1. `product-name.test.mjs` failed **only** test 6, with the problem list as its message. Tests 1–5 stayed green, correctly: the value was still right, only its source was wrong. |
| S2 | `app.h`: `#define RE_DEFAULT_TITLE "rEdit"` — the **retired** name typed back into C | the retired name is guarded like the current one | `ERROR: orchestrator/native/app.h:85: hard-coded product name 'rEdit'; use RE_PRODUCT_NAME from theme.h (spec 108)`, exit 1. A half-finished rename fails rather than lingering. |
| S3 | `theme.h` hand-edited: `RE_PRODUCT_NAME "Rouge"` | stale generated output is refused, and the suite catches the header without needing python | `ERROR: orchestrator/native/theme.h is stale or missing (run generate)`, exit 1. `product-name.test.mjs` test 2 failed: `theme.h names the declared product; app.h aliases RE_DEFAULT_TITLE to it — 'Rouge' !== 'Red'`. |
| S4 | `product.mjs` hand-edited: `PRODUCT_NAME = "Rouge"` | the canary fires, because every consumer now agrees on the wrong word | `ERROR: orchestrator/runtime/product.mjs is stale or missing (run generate)`, exit 1. Tests 1, 2 and 6 failed; **tests 3, 4 and 5 passed** — the lock, the language server and the callback page all cheerfully said "Rouge". That is the row worth reading twice: the consumer tests compare against the same module they are fed by, so they cannot notice a renamed product. Test 1 (the literal `'Red'`) and test 2 (the declaration) are the two that can, which is why the canary exists. |
| S5 | `orchestrator/runtime/product.mjs` deleted — the generated JS path removed | consumers fail loudly at import; no fallback string anywhere | `ide.mjs` → `LOUD: ERR_MODULE_NOT_FOUND | Cannot find module '…/orchestrator/runtime/product.mjs' imported from …/ide.mjs`; `tracker-auth.mjs` and `lsp.mjs` the same. `design.py check` → `product.mjs is stale or missing (run generate)`, exit 1. Nothing served a remembered name. |
| S6 | `#define RE_PRODUCT_NAME` deleted from `theme.h` — the generated C path removed | the desktop does not build; no silent fallback title | `npm run build` → `orchestrator/native/app.c:175:27: error: use of undeclared identifier 'RE_PRODUCT_NAME'` (with the alias shown at `app.h:85`), `Native desktop build failed (2)`. |
| S7 | `theme.json` declaration changed to `"Rouge"` **without** regenerating | both generated outputs are reported stale, so a declaration edit cannot half-land | `ERROR: orchestrator/native/theme.h is stale or missing (run generate)` and `ERROR: orchestrator/runtime/product.mjs is stale or missing (run generate)`, exit 1. |
| C1 (control) | a comment added to `lsp.mjs`: `// Red is the product, and this comment says so on purpose` | the guard must **not** fire: prose naming the product is not hard-coding it (spec 108 decision 5) | `design.py product` → `"problems": []`, exit 0. |
| C2 (control) | a file holding `'Redirected to a red Redis instance, prepared and restored.'` | the guard must not fire on words containing the name, or on the lowercase word | `design.py product <file>` → `"problems": []`, exit 0. Word-boundary and case-sensitive, which is what makes guarding a three-letter English word possible at all. |

Every row was restored immediately afterwards and `python3 tools/design.py check` returned green
before the next one started.

## The guard's own regression, automated

`product-name.test.mjs` does not only assert the clean tree — an assertion that has never been seen
to fail is worth little. It writes a decoy **outside** the repository (other agents are working in
it) and points the guard at it with `python3 tools/design.py product <path>`:

```
// A comment naming Red is prose and must not fire; a file has to be able to say what it is.
export const NAME = 'rEdit';
export const MATCH = /^Red\b/;
```

and requires exactly two problems, at lines 2 and 3. The comment on line 1 is the control inside the
fixture: if the guard ever started matching comments, this test fails with three problems rather than
passing for the wrong reason.

The regular expression on line 3 is there because of a real miss. The first version of the guard read
**string literals only**, and it reported 21 hand-written names while silently walking past
`assert.match(state.windowTitle, /^rEdit\b/, …)` in `native-identity.spec.mjs` — a regular expression
is not a string. The guard now scans everything that is not a comment, which is how that line was
found.

## What the four consumers actually answered

Read off real behaviour, not source:

| Consumer | How it was asked | Answer |
| --- | --- | --- |
| the desktop chrome and window title | `native-identity.spec.mjs` drives a live window | the declared name, in both, and unchanged when a second root is selected |
| the `/ide` lock file | `startIdeBridge` publishes into a temp directory; the lock is read back | `"ideName": "Red"` |
| a language server | a recorder server writes down the `initialize` params it receives | `clientInfo.name === "Red"` |
| the tracker sign-in callback | a real loopback request to the listener `begin()` opened | `<title>Red</title>` |

`orchestrator/agents/ide-connect.mjs` needed no change and is asserted rather than assumed:
`IDE_NAME === PRODUCT_NAME`, and its "is this editor ours?" test fixtures publish `IDE_NAME` instead
of a literal — a fixture holding the old word would have kept passing while auto-connect (F103)
silently stopped recognising this workspace's own editor.
