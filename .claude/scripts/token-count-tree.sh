#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <output-filepath>" >&2
  exit 1
fi

npx repomix --token-count-tree --no-file-summary --no-directory-structure -o /dev/null 2>&1 \
  | sed -n '/^└──/,/^$/p' \
  | sed '/^$/d' > "$1"
