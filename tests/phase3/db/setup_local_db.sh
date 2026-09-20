#!/usr/bin/env bash
# Builds a THROWAWAY local PostgreSQL database that mimics the Supabase roles and
# default privileges MEASURED on the live project, applies every real migration
# in supabase/migrations/ in order, and leaves it ready for run_db_tests.py.
#
# It never touches Supabase. Requires a local PostgreSQL 14+ server you can log
# into as a superuser (default: postgres @ 127.0.0.1:54329, trust auth).
#
#   PGHOST=127.0.0.1 PGPORT=54329 ./tests/phase3/db/setup_local_db.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-54329}"
SU="${PGSUPERUSER:-postgres}"
P="psql -v ON_ERROR_STOP=1 -q"

$P -U "$SU" -d postgres -f "$HERE/shim/00_roles.sql"
$P -U "$SU" -d postgres -c "drop database if exists cm" -c "create database cm owner mig_owner"
$P -U "$SU" -d cm -f "$HERE/shim/01_shim.sql"
$P -U mig_owner -d cm -f "$HERE/shim/02_prereqs.sql"
MIG_DIR="${MIGRATIONS_DIR:-$ROOT/supabase/migrations}"
for f in "$MIG_DIR"/*.sql; do
  $P -U mig_owner -d cm -f "$f" >/dev/null
  echo "applied $(basename "$f")"
done
echo "LOCAL_DB_READY (database: cm)"
