#!/usr/bin/env bash
# Prepared offline for future isolated Linux CI; NEVER point at a shared or cloud database.
set -euo pipefail
unset PGUSERNAME PGPASSWORD PGSERVICE PGSERVICEFILE PGHOSTADDR PGOPTIONS PGSSLMODE PGSSLROOTCERT PGSSLKEY PGSSLCERT
unset DATABASE_URL DIRECT_URL DIRECT_DATABASE_URL DATABASE_MIGRATION_URL
for bin in initdb pg_ctl psql pnpm; do command -v "$bin" >/dev/null; done
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
root="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-preflight.XXXXXX")"
cleanup() {
  local result=$?
  trap - EXIT
  if [[ -s "$root/data/postmaster.pid" ]]; then
    pg_ctl -D "$root/data" -m immediate -w stop >/dev/null 2>&1 || {
      printf 'teardown failed: temporary data retained until runner shutdown\n' >&2
      exit 1
    }
  fi
  rm -rf "$root" || exit 1
  [[ ! -e "$root" ]] || exit 1
  printf 'teardown: PostgreSQL stopped and temporary data/socket paths absent\n'
  exit "$result"
}
trap cleanup EXIT
mkdir "$root/socket"
initdb -D "$root/data" -A trust -U ren4950_test >/dev/null
pg_ctl -D "$root/data" -o "-F -h '' -k $root/socket -p 55495" -w start >/dev/null
export PGHOST="$root/socket" PGPORT=55495 PGUSER=ren4950_test PGDATABASE=postgres
export PAPERCLIP_PREFLIGHT_TEST_ROOT="$root"
psql -At -v ON_ERROR_STOP=1 -c 'SELECT version()'
psql -v ON_ERROR_STOP=1 -c 'CREATE TABLE companies (id uuid PRIMARY KEY)' >/dev/null
psql -v ON_ERROR_STOP=1 -f "$(dirname "$0")/../server/src/services/review-preflight-sql-store.sql" >/dev/null
psql -v ON_ERROR_STOP=1 -c "INSERT INTO companies VALUES ('00000000-0000-4000-8000-000000000010')" >/dev/null
run_store() { pnpm --dir "$repo_root" --filter @paperclipai/db exec tsx src/review-preflight-sql-store-physical.mjs "$@"; }
# Two independent Node processes invoke the real store API on separate PG connections.
run_store race key_one_123456789 >"$root/first.log" 2>&1 & first=$!
run_store race key_two_123456789 >"$root/second.log" 2>&1 & other=$!
first_ok=0; wait "$first" && first_ok=1 || true
other_ok=0; wait "$other" && other_ok=1 || true
cat "$root/first.log" "$root/second.log"
[[ "$first_ok" = 1 && "$other_ok" = 1 ]]
[[ "$(psql -At -c 'SELECT count(*) FROM review_preflight_reservations')" = 1 ]]
winner=key_one_123456789
if grep -q '"kind":"created"' "$root/second.log"; then winner=key_two_123456789; fi
grep -q '"kind":"created"' "$root/first.log" || grep -q '"kind":"created"' "$root/second.log"
grep -q '"kind":"pending_unresolved"' "$root/first.log" || grep -q '"kind":"pending_unresolved"' "$root/second.log"
# Restart the real server, then test store idempotency, quota and publication through its API.
pg_ctl -D "$root/data" -m fast -w stop >/dev/null
pg_ctl -D "$root/data" -o "-F -h '' -k $root/socket -p 55495" -w start >/dev/null
run_store verify "$winner"
if psql -v ON_ERROR_STOP=1 -c "UPDATE review_preflight_reservations SET sha = repeat('e',40)" >/dev/null 2>&1; then exit 1; fi
if psql -v ON_ERROR_STOP=1 -c 'DELETE FROM review_preflight_reservations' >/dev/null 2>&1; then exit 1; fi
printf 'store API and schema checks passed\n'
