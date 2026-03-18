#!/bin/bash
#
# Find duplicate TypeScript/React (.tsx) code constructs using text similarity.
# Self-contained — no Python or tree-sitter dependency.
# Compatible with macOS awk.
#
# Usage:
#   ./scripts/find_duplication_tsx.sh [project_folder] [construct] [min_similarity] [min_lines]
#
# Constructs: component | function | class | hook (default: component)
# min_similarity: 0.0-1.0 Jaccard threshold (default: 0.7)
# min_lines: minimum lines for a construct to be considered (default: 5)
#
# Examples:
#   ./scripts/find_duplication_tsx.sh .
#   ./scripts/find_duplication_tsx.sh . component 0.8
#   ./scripts/find_duplication_tsx.sh . function 0.7 10
#   ./scripts/find_duplication_tsx.sh src hook 0.75 8

set -euo pipefail

PROJECT_FOLDER="${1:-.}"
CONSTRUCT="${2:-component}"
MIN_SIMILARITY="${3:-0.7}"
MIN_LINES="${4:-5}"

# Validate numeric inputs
if ! [[ "$MIN_SIMILARITY" =~ ^[0-9]*\.?[0-9]+$ ]]; then
  echo "Error: min_similarity must be a number between 0.0 and 1.0, got '$MIN_SIMILARITY'"
  exit 1
fi
if ! [[ "$MIN_LINES" =~ ^[0-9]+$ ]]; then
  echo "Error: min_lines must be a positive integer, got '$MIN_LINES'"
  exit 1
fi

if [ ! -d "$PROJECT_FOLDER" ]; then
  echo "Error: directory does not exist: $PROJECT_FOLDER"
  exit 1
fi

# Validate construct type
case "$CONSTRUCT" in
  component|function|class|hook) ;;
  *)
    echo "Error: unknown construct '$CONSTRUCT'. Use: component | function | class | hook"
    exit 1
    ;;
esac

# Resolve to absolute path
PROJECT_FOLDER="$(cd "$PROJECT_FOLDER" && pwd)"

TMPDIR_WORK="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_WORK"' EXIT

CONSTRUCTS_FILE="$TMPDIR_WORK/constructs.tsv"
BODIES_DIR="$TMPDIR_WORK/bodies"
mkdir -p "$BODIES_DIR"

echo "Scanning $PROJECT_FOLDER for TSX $CONSTRUCT constructs (min ${MIN_LINES} lines, similarity >= ${MIN_SIMILARITY})..."
echo ""

# Extract constructs from all .tsx files using a single awk invocation per file.
# macOS awk doesn't support dynamic regex or capture groups, so we use
# construct_type to branch to hardcoded patterns inside awk.
extract_constructs() {
  local file="$1"
  local rel_path="${file#"$PROJECT_FOLDER"/}"

  awk -v construct_type="$CONSTRUCT" -v min_lines="$MIN_LINES" \
      -v rel="$rel_path" -v bodiesdir="$BODIES_DIR" '
  BEGIN { idx = 0; in_block = 0; depth = 0; block = ""; start = 0; name = "" }

  function is_match(line) {
    # component: arrow-function or function-declaration components (PascalCase returning JSX)
    # Matches: export const MyComponent = ..., export default function MyComponent(, function MyComponent(
    if (construct_type == "component")
      return match(line, /^[[:space:]]*(export[[:space:]]+(default[[:space:]]+)?)?((const|let)[[:space:]]+[A-Z][A-Za-z0-9_]*[[:space:]]*[=:]|function[[:space:]]+[A-Z][A-Za-z0-9_]*[[:space:]]*[\(<])/)
    # function: any named function (non-PascalCase) or arrow function assigned to lowercase var
    if (construct_type == "function")
      return match(line, /^[[:space:]]*(export[[:space:]]+(default[[:space:]]+)?)?((const|let|var)[[:space:]]+[a-z_][A-Za-z0-9_]*[[:space:]]*=[[:space:]]*(async[[:space:]]*)?\(|function[[:space:]]+[a-z_][A-Za-z0-9_]*[[:space:]]*\()/)
    # class: any class declaration
    if (construct_type == "class")
      return match(line, /^[[:space:]]*(export[[:space:]]+(default[[:space:]]+)?)?(abstract[[:space:]]+)?class[[:space:]]+[A-Za-z_]/)
    # hook: custom React hooks (use* naming convention)
    if (construct_type == "hook")
      return match(line, /^[[:space:]]*(export[[:space:]]+(default[[:space:]]+)?)?((const|let)[[:space:]]+use[A-Z][A-Za-z0-9_]*[[:space:]]*=|function[[:space:]]+use[A-Z][A-Za-z0-9_]*[[:space:]]*\()/)
    return 0
  }

  {
    if (!in_block && is_match($0)) {
      in_block = 1
      depth = 0
      block = ""
      start = NR
      # Extract name
      name = $0
      if (index(name, "class") > 0 && construct_type == "class") {
        sub(/.*class[[:space:]]+/, "", name)
        sub(/[^A-Za-z0-9_].*/, "", name)
      } else if (construct_type == "hook") {
        # Extract use* identifier (two-step: strip left of "use", then strip right)
        sub(/.*[[:space:]]use/, "use", name)
        sub(/[^A-Za-z0-9_].*/, "", name)
      } else {
        # Component or function: grab identifier after const/let/function
        gsub(/export[[:space:]]+(default[[:space:]]+)?/, "", name)
        if (match(name, /function[[:space:]]+/)) {
          sub(/.*function[[:space:]]+/, "", name)
          sub(/[^A-Za-z0-9_].*/, "", name)
        } else {
          sub(/^[[:space:]]*(const|let|var)[[:space:]]+/, "", name)
          sub(/[^A-Za-z0-9_].*/, "", name)
        }
      }
    }
    if (in_block) {
      block = block "\n" $0
      n_chars = split($0, chars, "")
      for (i = 1; i <= n_chars; i++) {
        if (chars[i] == "{") depth++
        if (chars[i] == "}") depth--
      }
      if (depth <= 0 && index(block, "{") > 0) {
        lines = NR - start + 1
        if (lines >= min_lines) {
          idx++
          # Use a flat filename with underscores
          outname = rel
          gsub(/\//, "__", outname)
          outfile = bodiesdir "/" outname "___" idx ".txt"
          print block > outfile
          close(outfile)
          printf "%s\t%s\t%d\t%d\t%s\n", rel, name, start, NR, outfile
        }
        in_block = 0
        block = ""
      }
    }
  }
  ' "$file"
}

# Find all .tsx files, excluding generated/build dirs
while IFS= read -r -d '' f; do
  extract_constructs "$f"
done < <(find "$PROJECT_FOLDER" -name '*.tsx' \
  -not -path '*/node_modules/*' \
  -not -path '*/dist/*' \
  -not -path '*/build/*' \
  -not -path '*/.next/*' \
  -not -path '*/coverage/*' \
  -not -name '*.d.ts' \
  -not -name '*.test.tsx' \
  -not -name '*.spec.tsx' \
  -print0 | sort -z) >> "$CONSTRUCTS_FILE"

TOTAL=$(wc -l < "$CONSTRUCTS_FILE" | tr -d ' ')
if [ "$TOTAL" -eq 0 ]; then
  echo "No $CONSTRUCT constructs found with >= $MIN_LINES lines."
  exit 0
fi

echo "Found $TOTAL $CONSTRUCT constructs. Comparing pairs..."
echo ""

# Compare pairs using Jaccard similarity on word tokens
awk -F'\t' -v min_sim="$MIN_SIMILARITY" '
{
  n++
  file[n] = $1
  name[n] = $2
  startl[n] = $3
  endl[n] = $4
  bodyfile[n] = $5

  body = ""
  while ((getline line < bodyfile[n]) > 0) {
    body = body " " line
  }
  close(bodyfile[n])

  # Tokenise: split on non-alphanumeric
  gsub(/[^a-zA-Z0-9_]+/, " ", body)
  num = split(body, words, " ")
  delete tokens
  for (i = 1; i <= num; i++) {
    w = tolower(words[i])
    if (length(w) > 1) tokens[w] = 1
  }
  tset = ""
  for (w in tokens) tset = tset " " w
  tokenset[n] = tset
}
END {
  found = 0
  for (i = 1; i <= n; i++) {
    split(tokenset[i], setA, " ")
    delete mapA
    sizeA = 0
    for (k in setA) {
      if (setA[k] != "") { mapA[setA[k]] = 1; sizeA++ }
    }
    for (j = i + 1; j <= n; j++) {
      if (file[i] == file[j] && name[i] == name[j]) continue

      split(tokenset[j], setB, " ")
      sizeB = 0
      intersection = 0
      for (k in setB) {
        if (setB[k] != "") {
          sizeB++
          if (setB[k] in mapA) intersection++
        }
      }
      union_size = sizeA + sizeB - intersection
      if (union_size == 0) continue
      sim = intersection / union_size

      if (sim >= min_sim) {
        found++
        printf "%.0f%% similar:\n", sim * 100
        printf "  A: %s :: %s (lines %d-%d)\n", file[i], name[i], startl[i], endl[i]
        printf "  B: %s :: %s (lines %d-%d)\n", file[j], name[j], startl[j], endl[j]
        printf "\n"
      }
    }
  }
  if (found == 0) {
    printf "No duplicate pairs found above %.0f%% similarity.\n", min_sim * 100
  } else {
    printf "Found %d similar pairs.\n", found
  }
}
' "$CONSTRUCTS_FILE"
