#!/usr/bin/env bash
# Runs repomix --token-count-tree and writes docs/repomix/token-count-tree.txt
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TREE_OUTPUT_PATH="$ROOT/docs/repomix/token-count-tree.txt"

raw=$(NO_COLOR=1 timeout 60 npx repomix --token-count-tree --no-files -o /dev/null 2>/dev/null)

tree_lines=$(echo "$raw" | grep '[├└]')
if [ -z "$tree_lines" ]; then
  echo "Could not find token count tree in repomix output" >&2
  exit 1
fi

echo "$tree_lines" > "$TREE_OUTPUT_PATH"
