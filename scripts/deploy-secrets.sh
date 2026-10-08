#!/usr/bin/env bash
set -euo pipefail

# Sync Supabase secrets from Doppler to the dashboard Workers.
# Usage:
#   doppler run --project integrity-studio --config prd -- npm run deploy:secrets      # both production Workers
#   doppler run --project integrity-studio --config dev -- npm run deploy:secrets:dev  # quality-metrics-api-dev
#
# The dev Worker has its own Supabase project, so each target takes its values from
# the matching Doppler config only; a mismatch (e.g. prd values to the dev Worker)
# exits before anything is written.
#
# Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in Doppler

TARGET="${1:-prd}"
SECRETS=("SUPABASE_URL" "SUPABASE_SERVICE_ROLE_KEY")

case "$TARGET" in
  prd)
    # One `wrangler secret put` argument list per Worker.
    WORKER_ARGS=("--name obs-toolkit-quality-metrics-api" "--name quality-metrics-api")
    ;;
  dev)
    # [env.dev] in wrangler.toml names the Worker (quality-metrics-api-dev).
    WORKER_ARGS=("--env dev")
    ;;
  *)
    echo "Unknown target '${TARGET}' (expected prd or dev)" >&2
    exit 2
    ;;
esac

if [ "${DOPPLER_CONFIG:-}" != "$TARGET" ]; then
  echo "Target '${TARGET}' needs Doppler config '${TARGET}', got '${DOPPLER_CONFIG:-unset}'" >&2
  exit 2
fi

for worker_args in "${WORKER_ARGS[@]}"; do
  echo "==> Syncing secrets to ${TARGET} Worker (${worker_args})"
  for secret in "${SECRETS[@]}"; do
    value="${!secret:-}"
    if [ -z "$value" ]; then
      echo "  SKIP ${secret} (not set in environment)"
      continue
    fi
    # shellcheck disable=SC2086 # worker_args is two words by design
    echo "$value" | npx wrangler secret put "$secret" $worker_args 2>&1 | tail -1
  done
done

echo "Done."
