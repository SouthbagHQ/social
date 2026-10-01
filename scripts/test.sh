#!/usr/bin/env bash
# API tests against a real `wrangler dev` with a throwaway local D1 (never touches your dev data).
set -euo pipefail
cd "$(dirname "$0")/.."
export PERSIST_TO="$(mktemp -d)"
PORT="${PORT:-8799}"
npx wrangler d1 migrations apply DB --local --persist-to "$PERSIST_TO" > /dev/null
bash scripts/seed-local.sh > /dev/null
# A throwaway VAPID key pair turns push notifications on (tests/push.test.mjs).
setsid npx wrangler dev --var BANKING_DEV:1 $(node scripts/vapid-keys.mjs --vars) --port "$PORT" --inspector-port "$((PORT + 1000))" --persist-to "$PERSIST_TO" > "$PERSIST_TO/dev.log" 2>&1 &
DEV=$!
trap 'kill -- -$DEV 2>/dev/null; [ -n "${KEEP:-}" ] || rm -rf "$PERSIST_TO"' EXIT
for _ in $(seq 1 60); do curl -sf "http://localhost:$PORT/api/me" | grep -q authenticated && break; sleep 1; done
BASE="http://localhost:$PORT" node --test --test-concurrency=1 tests/*.test.mjs
