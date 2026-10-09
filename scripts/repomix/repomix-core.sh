#!/usr/bin/env bash
# Shared core for the repomix pack scripts — sourced, not executed.
# The defaults fill in what repomix-regen.sh would otherwise export, so every
# pack script is also standalone-callable.

REPOMIX_CORE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$REPOMIX_CORE_DIR/../.." && pwd)"
DEFAULT_TIMEOUT_SECONDS=120

ROOT="${ROOT:-$PROJECT_ROOT}"
INPUT_DIR="${INPUT_DIR:-$REPOMIX_CORE_DIR}"
OUT_DIR="${OUT_DIR:-$PROJECT_ROOT/docs/repomix}"
CONFIG="${CONFIG:-$INPUT_DIR/repomix.config.json}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-$DEFAULT_TIMEOUT_SECONDS}"

REPOMIX_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/repomix.XXXXXX")"
trap 'rm -rf "$REPOMIX_TMP_DIR"' EXIT

# derive_config <name> <jq_filter> [jq args...]
# Writes CONFIG transformed by the filter to a temp file (removed on exit) and prints its path.
derive_config() {
  local name="$1" filter="$2"
  shift 2
  local derived="$REPOMIX_TMP_DIR/$name.json"
  jq "$@" "$filter" "$CONFIG" > "$derived" && echo "$derived"
}

# repomix_run <config> <output_file> [repomix flags...]
# Runs from the project root so the docs pack's instructionFilePath (CLAUDE.md) resolves; console output on stdout.
repomix_run() {
  local config="$1" output_file="$2"
  shift 2
  mkdir -p "$(dirname "$output_file")"
  (
    cd "$PROJECT_ROOT" || exit
    FORCE_COLOR=0 NO_COLOR=1 timeout "$TIMEOUT_SECONDS" \
      npx repomix "$ROOT" -c "$config" -o "$output_file" "$@" 2>&1
  )
}

# pack <config> <output_file> [repomix flags...] — repomix_run, silent.
pack() {
  repomix_run "$@" >/dev/null
}
