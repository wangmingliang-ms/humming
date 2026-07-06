#Requires -Version 5.1
<#
.SYNOPSIS
  Remove the globally installed humming CLI.
.EXAMPLE
  irm https://raw.githubusercontent.com/wangmingliang-ms/humming/main/uninstall.ps1 | iex
.EXAMPLE
  ./uninstall.ps1
#>

$ErrorActionPreference = 'Stop'

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host "humming uninstall: npm not found; nothing to uninstall via npm."
  exit 1
}

Write-Host "humming uninstall: removing global 'humming' ..."
npm rm -g humming-agent
if ($LASTEXITCODE -ne 0) {
  Write-Host "humming uninstall: npm rm failed (exit $LASTEXITCODE)."
  exit 1
}
Write-Host "humming uninstall: done."
