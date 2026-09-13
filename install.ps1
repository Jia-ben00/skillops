# SkillOps - one-line installer for Windows (PowerShell 5.1+)
# Usage:
#   irm https://raw.githubusercontent.com/Jia-ben00/skillops/main/install.ps1 | iex
#   or:  powershell -ExecutionPolicy Bypass -File install.ps1
# Options (env vars): SKILLOPS_VERSION, SKILLOPS_HOME, SKILLOPS_URL (mirror), SKILLOPS_NO_PATH
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Version = if ($env:SKILLOPS_VERSION) { $env:SKILLOPS_VERSION } else { '0.5.0' }
$Dest    = if ($env:SKILLOPS_HOME)  { $env:SKILLOPS_HOME }  else { Join-Path $HOME '.skillops-cli' }
$BinDir  = Join-Path $Dest 'bin'
$PkgDir  = Join-Path $Dest 'package'
$Zip     = Join-Path $env:TEMP "skillops-cli-$Version.zip"
$ShaFile = "$Zip.sha256"

New-Item -ItemType Directory -Force -Path $Dest | Out-Null

# 1) Download: SKILLOPS_URL mirror > GitHub release asset > npm registry fallback
$Primary = if ($env:SKILLOPS_URL) {
  $env:SKILLOPS_URL
} else {
  "https://github.com/Jia-ben00/skillops/releases/download/v$Version/skillops-cli-$Version.zip"
}
Write-Host "Downloading $Primary ..."
try {
  Invoke-WebRequest -Uri $Primary -OutFile $Zip -UseBasicParsing
  try { Invoke-WebRequest -Uri "$Primary.sha256" -OutFile $ShaFile -UseBasicParsing } catch { Remove-Item $ShaFile -ErrorAction SilentlyContinue }
} catch {
  Write-Host "GitHub release asset not found, falling back to npm registry ..."
  Invoke-WebRequest -Uri "https://registry.npmjs.org/skillops-cli/-/skillops-cli-$Version.tgz" -OutFile $Zip -UseBasicParsing
  # npm registry serves .tgz; rename so Expand-Zip keeps working
  if ($Zip -notlike '*.zip') { $Zip = [System.IO.Path]::ChangeExtension($Zip, 'zip') }
}

# 2) Verify sha256 when the .sha256 sidecar is present
if (Test-Path $ShaFile) {
  $Expected = (Get-Content $ShaFile | Select-Object -First 1).Trim().Split(' ')[0]
  $Actual   = (Get-FileHash $Zip -Algorithm SHA256).Hash.ToLower()
  if ($Expected -ne $Actual) { throw "sha256 mismatch: expected $Expected, got $Actual" }
  Write-Host "sha256 OK: $Actual"
}

# 3) Extract with .NET (no tar dependency on Windows)
if (Test-Path $PkgDir) { Remove-Item $PkgDir -Recurse -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Dest)
if (-not (Test-Path (Join-Path $Dest 'package.json'))) {
  $Inner = Get-ChildItem $Dest -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } | Select-Object -First 1
  if ($Inner -and $Inner.FullName -ne $PkgDir) { Rename-Item $Inner.FullName $PkgDir }
}

# 4) Launcher script (node must be on PATH)
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Launcher = Join-Path $BinDir 'skillops.cmd'
@"
@echo off
node "%~dp0..\package\src\cli.js" %*
"@ | Set-Content -Path $Launcher -Encoding ASCII

# 5) Add to user PATH (applies to NEW terminals). Set SKILLOPS_NO_PATH=1 to skip.
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($UserPath -notlike "*$BinDir*" -and -not $env:SKILLOPS_NO_PATH) {
  [Environment]::SetEnvironmentVariable('Path', "$BinDir;$UserPath", 'User')
  Write-Host "Added $BinDir to your user PATH (new terminals only)."
}

Write-Host ""
Write-Host "SkillOps v$Version installed to $Dest"
Write-Host "Open a NEW terminal and run:  skillops doctor"
