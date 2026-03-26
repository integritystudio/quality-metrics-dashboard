#!/usr/bin/env bash
set -euo pipefail

OUTPUT_FILE="${1:?Usage: $0 <output_file>}"

FORCE_COLOR=0 NO_COLOR=1 timeout 120 \
npx repomix "$ROOT" -c "$CONFIG" -o "$OUTPUT_FILE" >/dev/null 2>&1