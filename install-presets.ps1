# Install the presets in this folder into the local DeepSeek Harness home.
#
# Usage from PowerShell:
#   .\install-presets.ps1
#   .\install-presets.ps1 -Presets warmupbetter
#   .\install-presets.ps1 -DshHome D:\other-dsh-home
#
# Existing target directories are skipped, never overwritten.

[CmdletBinding()]
param(
    [string[]]$Presets = @('warmupbetter', 'warmupbetter-replay'),
    [string]$DshHome = $env:DSH_HOME
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if ([string]::IsNullOrWhiteSpace($DshHome)) {
    $DshHome = Join-Path $HOME '.dsh'
}

$presetRoot = Join-Path $DshHome '.agent-presets'
New-Item -ItemType Directory -Force -Path $presetRoot | Out-Null

foreach ($name in $Presets) {
    $src = Join-Path $scriptDir $name
    if (-not (Test-Path (Join-Path $src 'agent.cordis.yml'))) {
        throw "preset not found in this folder: $src"
    }
    $dst = Join-Path $presetRoot $name
    if (Test-Path $dst) {
        Write-Warning "skip existing preset: $dst (remove it first to overwrite)"
        continue
    }
    Copy-Item -Path $src -Destination $dst -Recurse
    Write-Host "installed: $name -> $dst"
}

Write-Host 'Done. Restart dsh, create a NEW session, and select the installed preset.'
