#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# HIPAA-READY-01 G-12 (issue #828): isolated, synthetic backup-and-restore drill.
#
# Proves that Hone's data can be rebuilt after losing the whole project, from:
#   1. a logical export of the database rows (public; every auth table, so
#      users keep their sign-in identities; storage metadata);
#   2. a SEPARATE export of Storage object bytes. Supabase database backups do
#      not include Storage objects, only their metadata
#      (https://supabase.com/docs/guides/platform/backups).
# The rebuild is a NEW project created from the repository migrations, into
# which the exported rows and object bytes are loaded.
#
# LOCAL AND SYNTHETIC ONLY.
#   * Runs its own Supabase stack (project id hone-restore-drill, ports
#     5652x/8683) from a scratch copy of supabase/. It never touches another
#     lane's stack, the shared 5432x stack, or any hosted project.
#   * It refuses to run when any HONE_/SUPABASE_ variable names a hosted URL.
#   * Seeds only synthetic rows, and destroys its own stack and volumes at
#     the end.
#
# Usage:  scripts/ops/restore-drill.sh [evidence-dir]
# Output: a manifest before, a manifest after, timings, and PASS or FAIL.
#
# DR-01A application readability (optional). When RESTORE_DRILL_APP_CHECK
# names an executable, the drill calls it twice, as `<check> <phase> <api>
# <evidence-dir>`: once against the rebuilt project BEFORE the rows are loaded
# (phase pre-restore, the negative control) and once after the comparison
# (phase post-restore). The check exits 0 when every read succeeds, 1 when a
# read misses, and anything else on a harness error. The drill PASSES only
# when post-restore exits 0 and pre-restore exits exactly 1, so a broken
# harness can never pass as a negative control. Unset, the drill is unchanged.
# ---------------------------------------------------------------------------
set -euo pipefail

CLI="npx --yes supabase@2.102.0" # pinned: see CLAUDE.md §3 (grants parity)
PROJECT_ID="hone-restore-drill"
DB_CONTAINER="supabase_db_${PROJECT_ID}"
API="http://127.0.0.1:56521"
BUCKET="treatment-images"
# Matches the synthetic studio/client in restore-drill-seed.sql.
PREFIX="d0d0d0d0-0000-4000-8000-000000000001/d0d0d0d0-0000-4000-8000-000000000002"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EVIDENCE="${1:-$(mktemp -d -t hone-restore-drill-evidence-XXXX)}"
WORK="$(mktemp -d -t hone-restore-drill-XXXX)"
mkdir -p "$EVIDENCE"

log() { printf '[drill %s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$EVIDENCE/drill.log"; }
fail() { log "FAIL: $*"; exit 1; }

# --- refuse anything that is not this local drill -------------------------
for v in $(compgen -e | grep -E '^(SUPABASE_|NEXT_PUBLIC_SUPABASE_|HONE_)' || true); do
  case "${!v}" in *supabase.co*|*supabase.com*) fail "$v points at a hosted Supabase URL; refusing";; esac
done
for p in 56520 56521 56522 56523 56524 56527 56529 8683; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then fail "port $p is already in use"; fi
done

cleanup() {
  log "stopping and deleting the drill stack (volumes included)"
  $CLI stop --workdir "$WORK" --no-backup >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

APP_CHECK="${RESTORE_DRILL_APP_CHECK:-}"
if [ -n "$APP_CHECK" ] && [ ! -x "$APP_CHECK" ]; then fail "RESTORE_DRILL_APP_CHECK is not executable: $APP_CHECK"; fi
app_check() { "$APP_CHECK" "$1" "$API" "$EVIDENCE" >"$EVIDENCE/app-check-$1.log" 2>&1 && echo 0 || echo $?; }

# --- scratch copy of supabase/ with drill-only ports and project id --------
mkdir -p "$WORK/supabase"
cp "$REPO_ROOT/supabase/config.toml" "$WORK/supabase/config.toml"
cp -r "$REPO_ROOT/supabase/migrations" "$WORK/supabase/migrations"
sed -i -E \
  -e "s/^project_id = .*/project_id = \"${PROJECT_ID}\"/" \
  -e 's/\b5432([0-9])\b/5652\1/g' \
  -e 's/\b8083\b/8683/g' \
  "$WORK/supabase/config.toml"

# Only the services the drill needs: Postgres, PostgREST, Storage, Kong, and
# Auth (GoTrue). Auth runs so the auth schema is fully migrated, which makes the
# auth.identities restore faithful (Codex P1 on #848).
EXCLUDE="studio,realtime,edge-runtime,logflare,vector,imgproxy,mailpit,postgres-meta,supavisor"

start_stack() {
  $CLI start --workdir "$WORK" -x "$EXCLUDE" >"$EVIDENCE/start-$1.log" 2>&1 \
    || { tail -20 "$EVIDENCE/start-$1.log"; fail "stack start ($1)"; }
}
psql_q() { docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At "$@"; }
# Sign a local service-role token with the CLI's PUBLIC default JWT secret
# (local stacks only; the hosted-URL guard above refuses anything else). The
# expiry is one hour from now, never a fixed date (Codex P2 on #848).
service_key() {
  node -e '
const c = require("crypto");
const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const h = b({ alg: "HS256", typ: "JWT" });
const p = b({ iss: "supabase-demo", role: "service_role", exp: Math.floor(Date.now() / 1000) + 3600 });
const s = c.createHmac("sha256", "super-secret-jwt-token-with-at-least-32-characters-long")
  .update(h + "." + p).digest("base64url");
console.log(h + "." + p + "." + s);'
}

# Row fingerprint of every public table, storage.buckets/objects metadata and
# every Auth table except its own migration history (users, identities,
# sessions, refresh tokens, factors and the rest). Ordered by the row text, so physical order never matters.
manifest() {
  psql_q <<'SQL'
select format('%s.%s rows=%s md5=%s', schemaname, relname, n, h) from (
  select t.schemaname, t.relname,
    (xpath('/row/n/text()', query_to_xml(format(
      'select count(*) as n from %I.%I', t.schemaname, t.relname), false, true, '')))[1]::text as n,
    (xpath('/row/h/text()', query_to_xml(format(
      'select md5(coalesce(string_agg(x::text, %L order by x::text), %L)) as h from %I.%I x',
      E'\n', '', t.schemaname, t.relname), false, true, '')))[1]::text as h
  from pg_stat_user_tables t
  where t.schemaname = 'public'
     or (t.schemaname = 'storage' and t.relname in ('buckets', 'objects'))
     or (t.schemaname = 'auth' and t.relname <> 'schema_migrations')
) s order by 1;
SQL
}

# --- 1. build the "production" project and seed synthetic data -----------
T0=$(date +%s)
log "starting drill stack $PROJECT_ID from $(git -C "$REPO_ROOT" rev-parse --short HEAD) migrations"
start_stack before
KEY="$(service_key)"; [ -n "$KEY" ] || fail "no service-role key from the drill stack"

log "seeding synthetic rows"
psql_q -f - <"$REPO_ROOT/scripts/ops/restore-drill-seed.sql" >"$EVIDENCE/seed.log"

log "uploading synthetic object bytes"
for i in 1 2 3; do
  head -c $((4096 * i)) /dev/urandom >"$WORK/obj-$i.bin"
  curl -fsS -X POST "$API/storage/v1/object/$BUCKET/$PREFIX/synthetic-$i.png" \
    -H "Authorization: Bearer $KEY" -H "apikey: $KEY" \
    -H "Content-Type: image/png" --data-binary "@$WORK/obj-$i.bin" >/dev/null \
    || fail "upload synthetic-$i"
done
(cd "$WORK" && sha256sum obj-*.bin) >"$EVIDENCE/objects-before.sha256"
manifest >"$EVIDENCE/manifest-before.txt"
log "manifest before: $(wc -l <"$EVIDENCE/manifest-before.txt") tables"

# --- 2. back up: rows (logical) and object bytes (separately) -------------
TB=$(date +%s)
log "exporting rows (public, every auth table, storage metadata)"
# Two dumps on purpose: when pg_dump gets any --table, it ignores --schema,
# so one combined call silently exports no public rows. The first drill run
# caught exactly that (six seeded tables restored empty).
docker exec "$DB_CONTAINER" pg_dump -U postgres -d postgres --data-only \
  --schema=public >"$WORK/rows.sql"
# The whole auth schema, not just auth.users: provider-to-user mappings
# (auth.identities, e.g. Google sign-in) and MFA factors live in other tables,
# and Supabase's auth migration guidance moves them all.
docker exec "$DB_CONTAINER" pg_dump -U postgres -d postgres --data-only \
  --schema=auth --exclude-table=auth.schema_migrations >>"$WORK/rows.sql"
docker exec "$DB_CONTAINER" pg_dump -U postgres -d postgres --data-only \
  --table=storage.buckets --table=storage.objects >>"$WORK/rows.sql"
grep -q '^COPY public\.clients ' "$WORK/rows.sql" || fail "export has no public.clients rows"
grep -q '^COPY auth\.identities ' "$WORK/rows.sql" || fail "export has no auth.identities rows"
log "exporting object bytes"
mkdir -p "$WORK/objects"
for i in 1 2 3; do
  curl -fsS "$API/storage/v1/object/$BUCKET/$PREFIX/synthetic-$i.png" \
    -H "Authorization: Bearer $KEY" -H "apikey: $KEY" -o "$WORK/objects/synthetic-$i.bin" \
    || fail "download synthetic-$i"
done
BACKUP_SECONDS=$(( $(date +%s) - TB ))

# --- 3. disaster: destroy the project, volumes included -------------------
log "destroying the drill project (stop --no-backup)"
$CLI stop --workdir "$WORK" --no-backup >/dev/null 2>&1

# --- 4. restore into a NEW project built from migrations ------------------
TR=$(date +%s)
log "starting a fresh project from migrations"
start_stack after
KEY="$(service_key)"; [ -n "$KEY" ] || fail "no service-role key after rebuild"
APP_NEGATIVE=not-run; NEG_SECONDS=0
if [ -n "$APP_CHECK" ]; then
  TN=$(date +%s)
  log "negative control: application check against the rebuilt, not yet restored project"
  case "$(app_check pre-restore)" in 0) APP_NEGATIVE=passed;; 1) APP_NEGATIVE=failed;; *) APP_NEGATIVE=error;; esac
  NEG_SECONDS=$(( $(date +%s) - TN ))
fi
log "loading rows"
{
  echo "begin;"
  echo "set session_replication_role = replica;"
  # Clear rows the migrations themselves inserted, so the export is the only source.
  psql_q <<'SQL'
select 'truncate ' || string_agg(format('%I.%I', schemaname, relname), ', ') || ' cascade;'
from pg_stat_user_tables
where schemaname = 'public'
   or (schemaname = 'storage' and relname in ('buckets', 'objects'))
   or (schemaname = 'auth' and relname <> 'schema_migrations');
SQL
  cat "$WORK/rows.sql"
  echo "commit;"
} | psql_q >"$EVIDENCE/restore.log" 2>&1 || { tail -20 "$EVIDENCE/restore.log"; fail "row restore"; }

log "restoring object bytes"
for i in 1 2 3; do
  curl -fsS -X PUT "$API/storage/v1/object/$BUCKET/$PREFIX/synthetic-$i.png" \
    -H "Authorization: Bearer $KEY" -H "apikey: $KEY" -H "x-upsert: true" \
    -H "Content-Type: image/png" --data-binary "@$WORK/objects/synthetic-$i.bin" >/dev/null \
    || fail "restore synthetic-$i"
done
RESTORE_SECONDS=$(( $(date +%s) - TR - NEG_SECONDS ))

# --- 5. verify -------------------------------------------------------------
mkdir -p "$WORK/verify"
for i in 1 2 3; do
  curl -fsS "$API/storage/v1/object/$BUCKET/$PREFIX/synthetic-$i.png" \
    -H "Authorization: Bearer $KEY" -H "apikey: $KEY" -o "$WORK/verify/obj-$i.bin" \
    || fail "read back synthetic-$i"
done
(cd "$WORK/verify" && sha256sum obj-*.bin) >"$EVIDENCE/objects-after.sha256"
# storage.objects rows carry timestamps the upsert refreshes; compare metadata
# rows from the export, and object bytes by hash.
manifest >"$EVIDENCE/manifest-after.txt"

RESULT=PASS
if ! diff -u "$EVIDENCE/objects-before.sha256" "$EVIDENCE/objects-after.sha256" >"$EVIDENCE/objects.diff"; then
  RESULT=FAIL; log "object bytes differ (objects.diff)"
fi
grep -v '^storage.objects ' "$EVIDENCE/manifest-before.txt" >"$WORK/mb"
grep -v '^storage.objects ' "$EVIDENCE/manifest-after.txt" >"$WORK/ma"
if ! diff -u "$WORK/mb" "$WORK/ma" >"$EVIDENCE/manifest.diff"; then
  RESULT=FAIL; log "row fingerprints differ (manifest.diff)"
fi
OBJ_BEFORE=$(grep '^storage.objects ' "$EVIDENCE/manifest-before.txt" | sed -E 's/ md5=.*//')
OBJ_AFTER=$(grep '^storage.objects ' "$EVIDENCE/manifest-after.txt" | sed -E 's/ md5=.*//')
[ "$OBJ_BEFORE" = "$OBJ_AFTER" ] || { RESULT=FAIL; log "storage.objects count differs: $OBJ_BEFORE vs $OBJ_AFTER"; }

APP_READ=not-run
if [ -n "$APP_CHECK" ]; then
  log "application check against the restored project"
  case "$(app_check post-restore)" in 0) APP_READ=passed;; 1) APP_READ=failed;; *) APP_READ=error;; esac
  [ "$APP_READ" = passed ] || { RESULT=FAIL; log "application check: $APP_READ (app-check-post-restore.log)"; }
  [ "$APP_NEGATIVE" = failed ] || { RESULT=FAIL; log "negative control: $APP_NEGATIVE, expected failed (app-check-pre-restore.log)"; }
fi

{
  echo "result=$RESULT"
  echo "migrations_head=$(git -C "$REPO_ROOT" rev-parse HEAD)"
  echo "tables_compared=$(wc -l <"$WORK/mb")"
  echo "objects_compared=3"
  if [ -n "$APP_CHECK" ]; then
    echo "app_check_post_restore=$APP_READ"
    echo "app_check_pre_restore=$APP_NEGATIVE"
  fi
  echo "backup_seconds=$BACKUP_SECONDS"
  echo "restore_seconds=$RESTORE_SECONDS"
  echo "total_seconds=$(( $(date +%s) - T0 ))"
} | tee "$EVIDENCE/summary.txt"
log "evidence: $EVIDENCE"
[ "$RESULT" = PASS ]
