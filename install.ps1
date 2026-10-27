# wranglerwho installer for Windows — installs the CLI globally via npm.
# Usage:  irm https://raw.githubusercontent.com/dazecoop/wranglerwho/main/install.ps1 | iex
$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "wranglerwho needs Node.js 18+ — install it from https://nodejs.org first."
  exit 1
}

Write-Host "Installing wranglerwho globally via npm..."
npm install -g wranglerwho
Write-Host "Done.  Run:  wranglerwho"
