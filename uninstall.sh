#!/bin/sh
# uninstall.sh — remove the globally installed lark-acp CLI.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/wangmingliang-ms/lark-acp/main/uninstall.sh | sh
#   ./uninstall.sh

set -eu

fail() {
  echo "lark-acp uninstall: $1" >&2
  exit 1
}

command -v npm >/dev/null 2>&1 || fail "npm not found; nothing to uninstall via npm."

echo "lark-acp uninstall: removing global 'lark-acp' ..."
npm rm -g lark-acp
echo "lark-acp uninstall: done."
