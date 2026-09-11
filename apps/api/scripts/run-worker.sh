#!/bin/bash
# Wraps the worker's launchd invocation so FRED_API_KEY is pulled fresh from macOS
# Keychain on every (re)start, never stored in the plist, .env, or the repo.
# Store the key once with:
#   security add-generic-password -a "$USER" -s FRED_API_KEY -w '<key>' -U
set -euo pipefail
FRED_API_KEY="$(security find-generic-password -a "$USER" -s FRED_API_KEY -w 2>/dev/null || true)"
export FRED_API_KEY
exec node \
  --env-file-if-exists=$REPO_ROOT/.env \
  $REPO_ROOT/apps/api/dist/worker.js
