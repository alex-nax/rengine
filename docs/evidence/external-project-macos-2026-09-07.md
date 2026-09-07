# External project capabilities — macOS, 2026-09-07

Owner-directed integration of `/Users/alex/hirebase-v2`, with every rEdit extension outside
that checkout. Spec 085 / F81. Implementation and evidence belong to rEngine; this does not
mark any hirebase product work complete.

## Installed and running

- Home launcher: `/Users/alex/hirebase-v2.command` (executable Bash 3.2-compatible wrapper).
- External profile: `/Users/alex/.local/share/redit/hirebase-v2/project.json` and `commands.mjs`.
- Runtime state: `/Users/alex/.local/state/redit/hirebase-v2`.
- Checkout supplying rEdit: `/Users/alex/rengine`; this is an explicit local development
  checkout binding, not a claim of an immutable packaged release.
- Root: `bf4a307f-3335-42e1-a630-de4b58598342`, canonical path `/Users/alex/hirebase-v2`.

The installed launcher was first opened with native inspection enabled. The real window showed
Hirebase / Hi, the hirebase source tree and eight available dashboard actions: status,
package scripts, dev, docs:dev, lint, typecheck, test and build. Clicking **Project status**
produced `Project: /Users/alex/hirebase-v2` and its real git status in a retained native
terminal; session `64c037dc-6105-4717-85da-f2b02efeac7a` exited 0 and retained that root.
The external JSON helper previewed the real package.json and returned package name `hirebase`.
No development/check script was executed to verify its availability.

The temporary inspection view was closed through SDL's SIGTERM-to-SDL_QUIT handler, then the
normal home launcher was started with no inspection flag. Its retained terminal
`68e6790b-02bd-4f1e-b25b-c3154d5ee3d8` kept PID 68945 and the host kept PID 68944. After the
normal window's layered bootstrap, context-bound `runtime/client.mjs status` reported managed
desktop `b3761338-eb68-4b8c-acc1-7cde13abcca0`, PID 9604, bound to the same project, with
`canReload` and `canAttach`. Supervisor PID 9599, workspace PID 9603, no failed update jobs.
The launcher defaults to no agent; the toolbar remains available for human agent launch.

A before/after SHA-256 comparison found **0 changed files out of 4,085** tracked and untracked
source files. Git status was identical, preserving the existing dirty work. There is no
project `editor.sh` or `.rengine` directory. Private runtime/session metadata stays outside
hirebase-v2; no consumer instructions, submodule, hooks or ignore rules were changed.

Local inspection artifacts (not committed): `.cache/evidence/hirebase-external-summary.json`,
`hirebase-source-preservation.json`, `hirebase-external.bmp` and `hirebase-external.png`.
PNG SHA-256: `47d799a0784fe8650c169523c113171ec371637b9c13358c6b9d716935cc1e3e`.
The BMP uses SDL's 32-bit format; Pillow decoded it for visual review after the standard macOS
image converter refused it. Visual inspection confirmed the source tree and dashboard labels.

## Regression evidence

The initial external-declaration checks failed because the HTTP root API dropped the profile,
the native identity source was absent, and a broken external declaration fell back to the
project-local declaration. An initial sandbox EPERM on loopback listen was infrastructure,
not regression evidence; the tests were rerun with loopback access to establish those failures.

Controlled defects, restored before final verification:

- Remove installation confinement: expected-rejection check goes red after an attempted
  install into the temporary consumer.
- Remove launcher quoting: the literal `$literal` path becomes an unbound shell variable;
  the real launcher's help invocation fails.
- Remove both overwrite protections: the temporary custom profile is overwritten and the
  expected-rejection assertion fails.
- Drop the external root record at `listFormats`: native acceptance fails waiting for the
  declared title while the window shows the default identity.
- Remove the old-host capability guard: the fake legacy host records an unwanted
  `POST /api/roots`, failing the no-mutations assertion.

Tests also exercise canonical binding persistence, conflicting/relative/missing/non-file
profiles, host and worker dashboard/devices/game preflight/preview paths, root-confined file
reads, project cwd and retained sessions, malformed and deleted external files without
fallback, quoted paths with spaces/apostrophes/shell metacharacters, symlink installation
boundaries, invalid title rejection before writes, idempotent installation and helper command
allowlisting. The native fixture clicks an external helper and reads its output in the actual UI.

## Final checks

- `npm test`: **84/84** passed.
- `npm run test:desktop`: **39/39** passed, including native external-project acceptance.
- `ctest --test-dir .cache/desktop --output-on-failure`: **6/6** passed.
- `python3 tools/design.py check`, `python3 tools/features.py validate`, `./init.sh`: passed.
- Bundled sidecar repair, review, stamp and check: clean for all eight annotated source files.
- Installed launcher: `bash -n` and `--help` pass. ShellCheck is not installed.

Runtime proof is macOS only. No Windows qualification, hirebase test-suite pass, remote
backend operation or immutable-release claim follows from these checks.
