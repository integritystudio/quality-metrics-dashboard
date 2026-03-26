#!/usr/bin/env bash
# Runs repomix with docs-only include rules and writes a docs-focused XML bundle.
set -euo pipefail

OUTPUT_FILE="${1:-$OUT_DIR/repomix-docs.xml}"
CONFIG_FILE="$INPUT_DIR/repomix-docs.config.json"
BASE_CONFIG_FILE="$INPUT_DIR/repomix.config.json"
TMP_CONFIG="$(mktemp "${TMPDIR:-/tmp}/repomix-docs.XXXXXX.json")"

cleanup() {
  rm -f "$TMP_CONFIG"
}
trap cleanup EXIT

BUNDLE_IGNORE_PATTERNS_JSON="$(
  jq -c '
    [.ignore.customPatterns[]? | select(test("repomix|repo-compressed"))] | unique
  ' "$BASE_CONFIG_FILE"
)"

jq \
  --argjson bundleIgnorePatterns "$BUNDLE_IGNORE_PATTERNS_JSON" \
  '
    .ignore.customPatterns = ((.ignore.customPatterns // []) + $bundleIgnorePatterns | unique)
  ' \
  "$CONFIG_FILE" > "$TMP_CONFIG"

FORCE_COLOR=0 NO_COLOR=1 timeout 120 \
npx repomix "$ROOT" -c "$TMP_CONFIG" -o "$OUTPUT_FILE" >/dev/null 2>&1
