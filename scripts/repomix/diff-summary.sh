#!/usr/bin/env bash
set -euo pipefail

N=20
COMMITS="${LOGS_COUNT:-100}"
OUT="${1:-${OUT_DIR}/gitlog-top${N}.txt}"

mkdir -p "$(dirname "$OUT")"

# Get Top-N tracked files by blob size (bytes)
# Get Top-N tracked files by blob size (bytes) without xargs (macOS-safe)
TOP_FILES=()
while IFS= read -r f; do
  [[ -n "$f" ]] && TOP_FILES+=("$f")
done < <(
  git ls-files -z \
  | while IFS= read -r -d '' f; do
      sz="$(git cat-file -s ":$f" 2>/dev/null || echo 0)"
      printf '%s\t%s\n' "$sz" "$f"
    done \
  | sort -nr \
  | head -n "$N" \
  | cut -f2-
)

# Log: commit header + filenames (no statuses), only for those Top-N files
git log -n "$COMMITS" \
  --date=short \
  --pretty='format:%h %ad %s' \
  --name-only \
  -- "${TOP_FILES[@]}" \
| awk '
    NF==0 { print ""; next }
    /^[0-9a-f]{7,40} / { print; next }
    { print "  " $0 }
  ' > "$OUT"

echo "Wrote: $OUT"