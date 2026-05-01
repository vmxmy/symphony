#!/usr/bin/env bash
set -eo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required. Install it from https://bun.sh/" >&2
  exit 1
fi

cd "$repo_root"
make setup
