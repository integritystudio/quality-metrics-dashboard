#!/usr/bin/env bash
set -euo pipefail

# Sync Supabase secrets from Doppler to both Cloudflare Workers.
# Usage: doppler run --project integrity-studio --config dev -- npm run deploy:secrets
#
# Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in Doppler

WORKERS=("obs-toolkit-quality-metrics-api" "quality-metrics-api")
SECRETS=("SUPABASE_URL" "SUPABASE_SERVICE_ROLE_KEY")

for worker in "${WORKERS[@]}"; do
  echo "==> Syncing secrets to ${worker}"
  for secret in "${SECRETS[@]}"; do
    value="${!secret:-}"
    if [ -z "$value" ]; then
      echo "  SKIP ${secret} (not set in environment)"
      continue
    fi
    echo "$value" | npx wrangler secret put "$secret" --name "$worker" 2>&1 | tail -1
  done
done

echo "Done."
