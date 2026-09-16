# UNVERIFIED on Windows as of 2026-09-16. Written from actions/posix/replace-host.sh; no Windows
# machine has run it. See docs/specs/147-repository-layout.md.
#
# Replace this workspace's retained session host, ending its sessions on purpose.
#
# The heavier sibling of restart-supervisor.ps1. That one replaces the supervisor and its desktop
# windows and leaves the session host alone; this one replaces the HOST, which is what a capability
# the host does not advertise requires — a retained host serves the code it loaded, so a feature
# added since reads as broken rather than as off (KI-116).
#
# THE DETACH IS THE INTERESTING PART, and it differs from the posix original for a real reason.
# There, the launcher is almost always run from a pane inside the workspace it is replacing, and the
# script double-forks through python's os.setsid because macOS ships no setsid(1). Windows has no
# setsid and needs none: `Start-Process` without -NoNewWindow gives the child its OWN console, which
# is the same guarantee — this tab's console closing cannot hang it up. The mark file is kept, and
# for the same reason: a script tab closes within milliseconds of exit, sooner than a child can
# report, and a launcher lost exactly there leaves the workspace with no host at all.
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
$State = (Resolve-Path -LiteralPath $State).Path
$launch = Get-ReLaunch -Checkout $root

Invoke-ReWizard -Title 'rEngine session host replacement' -Total 3

Invoke-ReStage 'What is running, and what a replacement would cost'
$descriptor = Join-Path $State 'sidecar.json'
if (-not (Test-Path -LiteralPath $descriptor)) {
    Write-ReHost "No session host descriptor in $State`n"
    exit 2
}
$sidecar = Get-Content -LiteralPath $descriptor -Raw | ConvertFrom-Json
Write-Host "Session host PID $($sidecar.pid) at $($sidecar.url)."
try {
    $state = Invoke-RestMethod -Uri "$($sidecar.url)/api/state" -Headers @{ Authorization = "Bearer $($sidecar.token)" } -TimeoutSec 8
    $sessions = @($state.sessions)
    $running = @($sessions | Where-Object { $_.state -eq 'running' })
    $kinds = $running | Group-Object -Property type | ForEach-Object { "$($_.Count) $($_.Name)" }
    $summary = if ($kinds) { $kinds -join ', ' } else { 'none' }
    Write-Host "It holds $($sessions.Count) sessions, $($running.Count) of them running: $summary"
    foreach ($s in $running) {
        $title = [string]$s.title
        if ($title.Length -gt 46) { $title = $title.Substring(0, 46) }
        Write-Host ("    ends: {0,-9} pid {1,-7} {2}" -f $s.type, $s.pid, $title)
    }
    $capabilities = @($state.capabilities.PSObject.Properties.Name | Sort-Object)
    $listed = if ($capabilities) { $capabilities -join ', ' } else { 'none' }
    Write-Host "It advertises $($capabilities.Count) capabilities: $listed"
    Write-Host 'A host advertising fewer than the build declares is serving the code it loaded, not this checkout.'
} catch {
    Write-Host "The host did not answer: $($_.Exception.Message)"
    Write-Host 'A host that will not answer is still a host; replacing it still ends whatever it holds.'
}

Invoke-ReStage 'Confirm'
Write-Host 'Every session above ENDS. Terminals, agent panes and their conversations stop with the host.'
Write-Host 'Drafts and the layout live in the store service and are kept; the desktop windows reopen.'
Write-Host 'A pane you are reading this in is one of them: the tab closes when the host goes.'
if (-not (Confirm-ReAction 'Replace the session host now?')) {
    Write-Host 'Left running. Nothing was signalled.'
    exit 0
}

Invoke-ReStage 'Detach, then replace'
$log  = Join-Path $State 'replace-host.log'
$mark = Join-Path $State 'replace-host.detached'
if (Test-Path -LiteralPath $mark) { Remove-Item -LiteralPath $mark -Force }
Add-Content -LiteralPath $log -Value ("replace-host: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

# Its own console, so this tab's console closing cannot take it with it. The mark is written by the
# child itself, which is what proves it reached its own session rather than merely being spawned.
$child = @"
Start-Sleep -Seconds 2
Set-Content -LiteralPath '$mark' -Value `$PID
Set-Location '$root'
& '$launch' --replace-host --state '$State' *>> '$log'
"@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($child))
Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-EncodedCommand', $encoded) -WindowStyle Hidden | Out-Null

for ($i = 0; $i -lt 100; $i++) {
    if ((Test-Path -LiteralPath $mark) -and (Get-Item -LiteralPath $mark).Length -gt 0) { break }
    Start-Sleep -Milliseconds 50
}
if (-not (Test-Path -LiteralPath $mark) -or (Get-Item -LiteralPath $mark).Length -eq 0) {
    Write-ReHost "replace-host: the detached child never reported its session; nothing was signalled. See $log`n"
    exit 1
}
Complete-ReWizard
Write-Host "`nThe launcher is detached as PID $(Get-Content -LiteralPath $mark -Raw), in its own console; its log is $log"
Write-Host 'This pane ends when the host is replaced. The new window opens on the layout the store kept.'
