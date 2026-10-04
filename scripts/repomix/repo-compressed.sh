#!/usr/bin/env bash
# Same file set as repomix.sh, reduced to tree-sitter signatures by --compress.
set -euo pipefail
source "$(dirname "$0")/repomix-core.sh"

pack "$CONFIG" "${1:-$OUT_DIR/repo-compressed.xml}" --compress
