# UNVERIFIED on Windows as of 2026-09-16. Written from actions/posix/project-window.sh; no Windows
# machine has run it. See docs/specs/147-repository-layout.md.
#
# Open a project window bound to the CURRENT retained agent. It opens a VIEW, never a new CLI:
# the agent keeps its conversation and its MCP binding, and this only gives it another window.
param([string] $Context = '', [string] $Project = '', [string] $Agent = '', [switch] $Help)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot 'lib\wizard.ps1')

if ($Help) {
    Write-Host 'project-window.ps1 -Context FILE -Project ABSOLUTE_DIR -Agent RETAINED_AGENT_ID'
    Write-Host 'Missing values are prompted only in a human terminal. Opens a view, never a new CLI.'
    exit 0
}
if (-not $Context) { $Context = $env:RENGINE_WORKSPACE_CONTEXT }
if (-not $Agent)   { $Agent   = $env:RENGINE_ORCHESTRATOR_SESSION }
if (-not $Context) { $Context = Read-ReValue -Prompt 'Existing workspace context file' }
if (-not $Project) { $Project = Read-ReValue -Prompt 'Absolute integration project directory' }
if (-not $Agent)   { $Agent   = Read-ReValue -Prompt 'Current retained agent session ID' }
if (-not (Test-Path -LiteralPath $Context) -or -not (Test-Path -LiteralPath $Project -PathType Container)) {
    Write-ReHost "Context file or project directory is unavailable`n"
    exit 2
}
$launch = Get-ReLaunch -Checkout $root

Invoke-ReWizard -Title 'Open a project with the current agent' -Total 3
Invoke-ReStage 'Verify and adopt the original session host'
Invoke-ReRun 'Prepare window management' $launch @('client', 'bootstrap', '--context', $Context)
Invoke-ReStage 'Open or reuse the bound project window'
Invoke-ReRun 'Attach the retained agent' $launch @('client', 'open', '--context', $Context, '--project', $Project, '--agent', $Agent)
Invoke-ReStage 'Inspect retained window identities'
Invoke-ReRun 'List project windows' $launch @('client', 'windows', '--context', $Context)
Complete-ReWizard
