# UNVERIFIED on Windows as of 2026-09-16. Written from actions/posix/workspace-status.sh; no Windows
# machine has run it. See docs/specs/147-repository-layout.md.
#
# Read-only inspection of a workspace: project windows, the integration inbox, update status.
# This flow only reads; nothing here ends a session or starts one.
param([string] $Context = '')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot 'lib\wizard.ps1')

if (-not $Context) { $Context = $env:RENGINE_WORKSPACE_CONTEXT }
if (-not $Context) { $Context = Read-ReValue -Prompt 'Existing workspace context file' }
if (-not (Test-Path -LiteralPath $Context)) { Write-ReHost "Context file is unavailable`n"; exit 2 }
$launch = Get-ReLaunch -Checkout $root

# Ctrl-C leaves the workspace exactly as it was, and says so — this action reads, so there is
# nothing to undo, and a person who interrupts should not have to wonder.
[Console]::TreatControlCAsInput = $false
try {
    Write-Host "`nrEngine workspace inspection"
    Write-Host "Choose a view; this flow only reads workspace state."
    while ($true) {
        Write-Host "`n1) Project windows`n2) Integration inbox`n3) Update status`n0) Finish"
        $choice = Read-ReValue -Prompt 'Selection'
        switch ($choice) {
            '1' { $query = 'windows' }
            '2' { $query = 'inbox' }
            '3' { $query = 'status' }
            '0' { Write-Host 'Inspection finished. This tab retains the log.'; exit 0 }
            default { Write-Host 'Choose 0, 1, 2 or 3.'; continue }
        }
        Invoke-ReRun "Read $query" $launch @('client', $query, '--context', $Context)
    }
} finally {
    if ($null -ne $Error -and $Error.Count -gt 0 -and $Error[0].Exception -is [OperationCanceledException]) {
        Write-ReHost "Inspection canceled. Sessions remain retained.`n"
    }
}
