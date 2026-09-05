# Windows terminal environment

Preserve inherited executable search paths when starting PTYs and CLI wrappers. Windows
environment names are case-insensitive: a spread copy containing `Path` must not gain a second
`PATH` that masks the system/tool entries. Node documents that duplicate case variants are
[resolved by lexical key order](https://nodejs.org/api/child_process.html), which can discard the
intended value when a plain JavaScript object is passed to a child.

Normalize inherited and explicit override entries by platform before appending known user CLI
directories. Explicit overrides win regardless of casing on Windows; retain their chosen spelling.
Remove non-string values and the Electron run-as-Node variable. Preserve case-distinct keys on
macOS/Linux. Use platform path separators and avoid appending duplicate directories (ignoring
case on Windows). This function receives explicit environment/platform inputs for portable
regression checks; those checks are not native Windows PTY qualification.

Acceptance: a Windows `Path` with system and Node entries survives unchanged at the beginning,
there is exactly one case-insensitive PATH key, mixed-case overrides take effect, Electron mode
does not reach child tools, and POSIX case sensitivity remains intact. Existing real macOS PTY
and agent tests must continue passing. Native Windows execution remains a separate gate.
