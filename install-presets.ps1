# Install the presets in this folder into the local DeepSeek Harness home.
#
# Usage from PowerShell:
#   .\install-presets.ps1
#   .\install-presets.ps1 -Presets warmupbetter
#   .\install-presets.ps1 -DshHome D:\other-dsh-home
#   .\install-presets.ps1 -Update
#
# Existing target directories are skipped by default, never overwritten.
# Pass -Update to refresh an existing installation: the old preset directory
# is backed up under <DshHome>\.agent-presets-backup\ before the source files
# are copied over it. Files that only exist in the destination are kept.

[CmdletBinding()]
param(
    [string[]]$Presets = @('warmupbetter', 'warmupbetter-replay'),
    [string]$DshHome = $env:DSH_HOME,
    [switch]$Update
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
        if (-not $Update) {
            Write-Warning "skip existing preset: $dst (run with -Update to overwrite)"
            continue
        }
        $backupRoot = Join-Path $DshHome '.agent-presets-backup'
        New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
        $backup = Join-Path $backupRoot "$name-$stamp"
        Write-Host "backing up: $dst -> $backup"
        Copy-Item -Path $dst -Destination $backup -Recurse
        Write-Host "updating: $name -> $dst"
        Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force
        continue
    }
    Copy-Item -Path $src -Destination $dst -Recurse
    Write-Host "installed: $name -> $dst"
}

if ($Update) {
    Write-Host 'Done. Restart dsh, then repair any existing session histories:'
    Write-Host '  node .\repair-warmup-sessions.mjs --dry-run'
    Write-Host '  node .\repair-warmup-sessions.mjs'
} else {
    Write-Host 'Done. Restart dsh, create a NEW session, and select the installed preset.'
}
