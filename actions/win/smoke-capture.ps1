# UNVERIFIED on Windows as of 2026-09-16. Written from actions/posix/smoke-capture.sh; no Windows
# machine has run it. See docs/specs/147-repository-layout.md.
#
# Capture the desktop's smoke frame as a PNG on stdout for the dashboard's capture action.
# NOTHING but the PNG may reach stdout, so the desktop's own output goes to the error stream — and
# the PNG is written as BYTES, because PowerShell's pipeline would otherwise encode it as text.
param([string] $Renderer = '')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root
. (Join-Path $PSScriptRoot 'lib\wizard.ps1')

$binary = $env:RENGINE_NATIVE_BINARY
if (-not $binary) { $binary = '.cache\desktop\bin\Release\rengine.exe' }
if (-not (Test-Path -LiteralPath $binary)) {
    Write-ReHost "Build the desktop first (.\editor.bat --bootstrap-only).`n"
    exit 2
}
$shot = [IO.Path]::Combine([IO.Path]::GetTempPath(), "rengine-smoke-$PID.bmp")
try {
    $shotArgs = @()
    if ($Renderer) { $shotArgs += @('--renderer', $Renderer) }
    $shotArgs += @('--smoke-test', '--snapshot', $shot)
    & $binary @shotArgs 2>&1 | ForEach-Object { Write-ReHost "$_`n" }
    if ($LASTEXITCODE -ne 0) { Write-ReHost "the desktop did not produce a frame ($LASTEXITCODE)`n"; exit $LASTEXITCODE }
    $python = (Get-Command python -ErrorAction SilentlyContinue)
    if (-not $python) { $python = Get-Command python3 -ErrorAction SilentlyContinue }
    if (-not $python) { Write-ReHost "python is required to convert the frame`n"; exit 2 }
    # Straight to the raw stdout handle: Out-Host and the pipeline both mangle binary.
    $png = & $python.Source 'tools/bmp_to_png.py' $shot 2
    [Console]::OpenStandardOutput().Write($png, 0, $png.Length)
} finally {
    if (Test-Path -LiteralPath $shot) { Remove-Item -LiteralPath $shot -Force }
}
