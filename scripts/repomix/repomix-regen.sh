#!/usr/bin/env bash
# Wrapper: generates token tree + compressed repomix output
set -euo pipefail

# Verify root repo directory
export ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# Canonicalize ROOT and verify it is a git repository.
ROOT="$(cd "$ROOT" 2>/dev/null && pwd)" \
  || { echo "ROOT does not exist or is not accessible: ${1}" >&2; exit 1; }
if ! git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "ROOT is not a git repository: $ROOT" >&2
  exit 1
fi

# Run from repo root so repomix resolves relative paths correctly
cd "$ROOT"

# input /output directories
INPUT_PATH="scripts/repomix"
OUTPUT_PATH="docs/repomix"
export LOGS_COUNT="${1:-100}"

# optional subdirectory — narrows repomix scan target, prefixes output files
SUBDIR="${2:-}"
FILE_PREFIX=""
if [[ -n "$SUBDIR" ]]; then
  if [[ ! -d "$ROOT/$SUBDIR" ]]; then
    echo "Subdirectory does not exist: $ROOT/$SUBDIR" >&2
    exit 1
  fi
  FILE_PREFIX="$(basename "$SUBDIR")-"
fi

# file names
TREE_FILE="token-tree"
COMPRESSED_FILE="repo-compressed"
LOSSLESS_FILE="repomix"
DOCS_ONLY_FILE="repomix-docs"
GIT_RANKED_FILE="repomix-git-ranked"
DIFF_SUMMARY_STEM="diff-summary"
GIT_TOP_20="gitlog-top20"
GIT_RANKED="repomix-git-ranked"
CONFIG_FILE="repomix.config.json"

# output/input dirs use repo root (before ROOT override)
SUBDIR_SUFFIX=""
if [[ -n "$SUBDIR" ]]; then
  SUBDIR_SUFFIX="/$(basename "$SUBDIR")"
fi
export OUT_DIR="$ROOT/$OUTPUT_PATH${SUBDIR_SUFFIX}"
export INPUT_DIR="$ROOT/$INPUT_PATH"
export CONFIG="$INPUT_DIR/$CONFIG_FILE"

# output absolute filepaths (prefixed when subdirectory is set)
TOKEN_TREE_FILE="$OUT_DIR/${FILE_PREFIX}$TREE_FILE.txt"
COMPRESSED_REPO_FILE="$OUT_DIR/${FILE_PREFIX}$COMPRESSED_FILE.xml"
LOSSLESS_REPO_FILE="$OUT_DIR/${FILE_PREFIX}$LOSSLESS_FILE.xml"
DOCS_ONLY_REPO_FILE="$OUT_DIR/${FILE_PREFIX}$DOCS_ONLY_FILE.xml"
GIT_RANKED_REPO_FILE="$OUT_DIR/${FILE_PREFIX}$GIT_RANKED_FILE.xml"
GITLOG_TOP_FILE="$OUT_DIR/${FILE_PREFIX}$GIT_TOP_20.txt"
DIFF_SUMMARY_FILE="$OUT_DIR/${FILE_PREFIX}$DIFF_SUMMARY_STEM.xml"

# narrow ROOT to subdirectory for repomix scan target
if [[ -n "$SUBDIR" ]]; then
  export ROOT="$ROOT/$SUBDIR"
fi
TOKEN_TREE_SCRIPT="$INPUT_DIR/$TREE_FILE.sh"
COMPRESS_SCRIPT="$INPUT_DIR/$COMPRESSED_FILE.sh"
LOSSLESS_SCRIPT="$INPUT_DIR/$LOSSLESS_FILE.sh"
DOCS_ONLY_SCRIPT="$INPUT_DIR/$DOCS_ONLY_FILE.sh"
GIT_RANKED_SCRIPT="$INPUT_DIR/$GIT_RANKED.sh"
DIFF_SUMMARY_SCRIPT="$INPUT_DIR/$DIFF_SUMMARY_STEM.sh"

echo "File set up..."
# make output dir if not exists
mkdir -p "$OUT_DIR"

# delete only the artifacts this wrapper regenerates
rm -f \
  "$TOKEN_TREE_FILE" \
  "$COMPRESSED_REPO_FILE" \
  "$LOSSLESS_REPO_FILE" \
  "$DOCS_ONLY_REPO_FILE" \
  "$GIT_RANKED_REPO_FILE" \
  "$GITLOG_TOP_FILE" \
  "$DIFF_SUMMARY_FILE"

# project-level logging
PROJECT_DIR="$(basename "$ROOT")"
# relative filepaths (for display)
DISPLAY_PATH="$OUTPUT_PATH${SUBDIR_SUFFIX}"
TREE_FILE="$DISPLAY_PATH/${FILE_PREFIX}$TREE_FILE.txt"
COMPRESSED_FILE_NAME="$DISPLAY_PATH/${FILE_PREFIX}$COMPRESSED_FILE.xml"
LOSSLESS_FILE_NAME="$DISPLAY_PATH/${FILE_PREFIX}$LOSSLESS_FILE.xml"
DOCS_ONLY_FILE_NAME="$DISPLAY_PATH/${FILE_PREFIX}$DOCS_ONLY_FILE.xml"
GIT_RANKED_FILE_NAME="$DISPLAY_PATH/${FILE_PREFIX}$GIT_RANKED_FILE.xml"
GITLOG_TOP_FILE_NAME="$DISPLAY_PATH/${FILE_PREFIX}$GIT_TOP_20.txt"
DIFF_SUMMARY_REL="$DISPLAY_PATH/${FILE_PREFIX}$DIFF_SUMMARY_STEM.xml"


echo "Generating token count tree for $PROJECT_DIR at $TREE_FILE"
bash "$TOKEN_TREE_SCRIPT" "$TOKEN_TREE_FILE"
echo "Success!"
echo

echo "Generating compressed repomix file for $PROJECT_DIR at $COMPRESSED_FILE_NAME"
bash "$COMPRESS_SCRIPT" "$COMPRESSED_REPO_FILE"
echo "Success!"
echo

echo "Generating repomix file for $PROJECT_DIR at $LOSSLESS_FILE_NAME"
bash "$LOSSLESS_SCRIPT" "$LOSSLESS_REPO_FILE"
echo "Success!"
echo

echo "Generating docs-only repomix file for $PROJECT_DIR at $DOCS_ONLY_FILE_NAME"
bash "$DOCS_ONLY_SCRIPT" "$DOCS_ONLY_REPO_FILE"
echo "Success!"
echo

echo "Generating git-ranked repomix file for $PROJECT_DIR at $GIT_RANKED_FILE_NAME"
bash "$GIT_RANKED_SCRIPT" "$GIT_RANKED_REPO_FILE"
echo "Success!"
echo

echo "Generating top-file git history at $GITLOG_TOP_FILE_NAME"
(
  cd "$ROOT"
  bash "$DIFF_SUMMARY_SCRIPT" "$GITLOG_TOP_FILE"
)
echo "Success!"
echo

echo "Artifacts:"

print_artifact() {
  local file_path="$1"
  local display_name="$2"

  if [[ -f "$file_path" ]]; then
    chars=$(wc -c < "$file_path" | tr -d ' ')
    tokens=$((chars / 4))
    echo " - $display_name (~$tokens tokens, $chars chars)"
  else
    echo " - $display_name (missing)"
  fi
}

print_artifact "$TOKEN_TREE_FILE" "$TREE_FILE"
print_artifact "$COMPRESSED_REPO_FILE" "$COMPRESSED_FILE_NAME"
print_artifact "$LOSSLESS_REPO_FILE" "$LOSSLESS_FILE_NAME"
print_artifact "$DOCS_ONLY_REPO_FILE" "$DOCS_ONLY_FILE_NAME"
print_artifact "$GIT_RANKED_REPO_FILE" "$GIT_RANKED_FILE_NAME"
print_artifact "$GITLOG_TOP_FILE" "$GITLOG_TOP_FILE_NAME"
