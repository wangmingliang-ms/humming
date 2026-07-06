#!/bin/sh
# install.sh — install the humming CLI globally straight from GitHub.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/wangmingliang-ms/humming/main/install.sh | sh
#   ./install.sh
#
# Overrides (environment variables):
#   HUMMING_REPO   GitHub owner/repo   (default: wangmingliang-ms/humming)
#   HUMMING_REF    git branch or tag   (default: main)
#
# Example:
#   HUMMING_REF=v0.2.0 sh install.sh
#
# Why clone+build instead of `npm i -g git+https://...`:
#   npm's git-dependency prepare sandbox runs this package's `prepare` build
#   (tsc) against a node_modules whose .bin/tsc is not executable, so the build
#   dies with "tsc: Permission denied". Cloning and building in a normal working
#   directory sidesteps that sandbox entirely.

set -eu

REPO="${HUMMING_REPO:-wangmingliang-ms/humming}"
REF="${HUMMING_REF:-main}"
MIN_NODE_MAJOR=20

fail() {
  echo "humming install: $1" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git not found. Install git first: https://git-scm.com/downloads"
command -v node >/dev/null 2>&1 || fail "node not found. Install Node.js >= ${MIN_NODE_MAJOR}: https://nodejs.org/"
command -v npm >/dev/null 2>&1 || fail "npm not found. It ships with Node.js: https://nodejs.org/"

node_major="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
  fail "Node.js >= ${MIN_NODE_MAJOR} required, found $(node --version)."
fi

# Clone into a temp dir, build there, install a real copy globally, then clean up.
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/humming-install.XXXXXX")"
# shellcheck disable=SC2064
trap "rm -rf \"$work_dir\"" EXIT INT TERM

repo_dir="${work_dir}/humming"
clone_url="https://github.com/${REPO}.git"

echo "humming install: cloning ${clone_url} (ref: ${REF}) ..."
git clone --depth 1 --branch "$REF" "$clone_url" "$repo_dir" \
  || fail "git clone failed for ${clone_url} (ref: ${REF})."

echo "humming install: installing dependencies ..."
(cd "$repo_dir" && npm install --no-audit --no-fund) || fail "npm install failed."

echo "humming install: building ..."
(cd "$repo_dir" && npm run build) || fail "build failed."

# --install-links forces npm to copy the package instead of symlinking it into
# the temp dir (which the trap removes on exit). Without it the global bin would
# dangle the moment this script finishes.
echo "humming install: installing globally ..."
(cd "$repo_dir" && npm install -g --install-links .) || fail "global install failed."

echo "humming install: initializing ~/.humming templates ..."
(cd "$repo_dir" && node dist/bin/humming.js init) || fail "humming init failed."

if command -v humming >/dev/null 2>&1; then
  echo "humming install: done. Run 'humming --help' to get started."
else
  bin_dir="$(npm prefix -g)/bin"
  echo "humming install: installed, but 'humming' is not on your PATH." >&2
  echo "Add npm's global bin directory to PATH, e.g.:" >&2
  echo "  export PATH=\"${bin_dir}:\$PATH\"" >&2
fi
