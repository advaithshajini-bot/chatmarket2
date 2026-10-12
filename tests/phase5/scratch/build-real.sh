#!/usr/bin/env bash
# Usage: build-real.sh <db> <repo-migrations-dir> [extra sql files...]
# Builds a scratch DB from a minimal Supabase stub + the REAL migrations in order (+ extras).
set -euo pipefail
DB=${1:?db}; MIG=${2:?migrations dir}; shift 2 || true
HERE=$(cd "$(dirname "$0")" && pwd)
dropdb --if-exists "$DB"; createdb "$DB"
P="psql -v ON_ERROR_STOP=1 -q -d $DB"
$P -f "$HERE/min-stub.sql"
for f in "$MIG"/*.sql; do sed "s/^create extension if not exists pg_net;/-- (pg_net stubbed in scratch)/" "$f" > /tmp/_m.sql; $P -f /tmp/_m.sql || { echo "FAILED: $f"; exit 1; }; done
for f in "$@"; do $P -f "$f" || { echo "FAILED: $f"; exit 1; }; done
echo "scratch db $DB ready"
