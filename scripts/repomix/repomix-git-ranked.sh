#!/usr/bin/env bash
# Base file set ranked by change frequency over the last SORT_COMMITS commits,
# with working-tree diffs and the last LOG_COMMITS commit messages appended.
set -euo pipefail
source "$(dirname "$0")/repomix-core.sh"

SORT_COMMITS=50
LOG_COMMITS=100

GIT_RANKED_CONFIG="$(derive_config git-ranked '
  .output.style = "xml"
  | .output.git += {
      sortByChangesMaxCommits: $sortCommits,
      includeDiffs: true,
      includeLogs: true,
      includeLogsCount: $logCommits
    }
' --argjson sortCommits "$SORT_COMMITS" --argjson logCommits "$LOG_COMMITS")"

pack "$GIT_RANKED_CONFIG" "${1:-$OUT_DIR/repomix-git-ranked.xml}"
