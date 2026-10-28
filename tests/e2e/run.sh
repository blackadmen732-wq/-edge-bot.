#!/usr/bin/env bash
# Runs the end-to-end test: in-memory Postgres + the real edge function + a fake network.
# Usage: DENO=/path/to/deno tests/e2e/run.sh
set -euo pipefail
cd "$(dirname "$0")"
DENO="${DENO:-deno}"
PORT="${PORT:-54329}"
node db/db-server.mjs "$PORT" > db.log 2>&1 &
DB_PID=$!
trap 'kill $DB_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do grep -q READY db.log && break; sleep 0.5; done
grep -q READY db.log || { cat db.log; exit 1; }
SUPABASE_DB_URL="postgres://postgres:postgres@127.0.0.1:${PORT}/postgres" \
EDGEBOT_DB_MAX_CONN=1 \
ODDS_API_KEY=test-key \
"$DENO" test --allow-all --no-check e2e.test.ts
