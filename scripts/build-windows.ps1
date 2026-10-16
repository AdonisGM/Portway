# Build Portway for Windows (x64) and collect the installer in release\<version>\.
# Needs Node.js 24+, pnpm, Rust (rustup) and the Visual Studio C++ Build Tools.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

foreach ($cmd in 'pnpm', 'cargo', 'node') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "Missing command: $cmd" }
}

$conf = Get-Content 'src-tauri\tauri.conf.json' -Raw | ConvertFrom-Json
$version = $conf.version
$out = Join-Path (Get-Location) "release\$version"

Write-Host "==> Build $($conf.productName) $version (Windows x64)"
pnpm install --frozen-lockfile
if ($LASTEXITCODE) { exit $LASTEXITCODE }
pnpm tauri build --bundles nsis
if ($LASTEXITCODE) { exit $LASTEXITCODE }

Write-Host "==> Collecting output in release\$version"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null
# The bundle folder keeps installers of earlier builds: take only this version's.
$installers = Get-ChildItem 'src-tauri\target\release\bundle\nsis' -Filter "*_$($version)_*.exe"
if (-not $installers) { throw "No installer for $version in src-tauri\target\release\bundle\nsis" }
$installers | Copy-Item -Destination $out

Write-Host ''
Write-Host "Done. Files are in: $out"
Get-ChildItem $out
