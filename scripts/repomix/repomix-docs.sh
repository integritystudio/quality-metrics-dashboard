#!/usr/bin/env bash
# Packs docs/ with its own config: docs share no include or ignore rules with the code packs.
set -euo pipefail
source "$(dirname "$0")/repomix-core.sh"

pack "$INPUT_DIR/repomix-docs.config.json" "${1:-$OUT_DIR/repomix-docs.xml}"
