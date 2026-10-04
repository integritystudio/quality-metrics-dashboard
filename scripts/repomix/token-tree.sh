#!/usr/bin/env bash
# Writes the "Token Count Tree" section of repomix's console output to OUTPUT_FILE.
set -euo pipefail
source "$(dirname "$0")/repomix-core.sh"

OUTPUT_FILE="${1:-$OUT_DIR/token-tree.txt}"
# --token-count-tree still writes a pack; send it to a temp sink, not output.filePath.
SINK_FILE="$REPOMIX_TMP_DIR/token-tree-sink.xml"

repomix_run "$CONFIG" "$SINK_FILE" --token-count-tree --no-files --no-file-summary \
  | tr -d '\r' \
  | sed -E 's/\x1B\[[0-9;]*[A-Za-z]//g' \
  | awk 'BEGIN{keep=0} /^🔢 Token Count Tree:/{keep=1} /^🔎 Security Check:/{keep=0} keep' \
  > "$OUTPUT_FILE"
