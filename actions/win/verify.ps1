# UNVERIFIED on Windows as of 2026-09-16. Written from actions/posix/verify.sh; no Windows machine
# has run it. See docs/specs/147-repository-layout.md.
#
# Verification stages the project dashboard offers. Each stage is the same command a session would
# run by hand; nothing here is dashboard-only.
param([string] $Stage = 'help')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root
. (Join-Path $PSScriptRoot 'lib\wizard.ps1')
$launch = Get-ReLaunch -Checkout $root

# `& python3` rather than `python3` as a bare word: on Windows the App Execution Alias for python3
# is a stub that opens the Store when the real interpreter is absent, so a missing Python must fail
# here rather than opening a shop.
function Use-Python {
    $found = Get-Command python -ErrorAction SilentlyContinue
    if (-not $found) { $found = Get-Command python3 -ErrorAction SilentlyContinue }
    if (-not $found) { Write-ReHost "python is required for this stage`n"; exit 2 }
    return $found.Source
}

switch ($Stage) {
    'harness'  { Write-Host "== harness gate (init.sh)`n"; Write-ReHost "init.sh is a bash script and bash is not used on Windows (charter D71); this stage has no Windows form yet.`n"; exit 2 }
    'design'   { Write-Host "== design and shader guards`n"; $py = Use-Python
                 Invoke-ReRun 'design guards' $py @('tools/design.py', 'check')
                 Invoke-ReRun 'shader guards' $py @('tools/shaders.py', 'check') }
    'build'    { Write-Host "== native build`n";       Invoke-ReRun 'build' $launch @('build') }
    'ctest'    { Write-Host "== native unit tests`n";  Invoke-ReRun 'build' $launch @('build')
                 Invoke-ReRun 'ctest' 'ctest' @('--test-dir', '.cache/desktop', '--output-on-failure') }
    'render'   { Write-Host "== renderer comparison across backends`n"; Invoke-ReRun 'build' $launch @('build')
                 Invoke-ReRun 'render spec' 'node' @('--test', 'tests/native-render.spec.mjs') }
    'desktop'  { Write-Host "== native desktop suite`n"; Invoke-ReRun 'desktop suite' 'npm' @('run', 'test:desktop') }
    'features' { Write-Host "== inventory`n"; $py = Use-Python
                 Invoke-ReRun 'validate' $py @('tools/features.py', 'validate')
                 Invoke-ReRun 'status'   $py @('tools/features.py', 'status')
                 Invoke-ReRun 'next'     $py @('tools/features.py', 'next') }
    default    { Write-ReHost "verify.ps1 harness|design|build|ctest|render|desktop|features`n"; exit 2 }
}
Write-Host "`n== $Stage finished"
