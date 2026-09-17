# UNVERIFIED on Windows as of 2026-09-17. Written from actions/posix/grant-session-message.sh; no
# Windows machine has run it. See docs/specs/147-repository-layout.md and F223.
#
# Arm ONE agent pane so another agent may say one line to it, for a counted number of messages and a
# bounded stretch of time (F222, spec 148). This is the permission the project token deliberately is
# not: the token transfers to a contester on silence, so an agent can hold it without anyone acting,
# and relaying into somebody's conversation needs a person to have said so about a named pane.
#
# The confirmation here has NO non-interactive bypass, on purpose: no -Yes, and a prompt that
# refuses outright when there is no terminal to ask. Open it as a script tab and answer it.
# Taking it back: -Revoke, or let it expire. Stopping a relay that is already armed also works
# through the token and through stop_session, and the keyboard is never gated at all.
param(
    [string] $State = '',
    [string] $Session = '',
    [string] $Messages = '',
    [string] $Minutes = '',
    [switch] $Revoke,
    [switch] $List,
    [switch] $Help
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot 'lib\wizard.ps1')

function Show-Usage {
    Write-ReHost @'
grant-session-message.ps1 [-State DIR] [-Session ID] [-Messages N] [-Minutes M] [-Revoke] [-List]

Lets another agent of this project say one line to one named agent pane, for at most N messages
and at most M minutes, whichever runs out first. Nothing is relayable before this is answered.

  -State DIR      the workspace state directory (default: $env:RENGINE_STATE_DIR)
  -Session ID     the pane to arm, as the Sessions list reports it
  -Messages N     how many lines may be said to it (1-50)
  -Minutes M      how long the grant lasts (1-720)
  -Revoke         take the grant back; the pane goes back to refusing
  -List           show what is armed right now and change nothing
  -Help           this text

What an armed pane still refuses: a line with a control character in it, a line over 400
characters, a pane that is mid-turn, a pane somebody has typed into in the last minute, and any
caller that does not also hold the project token. Every delivery is one frame on the project feed.

'@
}

if ($Help) { Show-Usage; exit 0 }

if (-not $State) { $State = $env:RENGINE_STATE_DIR }
if (-not $State) { $State = Read-ReValue -Prompt 'Workspace state directory' }
if (-not (Test-Path -LiteralPath $State -PathType Container)) {
    Write-ReHost "State directory is unavailable: $State`n"
    exit 2
}
$launch = Get-ReLaunch -Checkout $root

# --list changes nothing, so it answers before the wizard and before any prompt.
if ($List) {
    & $launch @('message-grant', '--state', $State, '--list')
    exit $LASTEXITCODE
}

Invoke-ReWizard -Title 'Relay a message to an agent pane' -Total 3

Invoke-ReStage 'What is armed now'
Invoke-ReRun 'Read the grants' $launch @('message-grant', '--state', $State, '--list')

if (-not $Session) { $Session = Read-ReValue -Prompt 'Pane to arm (session id)' }

# `Confirm-ReAction` already separates the two outcomes the posix original separates by hand: a
# person declining answers $false and writes nothing, and a run with nobody to ask exits 2 from
# inside the prompt. A caller can read neither as "granted".
if ($Revoke) {
    Invoke-ReStage 'Confirm'
    Write-Host "The grant for pane $Session will be taken back. Nothing may be relayed to it afterwards."
    if (-not (Confirm-ReAction 'Revoke it now?')) {
        Write-Host 'Left as it was.'
        exit 0
    }
    Invoke-ReStage 'Revoke'
    Invoke-ReRun 'Revoke' $launch @('message-grant', '--state', $State, '--session', $Session, '--revoke')
    Complete-ReWizard
    exit 0
}

if (-not $Messages) { $Messages = Read-ReValue -Prompt 'How many messages may be said to it (1-50)' }
if (-not $Minutes) { $Minutes = Read-ReValue -Prompt 'For how many minutes (1-720)' }

Invoke-ReStage 'Confirm'
Write-Host 'Another agent of this project, holding the project token, will be able to type one printable'
Write-Host "line into pane $Session and have it submitted once the pane echoes it back."
Write-Host "At most $Messages message(s), for at most $Minutes minute(s), whichever runs out first."
Write-Host 'Every delivery is on the project feed. Revoke with -Revoke; your own keyboard is never gated.'
if (-not (Confirm-ReAction 'Grant it now?')) {
    Write-Host 'Not granted. The pane still refuses every relay.'
    exit 0
}

Invoke-ReStage 'Grant'
Invoke-ReRun 'Grant' $launch @('message-grant', '--state', $State, '--session', $Session, '--messages', $Messages, '--minutes', $Minutes)
Complete-ReWizard
Write-Host ''
Write-Host 'This tab retains the log. Run it again with -List to see what is armed, or -Revoke to take it back.'
