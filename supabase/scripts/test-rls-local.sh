#!/usr/bin/env bash
# Runs migrations + RLS tests in a fresh, throwaway database on a LOCAL Postgres.
#
#   RLS_TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres pnpm test:rls
#
# The URL is only used to connect and create/drop a uniquely named test
# database. It must name localhost or a loopback address, so it can't touch
# staging or prod. (Postgres in Docker or a CI service container is fine:
# the URL still says localhost even though the server sees another address.)
set -euo pipefail

: "${RLS_TEST_DATABASE_URL:?Set RLS_TEST_DATABASE_URL to a local Postgres URL (see .env.example)}"

# Strict shape: user[:password]@host[:port]/dbname, nothing else. No query
# parameters (?host= can redirect libpq) and no extra @ or / that could make
# the host ambiguous.
loopback='^postgres(ql)?://[^@/?#]+@(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?/[A-Za-z0-9_]+$'
if [[ ! "$RLS_TEST_DATABASE_URL" =~ $loopback ]]; then
  echo "Refusing to run: RLS_TEST_DATABASE_URL must look like postgres://user[:pass]@localhost[:port]/dbname" >&2
  exit 1
fi

# Environment variables like PGHOSTADDR or PGSERVICE could send libpq elsewhere.
unset PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGSYSCONFDIR

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
db="rls_test_$(date +%s)_$$"
base="${RLS_TEST_DATABASE_URL%/*}"
test_url="$base/$db"

psql -q -v ON_ERROR_STOP=1 "$RLS_TEST_DATABASE_URL" -c "create database $db"
trap 'psql -q "$RLS_TEST_DATABASE_URL" -c "drop database if exists $db with (force)" >/dev/null' EXIT

psql -q -v ON_ERROR_STOP=1 "$test_url" -f "$here/scripts/local-auth-shim.sql"
for f in "$here"/migrations/*.sql; do
  psql -q -v ON_ERROR_STOP=1 "$test_url" -f "$f"
done
for f in "$here"/tests/*.sql; do
  echo "== $(basename "$f")"
  psql -q -v ON_ERROR_STOP=1 "$test_url" -f "$f"
done
