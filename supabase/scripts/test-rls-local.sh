#!/usr/bin/env bash
# Runs migrations + RLS tests in a fresh, throwaway database on a LOCAL Postgres.
#
#   RLS_TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres pnpm test:rls
#
# The URL is only used to connect and create/drop a uniquely named test
# database. It refuses any server that isn't on loopback or a local socket,
# so it can't touch staging or prod.
set -euo pipefail

: "${RLS_TEST_DATABASE_URL:?Set RLS_TEST_DATABASE_URL to a local Postgres URL (see .env.example)}"

# Ask the server itself where it is, rather than trusting the URL text.
# Query parameters (e.g. ?host=) can redirect libpq, so reject them outright.
case "$RLS_TEST_DATABASE_URL" in
  *\?*) echo "Refusing to run: RLS_TEST_DATABASE_URL must not contain query parameters." >&2; exit 1 ;;
esac
server_addr="$(psql -XAtq "$RLS_TEST_DATABASE_URL" -c "select coalesce(host(inet_server_addr()), 'socket')")"
case "$server_addr" in
  socket|127.0.0.1|::1) ;;
  *) echo "Refusing to run: server address is $server_addr, not localhost." >&2; exit 1 ;;
esac

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
