#!/usr/bin/env bash
# Packs src/, scripts/, worker/ and e2e/ with the base config.
set -euo pipefail
source "$(dirname "$0")/repomix-core.sh"

pack "$CONFIG" "${1:-$OUT_DIR/repomix.xml}"
