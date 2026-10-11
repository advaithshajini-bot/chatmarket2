#!/usr/bin/env bash
# Usage: setup-scratch-db.sh <dbname> [extra migration files...]  (needs PGHOST/PGPORT/PGUSER in env)
# Builds a scratch DB: base stub + real migrations 100400..100700 (+ any extras, e.g. the M4.4 migration).
set -euo pipefail
DB=${1:?db name}; shift || true
HERE=$(cd "$(dirname "$0")" && pwd); MIG=${MIGRATIONS_DIR:?set MIGRATIONS_DIR to the folder with 20260930100*.sql}
dropdb --if-exists "$DB"; createdb "$DB"
P="psql -v ON_ERROR_STOP=1 -q -d $DB"
$P -c "create extension if not exists pgcrypto" 2>/dev/null || true
$P -f "$HERE/base-stub.sql"
for f in 20260930100400_add_model_pricing 20260930100500_add_demo_engine 20260930100600_add_blueprint_storage 20260930100700_add_demo_ui_support; do $P -f "$MIG/$f.sql"; done
for f in "$@"; do $P -f "$f"; done
echo "scratch db $DB ready"
