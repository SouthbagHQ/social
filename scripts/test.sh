#!/usr/bin/env bash
# API tests against a real `wrangler dev` with a throwaway local D1 (never touches your dev data).
set -euo pipefail
cd "$(dirname "$0")/.."
export PERSIST_TO="$(mktemp -d)"
PORT="${PORT:-8799}"
npx wrangler d1 migrations apply DB --local --persist-to "$PERSIST_TO" > /dev/null
npx wrangler d1 migrations apply MEDIA --local --persist-to "$PERSIST_TO" > /dev/null
bash scripts/seed-local.sh > /dev/null
setsid npx wrangler dev --port "$PORT" --inspector-port "$((PORT + 1000))" --persist-to "$PERSIST_TO" > "$PERSIST_TO/dev.log" 2>&1 &
DEV=$!
trap 'kill -- -$DEV 2>/dev/null; [ -n "${KEEP:-}" ] || rm -rf "$PERSIST_TO"' EXIT
for _ in $(seq 1 60); do curl -sf "http://localhost:$PORT/api/me" | grep -q authenticated && break; sleep 1; done
BASE="http://localhost:$PORT" node --test tests/*.test.mjs
