# UNVERIFIED on Windows as of 2026-09-16. Written from actions/posix/lib/wizard.sh; no Windows
# machine has run it. See docs/specs/147-repository-layout.md and the feature row it names.
#
# The wizard conventions, in PowerShell. Adapted from the selected wizard template;
# license/provenance: .claude/skills/wizard/.
#
# PowerShell 5.1 ONLY — the qualification host has no pwsh 7. No `??`, no ternary, no
# `ForEach-Object -Parallel`. A native command's exit code is read from $LASTEXITCODE rather than
# trusted to throw, because $PSNativeCommandUseErrorActionPreference does not exist in 5.1.
#
# Every message goes to the HOST rather than the success stream. A dashboard action's stdout is the
# thing the pane shows and, for a capture action, the thing it parses — so prompts and progress must
# not travel on it. That is what `>&2` is doing in the posix original.

$script:ReWizardTotal = 0
$script:ReWizardStage = 0

function Write-ReHost([string] $Text) { [Console]::Error.Write($Text) }

function Invoke-ReWizard {
    param([Parameter(Mandatory)][string] $Title, [Parameter(Mandatory)][int] $Total)
    if ($Total -lt 1) { Write-ReHost "Invalid stage count`n"; exit 2 }
    $script:ReWizardTotal = $Total
    $script:ReWizardStage = 0
    Write-ReHost "`n$Title ($Total stages)`n"
}

function Invoke-ReStage {
    param([Parameter(Mandatory)][string] $Title)
    $script:ReWizardStage++
    if ($script:ReWizardStage -gt $script:ReWizardTotal) { Write-ReHost "Too many stages`n"; exit 2 }
    Write-ReHost "`n[$($script:ReWizardStage)/$($script:ReWizardTotal)] $Title`n"
}

# A value this action cannot proceed without. Refused rather than defaulted when there is no human
# to ask: a wizard that invents an answer is a wizard nobody can trust with an irreversible step.
function Read-ReValue {
    param([Parameter(Mandatory)][string] $Prompt, [switch] $Secret)
    if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
        Write-ReHost "Missing required input: $Prompt. Supply an explicit argument.`n"
        exit 2
    }
    Write-ReHost "${Prompt}: "
    if ($Secret) {
        $secure = Read-Host -AsSecureString
        Write-ReHost "`n"
        $value = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    } else {
        $value = Read-Host
    }
    if ([string]::IsNullOrEmpty($value)) { Write-ReHost "A value is required`n"; exit 2 }
    return $value
}

# Confirmation with no non-interactive bypass, by design: the two actions that use it end a person's
# sessions, and a flag that skipped the question would be the first thing a script reached for.
function Confirm-ReAction {
    param([Parameter(Mandatory)][string] $Question)
    if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
        Write-ReHost "Human confirmation required: $Question`n"
        exit 2
    }
    Write-ReHost "$Question [y/N]: "
    $reply = Read-Host
    return @('y', 'Y', 'yes', 'YES') -contains $reply
}

# Run a native command, announce it, and propagate its failure. `exit` rather than `throw`, so the
# action's exit code is the child's and a dashboard reading it sees what actually happened.
function Invoke-ReRun {
    param([Parameter(Mandatory)][string] $Label,
          [Parameter(Mandatory)][string] $Command,
          [string[]] $Arguments = @())
    Write-ReHost "$Label`n"
    & $Command @Arguments
    $status = $LASTEXITCODE
    if ($status -ne 0) {
        Write-ReHost "Failed ($status): $Label`n"
        exit $status
    }
}

function Complete-ReWizard {
    if ($script:ReWizardStage -ne $script:ReWizardTotal) {
        Write-ReHost "Incomplete procedure ($($script:ReWizardStage)/$($script:ReWizardTotal))`n"
        exit 2
    }
    Write-ReHost "`nCompleted $($script:ReWizardTotal) stages.`n"
}

# The launcher this checkout built. Resolved the way every other component here resolves a sibling —
# an explicit variable, then release, then debug — because a baked path names one profile and is
# wrong for the other.
function Get-ReLaunch {
    param([Parameter(Mandatory)][string] $Checkout)
    if ($env:RENGINE_RED_LAUNCH -and (Test-Path -LiteralPath $env:RENGINE_RED_LAUNCH)) {
        return $env:RENGINE_RED_LAUNCH
    }
    foreach ($profile in @('release', 'debug')) {
        $candidate = Join-Path $Checkout "red\target\$profile\red-launch.exe"
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    Write-ReHost "red-launch is required and this checkout has none: build it with`n  cargo build --manifest-path red/Cargo.toml --bins`n"
    exit 2
}
