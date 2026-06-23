$ErrorActionPreference = "Stop"

function Get-EnvOrDefault($Name, $Default) {
  $Value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $Default
  }
  return $Value
}

function Write-Clawser($Message) {
  Write-Host "clawser " -ForegroundColor Cyan -NoNewline
  Write-Host $Message
}

function Fail($Message) {
  Write-Host "clawser " -ForegroundColor Red -NoNewline
  Write-Host $Message
  exit 1
}

function Require-Command($Command) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    Fail "missing required command: $Command"
  }
}

$RepoUrl = Get-EnvOrDefault "CLAWSER_REPO_URL" "https://github.com/agilecho2022-lgtm/clawser.git"
$Branch = Get-EnvOrDefault "CLAWSER_BRANCH" "main"
$InstallDir = Get-EnvOrDefault "CLAWSER_INSTALL_DIR" (Join-Path $HOME ".clawser-src")
$BinDir = Get-EnvOrDefault "CLAWSER_BIN_DIR" (Join-Path $HOME ".local\bin")

Require-Command "git"
Require-Command "node"

$NodeVersion = (& node -p "process.versions.node").Trim()
$Parts = $NodeVersion.Split(".")
$Major = [int]$Parts[0]
$Minor = [int]$Parts[1]
if (($Major -lt 22) -or (($Major -eq 22) -and ($Minor -lt 12))) {
  Fail "Node.js 22.12+ is required; current version is v$NodeVersion"
}

if (-not (Get-Command "pnpm" -ErrorAction SilentlyContinue)) {
  if (Get-Command "corepack" -ErrorAction SilentlyContinue) {
    Write-Clawser "pnpm not found; enabling pnpm with corepack"
    & corepack enable pnpm | Out-Null
  }
}
Require-Command "pnpm"

if (-not (Test-Path $InstallDir)) {
  Write-Clawser "cloning $RepoUrl#$Branch"
  & git clone --branch $Branch $RepoUrl $InstallDir
} else {
  if (-not (Test-Path (Join-Path $InstallDir ".git"))) {
    Fail "$InstallDir exists but is not a git checkout"
  }
  Write-Clawser "updating $InstallDir"
  & git -C $InstallDir fetch origin $Branch
  & git -C $InstallDir checkout $Branch
  & git -C $InstallDir reset --hard "origin/$Branch"
}

Write-Clawser "installing dependencies"
& pnpm -C $InstallDir install --frozen-lockfile

Write-Clawser "building"
& pnpm -C $InstallDir build

Write-Clawser "linking clawser into $BinDir"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$CmdPath = Join-Path $BinDir "clawser.cmd"
$EntryPath = Join-Path $InstallDir "clawser.mjs"
Set-Content -Path $CmdPath -Encoding ASCII -Value "@echo off`r`nnode `"$EntryPath`" %*`r`n"

& node $EntryPath --help | Out-Null

Write-Clawser "installed successfully"
Write-Clawser "source: $InstallDir"
Write-Clawser "binary: $CmdPath"

$PathParts = $env:Path.Split(";")
if ($PathParts -notcontains $BinDir) {
  Write-Host "clawser $BinDir is not on PATH for this shell" -ForegroundColor Yellow
  Write-Host "clawser add it to your user PATH, then reopen PowerShell" -ForegroundColor Yellow
}
