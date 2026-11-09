#!/usr/bin/env bash
# One-command local engine: PostgreSQL (existing or a private local cluster), migrations,
# RLS app role, API + inline worker with the console at http://localhost:${PORT:-8080}/app/
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p var
if [ -f .env ]; then set -a; . ./.env; set +a; fi
if [ -z "${DATABASE_URL:-}" ]; then
  PGBIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)
  [ -n "$PGBIN" ] || { echo "Set DATABASE_URL or install PostgreSQL 15+"; exit 1; }
  export PGDATA="$PWD/var/pgdata" PGPORT="${PGPORT:-55432}"
  RUNAS=(); [ "$(id -u)" = "0" ] && { chown -R postgres "$PWD/var" 2>/dev/null || true; RUNAS=(su postgres -s /bin/bash -c); }
  run(){ if [ ${#RUNAS[@]} -gt 0 ]; then "${RUNAS[@]}" "$*"; else bash -c "$*"; fi; }
  [ -d "$PGDATA" ] || run "$PGBIN/initdb -D $PGDATA -A trust -U postgres >/dev/null"
  run "$PGBIN/pg_ctl -D $PGDATA -l $PWD/var/postgres.log -o '-p $PGPORT -k /tmp -c listen_addresses=127.0.0.1' status >/dev/null || $PGBIN/pg_ctl -D $PGDATA -l $PWD/var/postgres.log -o '-p $PGPORT -k /tmp -c listen_addresses=127.0.0.1' start >/dev/null"
  sleep 1
  psql -h 127.0.0.1 -p "$PGPORT" -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='sie'" | grep -q 1 || psql -h 127.0.0.1 -p "$PGPORT" -U postgres -qc "CREATE DATABASE sie"
  export DATABASE_URL="postgres://postgres@127.0.0.1:$PGPORT/sie"
fi
[ -f var/encryption.key ] || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > var/encryption.key
[ -f var/app-role.pw ] || node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))" > var/app-role.pw
export SIE_ENCRYPTION_KEY="${SIE_ENCRYPTION_KEY:-$(cat var/encryption.key)}"
node scripts/migrate.mjs >/dev/null && echo "migrations applied"
APP_PW=$(cat var/app-role.pw)
node scripts/setup-db-roles.mjs sie_app "$APP_PW" >/dev/null
export APP_DATABASE_URL="${APP_DATABASE_URL:-$(node -e "const u=new URL(process.argv[1]);u.username='sie_app';u.password=process.argv[2];console.log(u.href)" "$DATABASE_URL" "$APP_PW")}"
export SIE_DEV_AUTH="${SIE_DEV_AUTH:-1}" SIE_ENABLE_TEST_PROVIDER="${SIE_ENABLE_TEST_PROVIDER:-1}" SIE_INLINE_WORKER="${SIE_INLINE_WORKER:-1}"
export SIE_STORAGE_DIR="${SIE_STORAGE_DIR:-$PWD/var/storage}" PORT="${PORT:-8080}"
echo "Engine: http://localhost:$PORT/app/  (dev sign-in enabled: $SIE_DEV_AUTH, simulator: $SIE_ENABLE_TEST_PROVIDER)"
exec node apps/api/src/server.mjs
