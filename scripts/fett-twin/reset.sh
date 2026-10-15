#!/usr/bin/env bash
# LOCAL-ONLY synthetic Fett twin (#825): GUARDED isolated reset, then seed (or prove) the twin.
#
#   scripts/fett-twin/reset.sh <supabase-workdir> [--seed-only] [--cleanup-dry-run]
#
# <supabase-workdir> is the directory whose supabase/config.toml defines the twin's OWN isolated stack.
# Refuses unless: its project_id is not the shared fleet id (Hone-0162); its db/api ports are not the
# shared 5432x block; supabase_db_<project_id> is running AND publishing that db port; and no browser
# lane of this worktree is running. Credentials come from `supabase status -o env` for that workdir (the
# CLI's own local-stack credential output); nothing secret is stored in this repository.
#
# --seed-only        skip the reset; seed if absent, prove if present, refuse if partial/unrelated
# --cleanup-dry-run  only inventory what the twin owns (deletes nothing)
set -euo pipefail
WD="${1:?usage: reset.sh <supabase-workdir> [--seed-only|--cleanup-dry-run]}"
MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CFG="$WD/supabase/config.toml"
CLI="npx --yes supabase@2.102.0"

[ -f "$CFG" ] || { echo "REFUSED: no $CFG"; exit 4; }
PROJECT="$(sed -n 's/^project_id = "\(.*\)"$/\1/p' "$CFG" | head -1)"
API_PORT="$(awk '/^\[api\]/{f=1;next} /^\[/{f=0} f && /^port = /{print $3; exit}' "$CFG")"
DB_PORT="$(awk '/^\[db\]/{f=1;next} /^\[/{f=0} f && /^port = /{print $3; exit}' "$CFG")"
[ -n "$PROJECT" ] && [ -n "$API_PORT" ] && [ -n "$DB_PORT" ] || { echo "REFUSED: cannot read project/ports from $CFG"; exit 4; }
[ "$PROJECT" != "Hone-0162" ] || { echo "REFUSED: $PROJECT is the SHARED fleet stack"; exit 4; }
case "$API_PORT$DB_PORT" in *5432[0-9]*) echo "REFUSED: shared 5432x port block"; exit 4;; esac
docker ps --format '{{.Names}} {{.Ports}}' | grep -q "^supabase_db_${PROJECT} .*:${DB_PORT}->5432" \
  || { echo "REFUSED: supabase_db_${PROJECT} is not running on ${DB_PORT}"; exit 4; }
if pgrep -f "playwright test" | xargs -r -I{} readlink /proc/{}/cwd 2>/dev/null | grep -qx "$ROOT"; then
  echo "REFUSED: a browser lane is running in $ROOT"; exit 4
fi
echo "== target project=$PROJECT api=127.0.0.1:$API_PORT db=127.0.0.1:$DB_PORT head=$(git -C "$ROOT" rev-parse --short HEAD)"

SERVICE_KEY="$(cd "$WD" && $CLI status --workdir . -o env 2>/dev/null | sed -n 's/^SERVICE_ROLE_KEY="\(.*\)"$/\1/p')"
[ -n "$SERVICE_KEY" ] || { echo "REFUSED: could not read the local service-role key from supabase status"; exit 4; }

if [ "$MODE" = "" ]; then
  ( cd "$WD" && $CLI db reset --local --workdir . ) >/dev/null 2>&1 || echo "[reset] non-zero exit (check storage readiness); continuing to verify"
  docker exec "supabase_db_${PROJECT}" psql -U postgres -Atc "select '[reset] ' || count(*) || ' migrations, max ' || max(version) from supabase_migrations.schema_migrations"
fi

FILE="tests/twin/fett-twin.seed.twin.ts"
[ "$MODE" = "--cleanup-dry-run" ] && FILE="tests/twin/fett-twin.cleanup.twin.ts"
cd "$ROOT"
# #879's paired-target guard refuses a half-moved pair, so the API side names the SAME twin stack too.
HONE_LOCAL_DB_URL="postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres" \
E2E_SUPABASE_URL="http://127.0.0.1:${API_PORT}" \
FETT_TWIN_API_URL="http://127.0.0.1:${API_PORT}" \
FETT_TWIN_SERVICE_ROLE_KEY="$SERVICE_KEY" \
  npx vitest run --config vitest.twin.config.ts "$FILE"
