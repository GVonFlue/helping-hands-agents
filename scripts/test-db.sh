#!/usr/bin/env bash
# Builds the CRM's full schema (migrations + Supabase stand-ins, read-only from a
# checkout of the CRM repo) in a throwaway Postgres, adds an agents_worker login
# in the agent_service role (exactly like production), loads fixtures, and runs
# the worker's database tests against it. Nothing in the CRM repo is changed.
#   CRM_REPO=../baalmann-suite npm run test:db
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRM="$(cd "${CRM_REPO:-$ROOT/../baalmann-suite}" && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/hh-agents-pg-XXXX")"
PORT="${PGPORT_TEST:-55433}"
if [ "$(id -u)" = "0" ]; then RUN="runuser -u postgres --"; chown -R postgres "$DATA"; chmod 755 "$DATA"; else RUN=""; fi
cleanup() { $RUN "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DATA"; }
trap cleanup EXIT
$RUN "$PGBIN/initdb" -D "$DATA" -A trust -U postgres >/dev/null
$RUN "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $DATA -c listen_addresses=''" -l "$DATA/log" -w start >/dev/null
PSQL="psql -h $DATA -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -q -o /dev/null --set=client_min_messages=warning"
$PSQL -f "$CRM/supabase/tests/supabase_stubs.sql"
for f in "$CRM"/supabase/migrations/*.sql; do $PSQL -f "$f"; done
echo "schema: $(ls "$CRM"/supabase/migrations/*.sql | wc -l) CRM migrations applied (CRM at $(git -C "$CRM" rev-parse --short HEAD 2>/dev/null || echo '?'))"
# The production login, per AGENTS-HANDOFF.md section 5.
$PSQL -c "create role agents_worker login password 'local-test-only' in role agent_service;"
$PSQL -f "$ROOT/tests/fixtures.sql"
export ADMIN_URL="postgresql://postgres@localhost/postgres?host=$DATA&port=$PORT"
export DATABASE_URL="postgresql://agents_worker@localhost/postgres?host=$DATA&port=$PORT"
export LOG_SILENT=1
cd "$ROOT"
npx tsx --test --test-concurrency=1 tests/db.*.test.ts
# Smoke: the real process starts as agents_worker, ticks, and stops on SIGTERM...
unset LOG_SILENT
POLL_MS=300 IDLE_POLL_MS=300 timeout -s TERM 6 npx tsx src/index.ts > "$DATA/smoke.log" 2>&1 || true
grep -q '"worker started"' "$DATA/smoke.log" && grep -q '"worker stopped"' "$DATA/smoke.log" && ! grep -q '"level":"error"' "$DATA/smoke.log" \
  || { cat "$DATA/smoke.log"; echo "SMOKE FAILED"; exit 1; }
echo "smoke: worker started, ran, and stopped cleanly"
# ...and refuses to start with a privileged login.
if DATABASE_URL="$ADMIN_URL" timeout 10 npx tsx src/index.ts > "$DATA/refuse.log" 2>&1; then echo "SMOKE FAILED: started as superuser"; exit 1; fi
grep -q 'refusing to start' "$DATA/refuse.log" && echo "smoke: refuses to run as a privileged role"
echo "ALL WORKER DATABASE TESTS PASSED"
