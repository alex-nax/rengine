# Windows verification of the native desktop over SSH

Host: `pr0fe@192.168.31.217` (charter D31; Windows 11 Pro, Visual Studio 2026 Community, CMake,
Ninja, Node 24, Git, Python, NVIDIA RTX 4070 Ti SUPER). The SSH shell is `cmd.exe`: `;` is not a
separator, use `&`; a command that starts with a double quote is mangled by `cmd /c`, so run
PowerShell scripts as files (`powershell -NoProfile -ExecutionPolicy Bypass -File ...`).

## Source transfer (commits only)

The working tree never leaves the Mac; the other orchestrator session's uncommitted files stay
local. Commits move by bundle into the isolated checkout `C:\Users\pr0fe\rengine`:

```sh
git bundle create /tmp/rengine.bundle main            # first time: everything; later: main ^<last-transferred-sha>
scp /tmp/rengine.bundle pr0fe@192.168.31.217:C:/Users/pr0fe/rengine-deps/rengine.bundle
ssh pr0fe@192.168.31.217 "git clone C:\Users\pr0fe\rengine-deps\rengine.bundle C:\Users\pr0fe\rengine & cd /d C:\Users\pr0fe\rengine & git checkout -B main origin/main"   # first time; a bundle carries no HEAD
ssh pr0fe@192.168.31.217 "cd /d C:\Users\pr0fe\rengine & git fetch C:\Users\pr0fe\rengine-deps\rengine.bundle main & git reset --hard FETCH_HEAD"
```

## Prerequisites on the host

`C:\Users\pr0fe\rengine-deps\win-prep.ps1` (kept in the session scratchpad, reproduced by hand if
missing) downloads `SDL2-devel-2.32.10-VC.zip` from the SDL GitHub release into
`C:\Users\pr0fe\rengine-deps\SDL2-2.32.10` and installs the LunarG Vulkan SDK through
`winget install --id KhronosGroup.VulkanSDK`. `npm ci` in the checkout builds node-pty with the
Visual Studio toolchain.

## Build and tests

`orchestrator/build.mjs` configures `.cache/desktop` with the Visual Studio generator; pass
`SDL2_DIR=C:\Users\pr0fe\rengine-deps\SDL2-2.32.10\cmake` in the environment. Copies of
`SDL2.dll` land next to `rengine.exe` through the post-build step in `cmake.toml`.

GUI tests must run in the console session: processes started from SSH have no interactive window
station, so hardware rendering is unavailable there. `tools/windows-verify.cmd` is launched through
a scheduled task and writes its output to `C:\Users\pr0fe\rengine-logs\<name>.log`:

```sh
ssh pr0fe@192.168.31.217 "schtasks /create /tn rengine-verify /tr \"C:\Users\pr0fe\rengine\tools\windows-verify.cmd render\" /sc once /st 00:00 /ru pr0fe /it /f & schtasks /run /tn rengine-verify"
ssh pr0fe@192.168.31.217 "type C:\Users\pr0fe\rengine-logs\render.log"
```

Stages: `setup` (`npm ci`), `build` (configure and build), `render` (the render comparison spec),
`suite <backend>` (the desktop suite on `RENGINE_RENDERER=<backend>`), `ctest`, `smoke` (all backends).
Each stage writes a new `<stage>-<timestamp>.log` and records its path in `<stage>.latest`, then
appends `STAGE-EXIT=<code>` when done; poll `.latest` and check that the file name changed before
reading `STAGE-EXIT`, otherwise a previous run's exit line is mistaken for the new one. `setup`,
`build` and `ctest` need no window and can run straight from SSH. The task is created without
`/ru`, so it runs as the logged-on user in the console session (windows appear on the box's
screen while a stage runs). From the nolf notes: killing the process with `taskkill` leaves the
task in the running state and later `schtasks /run` calls are silently ignored; `schtasks /end`
first.
