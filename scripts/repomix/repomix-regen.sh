#!/usr/bin/env bash
# Regenerates every repomix artifact into docs/repomix/.
# Usage: repomix-regen.sh [logs_count] [subdir]
#   logs_count — commits read by diff-summary.sh (its default when omitted)
#   subdir     — narrows the scan target; artifacts go to docs/repomix/<subdir>/ with a <subdir>- prefix
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_PATH="docs/repomix"
CHARS_PER_TOKEN=4

if ! git -C "$PROJECT_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "ROOT is not a git repository: $PROJECT_ROOT" >&2
  exit 1
fi
cd "$PROJECT_ROOT"

if [[ -n "${1:-}" ]]; then
  export LOGS_COUNT="$1"
fi

SUBDIR="${2:-}"
FILE_PREFIX=""
DISPLAY_PATH="$OUTPUT_PATH"
export ROOT="$PROJECT_ROOT"
if [[ -n "$SUBDIR" ]]; then
  if [[ ! -d "$PROJECT_ROOT/$SUBDIR" ]]; then
    echo "Subdirectory does not exist: $PROJECT_ROOT/$SUBDIR" >&2
    exit 1
  fi
  FILE_PREFIX="$(basename "$SUBDIR")-"
  DISPLAY_PATH="$OUTPUT_PATH/$(basename "$SUBDIR")"
  ROOT="$PROJECT_ROOT/$SUBDIR"
fi
export OUT_DIR="$PROJECT_ROOT/$DISPLAY_PATH"
PROJECT_DIR="$(basename "$ROOT")"

GENERATED=()

# generate <description> <artifact name> <script> [script args...]
# Replaces one artifact; the output path is passed as the script's last argument.
generate() {
  local description="$1" name="$2" script="$3"
  shift 3
  local display="$DISPLAY_PATH/$FILE_PREFIX$name"
  local output="$OUT_DIR/$FILE_PREFIX$name"

  echo "Generating $description for $PROJECT_DIR at $display"
  rm -f "$output"
  bash "$SCRIPT_DIR/$script" "$@" "$output"
  GENERATED+=("$display")
  echo "Success!"
  echo
}

# git-ranked runs FIRST: it includes working-tree diffs, so running it after the
# other artifacts packs their just-rewritten diffs (and its own) as ~56% noise.
generate "git-ranked repomix file" repomix-git-ranked.xml repomix-git-ranked.sh
generate "token count tree" token-tree.txt token-tree.sh
generate "compressed repomix file" repo-compressed.xml repo-compressed.sh
generate "repomix file" repomix.xml repomix.sh
generate "docs-only repomix file" repomix-docs.xml repomix-docs.sh
for scope in tests scripts worker; do
  generate "$scope-only repomix file" "repomix-$scope.xml" repomix-scoped.sh "$scope"
done
generate "top-file git history" gitlog-top20.txt diff-summary.sh

echo "Artifacts:"
for display in "${GENERATED[@]}"; do
  file_path="$PROJECT_ROOT/$display"
  if [[ -f "$file_path" ]]; then
    chars=$(wc -c < "$file_path" | tr -d ' ')
    echo " - $display (~$((chars / CHARS_PER_TOKEN)) tokens, $chars chars)"
  else
    echo " - $display (missing)"
  fi
done
