# DeepSeek Harness desktop launcher.
#
# Packages the exe when needed, then launches it:
#   - no exe yet              -> package, then launch
#   - main.js/package.json newer than the exe -> repackage, then launch
#   - otherwise               -> launch straight away
#
# Usage: double-click start.bat, or `powershell -File start.ps1`.

$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $appDir '..\..')

# The packaged exe locates the repo through this variable.
$env:DSH_REPO_DIR = $repoRoot.Path

$portable = Get-ChildItem (Join-Path $appDir 'release') -Filter 'DeepSeek Harness *.exe' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notlike '*Setup*' -and $_.Name -notlike '*uninstaller*' } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

$needBuild = $null -eq $portable
if (-not $needBuild) {
  foreach ($src in 'main.js', 'package.json') {
    $srcPath = Join-Path $appDir $src
    if ((Get-Item $srcPath).LastWriteTime -gt $portable.LastWriteTime) {
      Write-Host "[dsh-desktop] $src changed since last build"
      $needBuild = $true
    }
  }
}

if ($needBuild) {
  if (-not (Test-Path (Join-Path $appDir 'node_modules\electron'))) {
    Write-Host '[dsh-desktop] installing dependencies...'
    pnpm --dir $repoRoot install --filter dsh-desktop
  }
  Write-Host '[dsh-desktop] packaging (this takes a few minutes)...'
  if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
  }
  pnpm --dir $repoRoot --filter dsh-desktop dist:win
  if ($LASTEXITCODE -ne 0) { throw "packaging failed with exit code $LASTEXITCODE" }
  $portable = Get-ChildItem (Join-Path $appDir 'release') -Filter 'DeepSeek Harness *.exe' |
    Where-Object { $_.Name -notlike '*Setup*' -and $_.Name -notlike '*uninstaller*' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($null -eq $portable) { throw 'packaging finished but no portable exe was produced' }
} else {
  Write-Host '[dsh-desktop] up to date, launching directly.'
}

Write-Host "[dsh-desktop] starting $($portable.Name)"
Start-Process $portable.FullName
