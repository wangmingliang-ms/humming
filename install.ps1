#Requires -Version 5.1
<#
.SYNOPSIS
  Install the humming CLI globally straight from GitHub.
.DESCRIPTION
  Overrides via environment variables:
    HUMMING_REPO   GitHub owner/repo   (default: wangmingliang-ms/humming)
    HUMMING_REF    git branch or tag   (default: main)
    HUMMING_HOME   humming home dir    (default: ~/.humming)

  What it does: clone (or fast-forward) a persistent checkout at
  <home>/humming-project, build it, and `npm link` so the global `humming`
  symlinks into that checkout's dist/. `humming update` then rebuilds the same
  checkout in place, so upgrades need no reinstall.

  Why clone+build instead of `npm i -g git+https://...`:
    npm's git-dependency prepare sandbox runs this package's `prepare` build
    (tsc) against a node_modules whose .bin/tsc is not executable, so the build
    dies with "tsc: Permission denied". Cloning and building in a normal working
    directory sidesteps that sandbox entirely.
.EXAMPLE
  irm https://raw.githubusercontent.com/wangmingliang-ms/humming/main/install.ps1 | iex
.EXAMPLE
  ./install.ps1
#>

$ErrorActionPreference = 'Stop'

$repo = if ($env:HUMMING_REPO) { $env:HUMMING_REPO } else { 'wangmingliang-ms/humming' }
$ref = if ($env:HUMMING_REF) { $env:HUMMING_REF } else { 'main' }
$minNodeMajor = 20

function Fail($msg) {
  # Write-Host (not Write-Error) so a piped `irm | iex` run prints a clean
  # one-line message and exits with code 1, instead of a red terminating-error
  # record that the interactive host may swallow.
  Write-Host "humming install: $msg"
  exit 1
}

$tools = [ordered]@{
  git  = 'Install git first: https://git-scm.com/downloads'
  node = "Install Node.js >= ${minNodeMajor}: https://nodejs.org/"
  npm  = 'npm ships with Node.js: https://nodejs.org/'
}
foreach ($cmd in $tools.Keys) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Fail "$cmd not found. $($tools[$cmd])"
  }
}

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt $minNodeMajor) {
  Fail "Node.js >= $minNodeMajor required, found $(node --version)."
}

# Persistent managed checkout under the humming home dir. Cloning here (rather
# than a temp dir) gives `humming update` a real repo to fast-forward, and
# `npm link` (below) points the global bin at this checkout's dist/ so a rebuild
# is reflected immediately — no reinstall. NOTE: the home dir is resolved the
# same way the CLI does EXCEPT `--home` (a CLI-only flag): $HUMMING_HOME, else
# ~/.humming. Set HUMMING_HOME to install into a non-default home.
$homeDir = if ($env:HUMMING_HOME) { $env:HUMMING_HOME } else { Join-Path $HOME '.humming' }
$checkoutDir = Join-Path $homeDir 'humming-project'
$cloneUrl = "https://github.com/$repo.git"

if (Test-Path (Join-Path $checkoutDir '.git')) {
  Write-Host "humming install: updating existing checkout $checkoutDir (ref: $ref) ..."
  git -C $checkoutDir fetch origin
  if ($LASTEXITCODE -ne 0) { Fail "git fetch failed in $checkoutDir." }
  git -C $checkoutDir checkout -f $ref
  if ($LASTEXITCODE -ne 0) { Fail "git checkout $ref failed." }
  git -C $checkoutDir reset --hard "origin/$ref"
  if ($LASTEXITCODE -ne 0) { Fail "git reset --hard origin/$ref failed." }
}
else {
  Write-Host "humming install: cloning $cloneUrl (ref: $ref) into $checkoutDir ..."
  New-Item -ItemType Directory -Path $homeDir -Force | Out-Null
  git clone --branch $ref $cloneUrl $checkoutDir
  if ($LASTEXITCODE -ne 0) { Fail "git clone failed for $cloneUrl (ref: $ref)." }
}

Push-Location $checkoutDir
try {
  Write-Host "humming install: installing dependencies ..."
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Fail "npm install failed." }

  Write-Host "humming install: building ..."
  npm run build
  if ($LASTEXITCODE -ne 0) { Fail "build failed." }

  # `npm link` symlinks the global `humming` bin into this checkout's dist/, so
  # `humming update` (which rebuilds in place) takes effect without a reinstall.
  Write-Host "humming install: linking global command ..."
  npm link
  if ($LASTEXITCODE -ne 0) { Fail "npm link failed." }

  Write-Host "humming install: initializing $homeDir templates ..."
  node dist/bin/humming.js init
  if ($LASTEXITCODE -ne 0) { Fail "humming init failed." }
}
finally {
  Pop-Location
}

if (Get-Command humming -ErrorAction SilentlyContinue) {
  Write-Host "humming install: done. Run 'humming --help' to get started."
}
else {
  $prefix = (npm prefix -g).Trim()
  Write-Warning "humming installed, but 'humming' is not on your PATH."
  Write-Warning "Add npm's global bin directory to PATH: $prefix"
}
