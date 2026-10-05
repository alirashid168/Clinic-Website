#!/usr/bin/env bash
# Rebuilds a scratch database from the migrations and runs the SQL tests.
# Usage: PGHOST=/path/to/socket PGPORT=5433 ./supabase/tests/run_local.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB=clinic_test
PSQL="psql -X -q -v ON_ERROR_STOP=1 -U ${PGUSER:-postgres}"
$PSQL -d postgres -c "drop database if exists $DB" -c "create database $DB"
for r in anon authenticated service_role; do $PSQL -d postgres -c "drop role if exists $r" >/dev/null 2>&1 || true; done
$PSQL -d $DB -f tests/00_supabase_stub.sql
for f in migrations/*.sql; do echo "== $f"; $PSQL -d $DB -f "$f"; done
for f in tests/1*.sql; do echo "== $f"; $PSQL -d $DB -f "$f" >/dev/null; done
echo "ALL DATABASE TESTS PASSED"
