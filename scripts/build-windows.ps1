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
pnpm tauri build --bundles nsis

Write-Host "==> Collecting output in release\$version"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null
Copy-Item 'src-tauri\target\release\bundle\nsis\*.exe' $out

Write-Host ''
Write-Host "Done. Files are in: $out"
Get-ChildItem $out
