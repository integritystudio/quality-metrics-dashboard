#!/usr/bin/env bash
set -euo pipefail

# Sync Supabase secrets from Doppler to the dashboard Workers.
# Usage:
#   doppler run --project integrity-studio --config prd -- npm run deploy:secrets      # both production Workers
#   doppler run --project integrity-studio --config dev -- npm run deploy:secrets:dev  # quality-metrics-api-dev
#
# The dev Worker has its own Supabase project, so each target takes its values from
# the matching Doppler config only; a mismatch (e.g. prd values to the dev Worker)
# exits before anything is written, as does a missing secret.
#
# Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in Doppler

TARGET="${1:-prd}"
SECRETS=("SUPABASE_URL" "SUPABASE_SERVICE_ROLE_KEY")
EXIT_USAGE=2

case "$TARGET" in
  prd) WORKERS=("obs-toolkit-quality-metrics-api" "quality-metrics-api") ;;
  dev) WORKERS=("quality-metrics-api-dev") ;;
  *)
    echo "Unknown target '${TARGET}' (expected prd or dev)" >&2
    exit "$EXIT_USAGE"
    ;;
esac

if [ "${DOPPLER_CONFIG:-}" != "$TARGET" ]; then
  echo "Target '${TARGET}' needs Doppler config '${TARGET}', got '${DOPPLER_CONFIG:-unset}'" >&2
  exit "$EXIT_USAGE"
fi

for secret in "${SECRETS[@]}"; do
  if [ -z "${!secret:-}" ]; then
    echo "${secret} is not set in Doppler config '${TARGET}'; nothing written" >&2
    exit "$EXIT_USAGE"
  fi
done

for worker in "${WORKERS[@]}"; do
  # [env.dev] in wrangler.toml names the dev Worker, so dev selects it by environment.
  if [ "$TARGET" = "dev" ]; then
    target_flags=(--env dev)
  else
    target_flags=(--name "$worker")
  fi
  echo "==> Syncing secrets to ${worker}"
  for secret in "${SECRETS[@]}"; do
    if ! output=$(printf '%s\n' "${!secret}" | npx wrangler secret put "$secret" "${target_flags[@]}" 2>&1); then
      echo "$output" >&2
      echo "FAILED: ${secret} on ${worker}. Workers listed above it are already updated; re-run to finish." >&2
      exit 1
    fi
    echo "  ${secret}: $(printf '%s\n' "$output" | tail -1)"
  done
done

echo "Done."
