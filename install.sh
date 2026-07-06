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
#   HUMMING_HOME   humming home dir    (default: ~/.humming)
#
# Example:
#   HUMMING_REF=v0.2.0 sh install.sh
#
# What it does: clone (or fast-forward) a persistent checkout at
# <home>/humming-project, build it, and `npm link` so the global `humming`
# symlinks into that checkout's dist/. `humming update` then rebuilds the same
# checkout in place, so upgrades need no reinstall.
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

# Persistent managed checkout under the humming home dir. Cloning here (rather
# than a temp dir) gives `humming update` a real repo to fast-forward, and
# `npm link` (below) points the global bin at this checkout's dist/ so a rebuild
# is reflected immediately — no reinstall. NOTE: the home dir is resolved the
# same way the CLI does EXCEPT `--home` (a CLI-only flag): $HUMMING_HOME, else
# ~/.humming. Set HUMMING_HOME to install into a non-default home.
home_dir="${HUMMING_HOME:-${HOME}/.humming}"
checkout_dir="${home_dir}/humming-project"
clone_url="https://github.com/${REPO}.git"

if [ -d "${checkout_dir}/.git" ]; then
  echo "humming install: updating existing checkout ${checkout_dir} (ref: ${REF}) ..."
  git -C "$checkout_dir" fetch origin || fail "git fetch failed in ${checkout_dir}."
  git -C "$checkout_dir" checkout -f "$REF" || fail "git checkout ${REF} failed."
  git -C "$checkout_dir" reset --hard "origin/${REF}" \
    || fail "git reset --hard origin/${REF} failed."
else
  echo "humming install: cloning ${clone_url} (ref: ${REF}) into ${checkout_dir} ..."
  mkdir -p "$home_dir" || fail "could not create home dir ${home_dir}."
  git clone --branch "$REF" "$clone_url" "$checkout_dir" \
    || fail "git clone failed for ${clone_url} (ref: ${REF})."
fi

echo "humming install: installing dependencies ..."
(cd "$checkout_dir" && npm install --no-audit --no-fund) || fail "npm install failed."

echo "humming install: building ..."
(cd "$checkout_dir" && npm run build) || fail "build failed."

# `npm link` symlinks the global `humming` bin into this checkout's dist/, so
# `humming update` (which rebuilds in place) takes effect without a reinstall.
echo "humming install: linking global command ..."
(cd "$checkout_dir" && npm link) || fail "npm link failed."

echo "humming install: initializing ${home_dir} templates ..."
(cd "$checkout_dir" && node dist/bin/humming.js init) || fail "humming init failed."

if command -v humming >/dev/null 2>&1; then
  echo "humming install: done. Run 'humming --help' to get started."
else
  bin_dir="$(npm prefix -g)/bin"
  echo "humming install: installed, but 'humming' is not on your PATH." >&2
  echo "Add npm's global bin directory to PATH, e.g.:" >&2
  echo "  export PATH=\"${bin_dir}:\$PATH\"" >&2
fi
