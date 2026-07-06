#!/bin/sh
# uninstall.sh — remove the globally installed humming CLI.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/wangmingliang-ms/humming/main/uninstall.sh | sh
#   ./uninstall.sh

set -eu

fail() {
  echo "humming uninstall: $1" >&2
  exit 1
}

command -v npm >/dev/null 2>&1 || fail "npm not found; nothing to uninstall via npm."

echo "humming uninstall: removing global 'humming' ..."
npm rm -g humming-agent
echo "humming uninstall: done."
