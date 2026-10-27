#!/usr/bin/env sh
# wranglerwho installer — installs the CLI globally via npm.
# Usage:  curl -fsSL https://raw.githubusercontent.com/dazecoop/wranglerwho/main/install.sh | sh
set -e

if ! command -v node >/dev/null 2>&1; then
  echo "wranglerwho needs Node.js 18+ — install it from https://nodejs.org first." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found (it ships with Node.js)." >&2
  exit 1
fi

echo "Installing wranglerwho globally via npm..."
npm install -g wranglerwho
echo "Done.  Run:  wranglerwho"
