# UNVERIFIED on Windows as of 2026-09-16. Written from actions/posix/restart-supervisor.sh; no
# Windows machine has run it. See docs/specs/147-repository-layout.md.
#
# Restart a workspace's update supervisor, keeping its session host and every retained session.
# The supervisor is the layer a layered update cannot replace, so its own code — the IDE port it
# reserves, the routes it serves — changes only this way. It costs the managed desktop windows.
#
# The confirm prompt has NO non-interactive bypass, and that is deliberate (AGENTS.md's hand-back
# rule): this is read by a person deciding whether to restart their own editor.
param([string] $State = '')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot 'lib\wizard.ps1')

if (-not $State) { $State = $env:RENGINE_STATE_DIR }
if (-not $State) { $State = Read-ReValue -Prompt 'Workspace state directory' }
if (-not (Test-Path -LiteralPath $State -PathType Container)) {
    Write-ReHost "State directory is unavailable: $State`n"
    exit 2
}
$launch = Get-ReLaunch -Checkout $root

Invoke-ReWizard -Title 'rEngine update supervisor restart' -Total 3

Invoke-ReStage 'What is running, and what a restart would cost'
# --plan is READ-ONLY and names the session host it would leave alone.
Invoke-ReRun 'Read the workspace' $launch @('restart-supervisor', '--state', $State, '--plan')

Invoke-ReStage 'Confirm'
Write-Host 'The desktop windows this supervisor manages will close and reopen on the layout the store kept.'
Write-Host 'Terminals, agents and drafts live on the session host and are not touched.'
if (-not (Confirm-ReAction 'Restart the update supervisor now?')) {
    Write-Host 'Left running. Nothing was signalled.'
    exit 0
}

Invoke-ReStage 'Stop it, then start a detached one from this checkout'
# Detached on purpose: this tab is usually a pane inside the workspace being restarted, and a
# supervisor that stayed a child of it would die with the pane. red-launch does the detaching.
Invoke-ReRun 'Restart' $launch @('restart-supervisor', '--state', $State)
Complete-ReWizard
Write-Host "`nRun /ide again in any agent pane to reconnect the editor."
Write-Host 'This tab retains the log.'
