# UNVERIFIED on Windows as of 2026-09-16. Written from actions/posix/integrate-project.sh; no
# Windows machine has run it. See docs/specs/147-repository-layout.md.
#
# Scaffolds a project that is adopting rEngine: pins rEngine as a submodule, installs the editor.sh
# launching point, writes .rengine/project.json and copies the declaration test. Existing files are
# REPORTED AND SKIPPED, never overwritten — a person's own edits outrank this wizard's idea of a
# starting point. Recipe and follow-ups: docs/runbooks/project-integration.md (spec 077).
#
# The declaration this writes is contract 2 or 3, so its dashboard action names a `script` PATH.
# That is correct and not an oversight: contract 9's name-invocation is rEngine's own, and a
# scaffolded project adopts it when it is ready to carry actions/<platform>/ of its own.
param(
    [string] $Project = '', [string] $Name = '', [string] $RengineUrl = '', [string] $Pin = '',
    [string] $Contract = '', [string] $GameTitle = '', [string] $GameExe = '',
    [string] $GameSurface = 'external', [switch] $NoSubmodule, [switch] $DryRun, [switch] $Help
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot 'lib\wizard.ps1')
$templates = Join-Path $root 'templates\project'

if ($Help) {
    Write-Host @'
integrate-project.ps1 -Project ABS_DIR -Name NAME [options]

  -Project ABS_DIR      the consumer checkout (an existing git repository)
  -Name NAME            the project name in the declaration and dashboard title
  -RengineUrl URL       submodule URL (default: this checkout's origin remote)
  -Pin SHA              submodule commit (default: this checkout's HEAD)
  -Contract 1|2|3       declaration contract to write (default: 3 with a game, else 2)
  -GameTitle TITLE      game toolbar label, at most 32 characters (contract 3)
  -GameExe REL          root-relative game executable, e.g. build/my-game (contract 3)
  -GameSurface KIND     external (default), embedded or cooperative
  -NoSubmodule          skip the submodule stage (offline scaffolding, existing pin)
  -DryRun               print every command as "+ ..." and write nothing
'@
    exit 0
}
if (-not $Project) { $Project = Read-ReValue -Prompt 'Absolute project directory' }
if (-not $Name)    { $Name    = Read-ReValue -Prompt 'Project name' }
if (-not [IO.Path]::IsPathRooted($Project) -or -not (Test-Path -LiteralPath $Project -PathType Container)) {
    Write-ReHost "Provide an existing absolute project directory`n"; exit 2
}
if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$') {
    Write-ReHost "Invalid name ${Name}: use letters, digits, space, dot, underscore or dash`n"; exit 2
}
if ($GameExe -or $GameTitle) {
    if (-not $Contract) { $Contract = '3' }
    if ($Contract -ne '3') { Write-ReHost "A games array requires -Contract 3`n"; exit 2 }
    if (-not ($GameExe -and $GameTitle)) { Write-ReHost "Declare both -GameTitle and -GameExe`n"; exit 2 }
    if ($GameTitle -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._():+-]{0,31}$') { Write-ReHost "Invalid game title: at most 32 plain characters`n"; exit 2 }
    if ($GameExe -notmatch '^[A-Za-z0-9._][A-Za-z0-9._/-]*$' -or $GameExe.Contains('..')) { Write-ReHost "The game executable must be a root-relative path`n"; exit 2 }
    if ($GameSurface -eq 'sdl2-interpose') { Write-ReHost "Game surface sdl2-interpose is retired: use embedded, which hosts the frames in the game tab by injecting the SDL2 adapter`n"; exit 2 }
    if (@('external','embedded','cooperative') -notcontains $GameSurface) { Write-ReHost "Game surface must be embedded, external or cooperative`n"; exit 2 }
}
if (-not $Contract) { $Contract = '2' }
if (@('1','2','3') -notcontains $Contract) { Write-ReHost "Contract must be 1, 2 or 3`n"; exit 2 }
if (-not $NoSubmodule) {
    if (-not $RengineUrl) { $RengineUrl = (& git -C $root remote get-url origin 2>$null) }
    if (-not $RengineUrl) { $RengineUrl = Read-ReValue -Prompt 'rEngine submodule URL' }
    if (-not $Pin) { $Pin = (& git -C $root rev-parse HEAD 2>$null) }
    if (-not $Pin) { $Pin = Read-ReValue -Prompt 'rEngine pin (full commit SHA present on the remote)' }
    if ($RengineUrl -notmatch '^[A-Za-z0-9._:/@~%+-]+$') { Write-ReHost "Invalid rEngine URL`n"; exit 2 }
    if ($Pin -notmatch '^[0-9a-f]{7,40}$') { Write-ReHost "Invalid pin: use a commit SHA`n"; exit 2 }
}

function Invoke-ReDo { param([string] $Label, [string] $Command, [string[]] $Arguments)
    if ($DryRun) { Write-Host "+ $Command $($Arguments -join ' ')"; return }
    Invoke-ReRun -Label $Label -Command $Command -Arguments $Arguments
}
function Install-ReFile { param([string] $Source, [string] $Relative)
    $dest = Join-Path $Project $Relative
    if (Test-Path -LiteralPath $dest) { Write-ReHost "exists, skipped: $Relative`n"; return }
    if ($DryRun) { Write-Host "+ copy $Source $dest"; return }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Copy-Item -LiteralPath $Source -Destination $dest
    Write-ReHost "installed: $Relative`n"
}
function Get-ReGameId {
    $base = ($GameExe -split '/')[-1].ToLowerInvariant()
    return (($base -replace '[^a-z0-9]+', '-').Trim('-'))
}
function Get-ReDeclaration {
    $d = [ordered]@{ contract = [int] $Contract; project = $Name }
    $d.formats = @( [ordered]@{ id = 'example-format'; title = 'Example format (replace this record)'
                                match = @('*.example'); modes = @('raw'); default = 'raw' } )
    if ($Contract -eq '3' -and $GameExe) {
        $candidates = @($GameExe)
        $base = $GameExe -replace '^build/', ''
        if ($GameExe.StartsWith('build/') -and -not $base.Contains('/')) { $candidates += "build/Release/$base" }
        $d.games = @( [ordered]@{ id = (Get-ReGameId); title = $GameTitle; executable = $candidates; surface = $GameSurface } )
    }
    if ($Contract -ne '1') {
        $d.dashboard = [ordered]@{ title = $Name; groups = @( [ordered]@{
            id = 'quick-start'; title = 'Quick start'; actions = @( [ordered]@{
                id = 'editor-check'
                title = 'Editor prerequisites (editor.sh --check)'
                description = 'Reports the toolchain and build state of the pinned rEngine without changing anything.'
                kind = 'script'; script = 'editor.sh'; args = @('--check') } ) } ) }
    }
    return ($d | ConvertTo-Json -Depth 8)
}

Invoke-ReWizard -Title "Integrate $Name with rEngine" -Total 5

Invoke-ReStage 'Verify the project and the rEngine pin'
& git -C $Project rev-parse --git-dir *> $null
if ($LASTEXITCODE -ne 0) { Write-ReHost "Not a git repository: $Project`n"; exit 2 }
if (-not (Test-Path -LiteralPath $templates -PathType Container)) { Write-ReHost "Missing templates: $templates`n"; exit 2 }
Write-ReHost "project $Project is a git repository`n"
if ($NoSubmodule) {
    Write-ReHost "submodule stage disabled (-NoSubmodule)`n"
} else {
    $refs = & git ls-remote --quiet $RengineUrl 2>$null
    if ($LASTEXITCODE -ne 0) { Write-ReHost "Cannot reach $RengineUrl`n"; exit 2 }
    if ($refs -match "^$Pin") { Write-ReHost "pin $Pin is advertised by $RengineUrl`n" }
    else { Write-ReHost "warning: pin $Pin is not a current ref tip on $RengineUrl; the submodule checkout will confirm it`n" }
}

Invoke-ReStage 'Pin rEngine as a submodule at third_party/rengine'
if ($NoSubmodule) {
    Write-ReHost "skipped: third_party/rengine (-NoSubmodule)`n"
} elseif (Test-Path -LiteralPath (Join-Path $Project 'third_party\rengine\.git')) {
    Write-ReHost "exists, skipped: third_party/rengine (bump the pin from the project instead)`n"
} else {
    Invoke-ReDo 'Add the submodule' 'git' @('-C', $Project, 'submodule', 'add', $RengineUrl, 'third_party/rengine')
    Invoke-ReDo 'Check out the pin' 'git' @('-C', (Join-Path $Project 'third_party\rengine'), 'checkout', '--detach', $Pin)
    # rEngine carries the curated packs as submodules of its own, so a project that stops at one
    # level gets an empty third_party/iklib and a build that fails on a missing header rather than
    # on a missing dependency.
    Invoke-ReDo 'Check out what rEngine carries' 'git' @('-C', (Join-Path $Project 'third_party\rengine'), 'submodule', 'update', '--init', '--recursive')
    Invoke-ReDo 'Record the pinned gitlink' 'git' @('-C', $Project, 'add', 'third_party/rengine')
}

Invoke-ReStage 'Install the editor.sh launching point'
Install-ReFile -Source (Join-Path $templates 'editor.sh') -Relative 'editor.sh'

Invoke-ReStage 'Write the .rengine/project.json declaration'
$declaration = Join-Path $Project '.rengine\project.json'
if (Test-Path -LiteralPath $declaration) {
    Write-ReHost "exists, skipped: .rengine/project.json`n"
} elseif ($DryRun) {
    Write-Host '+ write .rengine/project.json'
} else {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $declaration) | Out-Null
    Set-Content -LiteralPath $declaration -Value (Get-ReDeclaration) -Encoding UTF8
    Write-ReHost "installed: .rengine/project.json (contract $Contract)`n"
}

Invoke-ReStage 'Copy the declaration test'
Install-ReFile -Source (Join-Path $templates 'test_rengine_project_decl.py') -Relative 'tests\test_rengine_project_decl.py'

Complete-ReWizard
Write-Host @'
Follow-ups this wizard deliberately leaves to the project:
  1. Register tests/test_rengine_project_decl.py with the project's own test runner.
  2. Add one line to CLAUDE.md/AGENTS.md naming ./editor.sh as the launching point.
  3. Replace the placeholder format: write the CLI that produces previews and declare it
     in .rengine/project.json with ${file}/${entry} argv.
  4. Fill the dashboard groups (quick start, device, distribution) with the project's scripts.
  5. Add any further game targets to the "games" array by hand (unique kebab-case ids); the
     multi-record reference is templates/project/project.json.
  6. Run ./editor.sh --check, then ./editor.sh to open the project window.
Recipe: docs/runbooks/project-integration.md
'@
