#!/usr/bin/env bash
# Reads docs/repomix/token-count-tree.txt and updates the
# "## Project Structure" section in README.md with a condensed view.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TREE_PATH="$ROOT/docs/repomix/token-count-tree.txt"
README_PATH="$ROOT/README.md"
MAX_SHOWN=5

if [ ! -f "$TREE_PATH" ]; then
  echo "Missing $TREE_PATH" >&2
  exit 1
fi

# Extract total tokens from first line
total_tokens=$(head -1 "$TREE_PATH" | grep -oE '[0-9,]+ tokens' | cut -d' ' -f1)
if [ -z "$total_tokens" ]; then
  total_tokens="unknown"
fi

# Build condensed tree via awk
condensed=$(awk -v max="$MAX_SHOWN" '
function is_file(line) {
  return (line ~ /\.[a-zA-Z0-9]+[[:space:]]+\([0-9,]+[[:space:]]+tokens\)/) && (line !~ /\/[[:space:]]+\(/)
}
function connector_pos(line,   i, c) {
  for (i = 1; i <= length(line); i++) {
    c = substr(line, i, 3)
    if (c == "├" || c == "└") return i
  }
  return -1
}
function get_tokens(line,   s, p) {
  p = match(line, /\([0-9,]+[[:space:]]+tokens\)/)
  if (!p) return 0
  s = substr(line, RSTART + 1, RLENGTH - 2)
  sub(/[[:space:]]+tokens/, "", s)
  gsub(/,/, "", s)
  return int(s)
}
{
  lines[NR] = $0
}
END {
  i = 1
  while (i <= NR) {
    if (!is_file(lines[i])) {
      print lines[i]
      i++
      continue
    }
    cp = connector_pos(lines[i])
    # Collect consecutive file siblings at same connector position
    n = 0
    while (i <= NR && is_file(lines[i]) && connector_pos(lines[i]) == cp) {
      n++
      sib_line[n] = lines[i]
      sib_tok[n] = get_tokens(lines[i])
      i++
    }
    if (n > max) {
      # Find top MAX_SHOWN by token count (selection via sorted indices)
      for (j = 1; j <= n; j++) rank[j] = j
      for (j = 1; j <= n; j++) {
        for (k = j+1; k <= n; k++) {
          if (sib_tok[rank[k]] > sib_tok[rank[j]]) {
            tmp = rank[j]; rank[j] = rank[k]; rank[k] = tmp
          }
        }
      }
      # Mark top entries
      for (j = 1; j <= n; j++) keep[j] = 0
      for (j = 1; j <= max; j++) keep[rank[j]] = 1
      # Print kept entries in original order, replacing └ with ├
      for (j = 1; j <= n; j++) {
        if (keep[j]) {
          line = sib_line[j]
          gsub(/└── /, "├── ", line)
          print line
        }
      }
      remaining = n - max
      # Build prefix from first sibling up to connector
      prefix = substr(sib_line[1], 1, cp - 1)
      gsub(/[├└]/, "│", prefix)
      # Check if more entries follow at this level
      has_more = (i <= NR && connector_pos(lines[i]) == cp) ? 1 : 0
      conn = has_more ? "├" : "└"
      print prefix conn "── ... (" remaining " more)"
      # Cleanup
      for (j = 1; j <= n; j++) { delete sib_line[j]; delete sib_tok[j]; delete keep[j] }
      delete rank
    } else {
      for (j = 1; j <= n; j++) {
        print sib_line[j]
        delete sib_line[j]; delete sib_tok[j]
      }
    }
  }
}
' "$TREE_PATH")

# Find section boundaries in README
section_line=$(grep -n "^## Project Structure" "$README_PATH" | head -1 | cut -d: -f1)
if [ -z "$section_line" ]; then
  echo 'Could not find "## Project Structure" in README.md' >&2
  exit 1
fi

# Find the fenced code block after the heading
fence_open=$(awk -v start="$section_line" 'NR > start && /^```$/ { print NR; exit }' "$README_PATH")
fence_close=$(awk -v start="$fence_open" 'NR > start && /^```$/ { print NR; exit }' "$README_PATH")

if [ -z "$fence_open" ] || [ -z "$fence_close" ]; then
  echo "Could not find fenced code block under Project Structure" >&2
  exit 1
fi

# Splice: head up to (not including) section heading, new heading, condensed tree, tail after fence close
{
  head -n "$((section_line - 1))" "$README_PATH"
  echo "## Project Structure (${total_tokens} tokens)"
  echo ""
  echo '```'
  echo "$condensed"
  echo '```'
  tail -n "+$((fence_close + 1))" "$README_PATH"
} > "$README_PATH.tmp"

mv "$README_PATH.tmp" "$README_PATH"
