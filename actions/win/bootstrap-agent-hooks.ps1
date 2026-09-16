# UNVERIFIED on Windows as of 2026-09-16. Written from actions/posix/bootstrap-agent-hooks.sh; no
# Windows machine has run it. See docs/specs/147-repository-layout.md.
#
# Installs the one hook rEngine offers an agent CLI: kimi's SessionStart hook, which reports the
# session the CLI is actually running back to the workspace, so the pane record follows a session
# switch made inside the CLI (spec 127). The change is shown, confirmed, backed up and verified with
# kimi doctor; on any failure the previous configuration is restored.
#
# This is the ONE owner-confirmed edit to a person's global CLI configuration, which is why it is
# shown before it is written and restored the moment the CLI's own doctor objects.
param([string] $Agent = '', [switch] $Yes, [switch] $DryRun, [switch] $Help)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot 'lib\wizard.ps1')

if ($Help) {
    Write-Host @'
bootstrap-agent-hooks.ps1 -Agent kimi [-Yes] [-DryRun]

  -Agent AGENT   the CLI to bootstrap (only kimi is supported; the other CLIs are refused
                 by name with the reason)
  -Yes           do not ask for confirmation (a script tab: answer the prompt instead)
  -DryRun        print the exact change and write nothing

The hook lives in $KIMI_CODE_HOME\config.toml (~\.kimi-code\config.toml) and takes effect for
kimi sessions started afterwards. Removal: restore the printed backup, or delete the marked
block from the config.
'@
    exit 0
}
if (-not $Agent) { $Agent = Read-ReValue -Prompt 'Agent to bootstrap (kimi)' }
switch ($Agent) {
    'kimi'   { }
    'claude' { Write-ReHost "claude needs no bootstrap: the launcher hands it per-launch settings carrying the same hook.`n"; exit 2 }
    default  { Write-ReHost "$Agent has no hook channel rEngine can use; only kimi is bootstrapped this way.`n"; exit 2 }
}

# The reporter is the red-agents binary (F172).
$reporter = ''
if ($env:RENGINE_RED_AGENTS -and (Test-Path -LiteralPath $env:RENGINE_RED_AGENTS)) {
    $reporter = $env:RENGINE_RED_AGENTS
} else {
    foreach ($profile in @('debug', 'release')) {
        $candidate = Join-Path $root "red\target\$profile\red-agents.exe"
        if (Test-Path -LiteralPath $candidate) { $reporter = $candidate; break }
    }
}
if (-not $reporter) {
    Write-ReHost "The red-agents binary is required (run: cargo build -p red-agents, or set RENGINE_RED_AGENTS).`n"
    exit 2
}
# A TOML literal string keeps Windows backslashes intact — which is the whole reason the posix
# original chose one — and the one character it cannot hold is refused rather than escaped.
if ($reporter.Contains("'")) {
    Write-ReHost "Paths containing a single quote cannot be written into a TOML literal string.`n"
    exit 2
}

$kimiHome = $env:KIMI_CODE_HOME
if (-not $kimiHome) { $kimiHome = Join-Path $env:USERPROFILE '.kimi-code' }
$config = Join-Path $kimiHome 'config.toml'
$marker = '# rEngine session reporting (spec 127)'
$hook = @"
$marker
[[hooks]]
event = "SessionStart"
command = '"$reporter" report-session --provider kimi'
"@

Invoke-ReWizard -Title 'rEngine agent hook bootstrap (kimi)' -Total 4

Invoke-ReStage 'Detect the CLI'
if (-not (Get-Command kimi -ErrorAction SilentlyContinue)) {
    Write-ReHost "kimi is not installed. Install it explicitly first (actions\pane\win\agent.ps1 -Agent kimi -Action install, or https://www.kimi.com/code).`n"
    exit 127
}
& kimi --version

Invoke-ReStage 'What changes, and where'
Write-Host "Config: $config"
Write-Host "This block is appended; nothing else in the file is touched:`n"
Write-Host $hook
Write-Host ''
if ((Test-Path -LiteralPath $config) -and (Select-String -LiteralPath $config -SimpleMatch -Pattern $marker -Quiet)) {
    Write-Host 'Already bootstrapped: the rEngine hook block is present. Nothing was written.'
    exit 0
}
if ($DryRun) { Write-Host 'Dry run: nothing was written.'; exit 0 }

Invoke-ReStage 'Confirm'
if ($Yes) {
    Write-Host 'Confirmed with -Yes.'
} elseif (-not (Confirm-ReAction "Append this hook to $config?")) {
    Write-Host 'Left unchanged. Nothing was written.'
    exit 0
}

Invoke-ReStage 'Back up, append, verify with kimi doctor — restoring on any failure'
$backup = ''
if (Test-Path -LiteralPath $config) {
    $backup = "$config.rengine-backup-" + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    Copy-Item -LiteralPath $config -Destination $backup
    Write-Host "Backup: $backup"
}
New-Item -ItemType Directory -Force -Path $kimiHome | Out-Null
Add-Content -LiteralPath $config -Value "`n$hook"
& kimi doctor config $config *> $null
if ($LASTEXITCODE -ne 0) {
    Write-ReHost "kimi doctor rejected the result; restoring the previous configuration.`n"
    if ($backup) { Move-Item -LiteralPath $backup -Destination $config -Force }
    else { Remove-Item -LiteralPath $config -Force }
    exit 1
}
Complete-ReWizard
Write-Host "`nThe hook reports kimi sessions started from now on. Removal: restore the backup above, or delete the marked block from $config."
