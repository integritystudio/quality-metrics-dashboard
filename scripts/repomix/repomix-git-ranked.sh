#!/usr/bin/env bash
# Generate a repomix bundle ranked by file change frequency using git metadata.
# Output is restricted to files that appear in the selected commit window.
set -euo pipefail

TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-120}"
OUTPUT_FILE="${1}"
GIT_CONFIG="$INPUT_DIR/repomix.git-ranked.json"

REPOMIX_EXIT=0
FORCE_COLOR=0 NO_COLOR=1 timeout "$TIMEOUT_SECONDS" \
  npx repomix "$ROOT" -c "$GIT_CONFIG" -o "$OUTPUT_FILE" 2>&1 \
  || REPOMIX_EXIT=$?
