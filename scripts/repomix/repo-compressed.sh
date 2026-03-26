#!/usr/bin/env bash
# Runs repomix --compress and writes docs/repomix/repo-compressed.xml
set -euo pipefail

OUTPUT_FILE="${1:?Usage: $0 <root_dir> <output_file>}"

FORCE_COLOR=0 NO_COLOR=1 timeout 120 \
npx repomix "$ROOT" -c "$CONFIG" --compress -o "$OUTPUT_FILE" >/dev/null 2>&1