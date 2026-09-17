# actions/win

PowerShell counterparts of the dashboard actions in `actions/posix/`, one per name.

**Bash is not used on Windows, even transitionally** (charter D71). Git Bash is installed on the
qualification host and is deliberately not the answer — there is no shared shell between the
platforms, so every action exists once per platform rather than once in total.

## How an action is found

An action is declared by **name**, and the reader resolves it:

```
<root>/actions/<platform>/<name>.<ext>
        posix/verify.sh
        win/verify.ps1
```

A declaration names `"action": "verify"`, never a path. That is contract 9, and it is why the name
is not a path: an older reader meets an unknown key in a closed schema and refuses it **by name**,
rather than running `actions/posix/verify.sh` on Windows and being silently wrong.

## PowerShell 5.1, not 7

The qualification host ships Windows PowerShell **5.1** and has no `pwsh`. Every script here must
run under 5.1:

- no null-coalescing `??` or `??=`
- no ternary `? :`
- no `ForEach-Object -Parallel`
- `$PSNativeCommandUseErrorActionPreference` does not exist, so a native command's exit code is
  checked with `$LASTEXITCODE` rather than trusted to throw

## Status

Written from the posix originals. **Parsed on the real host and not yet run there** — and the
difference matters, so here is exactly what each means:

- **Proved (2026-09-16, and `grant-session-message.ps1` on 2026-09-17):** all ten files parse under
  Windows PowerShell 5.1.26100 on `pr0fe@192.168.31.217`, through
  `[Management.Automation.Language.Parser]::ParseFile`. No 5.1 incompatibility, no unterminated
  string, no construct the target refuses to read.
- **Not proved:** that any of them DOES what its posix sibling does. Nothing has been executed.
  Parsing catches a typo; it says nothing about whether the detach detaches, whether the confirm
  refuses without a terminal, or whether `red-launch` is even reachable — `red/` does not compile on
  Windows yet (62 `cfg(unix)` blocks against 1 `cfg(windows)`).

Each file carries an UNVERIFIED header saying the same. A feature row closes on the evidence of
running them, not on their existing. See spec 147 and the Windows arc that follows it.
