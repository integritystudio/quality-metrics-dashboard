#!/usr/bin/env bash
# Packs one slice of the codebase (tests | scripts | worker) into its own bundle.
# Usage: repomix-scoped.sh <scope> [output_file]
set -euo pipefail
source "$(dirname "$0")/repomix-core.sh"

SCOPE_TESTS="tests"
SCOPE_SCRIPTS="scripts"
SCOPE_WORKER="worker"
USAGE="Usage: $0 <$SCOPE_TESTS|$SCOPE_SCRIPTS|$SCOPE_WORKER> [output_file]"

SCOPE="${1:?$USAGE}"
OUTPUT_FILE="${2:-$OUT_DIR/repomix-$SCOPE.xml}"

# Test files: __tests__ dirs (incl. setup/support helpers), Playwright e2e, and any stray *.test/*.spec.
TEST_INCLUDE='["**/__tests__/**", "e2e/**", "**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts"]'
# Base ignore patterns that exclude test files; dropped for the tests scope only.
TEST_IGNORE_REGEX='test|spec|snap|fixtures'
# Code-only scopes drop test dirs too (the base config filters *.test.* but not their helpers).
CODE_ONLY_IGNORE='["**/__tests__/**"]'

case "$SCOPE" in
  "$SCOPE_TESTS")   INCLUDE_JSON="$TEST_INCLUDE" ;;
  "$SCOPE_SCRIPTS") INCLUDE_JSON='["scripts/**/*"]' ;;
  "$SCOPE_WORKER")  INCLUDE_JSON='["worker/**/*"]' ;;
  *) echo "Unknown scope: $SCOPE" >&2; echo "$USAGE" >&2; exit 1 ;;
esac

# removeComments is off: a narrow pack is read for detail, and the comment
# stripper cuts shell from any `#` (including `${VAR#pattern}`), corrupting scripts/*.sh.
SCOPED_CONFIG="$(derive_config "$SCOPE" '
  .include = $include
  | .output.removeComments = false
  | .ignore.customPatterns = (
      if $scope == $testsScope
      then [.ignore.customPatterns[] | select(test($testIgnoreRegex) | not)]
      else (.ignore.customPatterns + $codeOnlyIgnore | unique)
      end
    )
' \
  --arg scope "$SCOPE" \
  --arg testsScope "$SCOPE_TESTS" \
  --arg testIgnoreRegex "$TEST_IGNORE_REGEX" \
  --argjson include "$INCLUDE_JSON" \
  --argjson codeOnlyIgnore "$CODE_ONLY_IGNORE")"

pack "$SCOPED_CONFIG" "$OUTPUT_FILE"
