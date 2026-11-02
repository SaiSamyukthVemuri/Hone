#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# REHEARSAL of the encrypted export tools (EXPORT-PROCEDURE-GAPS.md GAP-2, GAP-3).
# CI ONLY, SYNTHETIC ONLY. It exercises logical-export.sh, object-export.sh,
# verify-export.sh and export-restore.sh against a throwaway local stack, with
# the checks of RECOVERY-LAYERS-PLAN.md section 4:
#
#   V1  ciphertext hashes (and a flipped byte is caught)
#   V2  row-count/md5 fingerprint taken in the export's snapshot, recomputed
#       after the restore, identical (storage.objects by count)
#   V3  completeness gate (negative control: public.clients removed -> FAIL and
#       the output is discarded); decrypting reproduces the markers
#   V4  restore into a NEW project built from the repository migrations
#   V5  object manifest: every object re-hashed; negative controls (an object
#       deleted between listing and download -> FAIL; a flipped ciphertext byte)
#   V6  NOT RUN here. It is a manual read of real data in a disposable project by
#       Sam; the DR-01A check (restore-drill-app-check.mjs) is the synthetic
#       counterpart and is exercised by the restore-drill workflow.
#   V7  a receipt with hashes, counts, durations and the stack deletion time
#
# Also refused on purpose: a wrong project ref; a target equal to production.
#
# NO hosted project, key or data. The age key is generated in the job, lives in a
# temp dir, and is destroyed at exit. Nothing encrypted leaves the job: only the
# receipt, the summary and the logs are written to the evidence directory.
#
# Usage:  scripts/ops/export-rehearsal.sh [evidence-dir]
# ---------------------------------------------------------------------------
set -euo pipefail

CLI="npx --yes supabase@2.102.0" # pinned: see CLAUDE.md section 3 (grants parity)
PROJECT_ID="hone-export-rehearsal"
DB_CONTAINER="supabase_db_${PROJECT_ID}"
API="http://127.0.0.1:56621"
DBURL="postgresql://postgres:postgres@127.0.0.1:56622/postgres"
BUCKET="treatment-images"
PREFIX="d0d0d0d0-0000-4000-8000-000000000001/d0d0d0d0-0000-4000-8000-000000000002"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OPS="$REPO_ROOT/scripts/ops"
# shellcheck source=scripts/ops/export-lib.sh
. "$OPS/export-lib.sh"
EVIDENCE="${1:-$(mktemp -d -t hone-export-rehearsal-evidence-XXXX)}"
WORK="$(mktemp -d -t hone-export-rehearsal-XXXX)"
mkdir -p "$EVIDENCE"
chmod 700 "$WORK"

log() { printf '[rehearsal %s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$EVIDENCE/rehearsal.log"; }
fail() { log "FAIL: $*"; exit 1; }

for v in $(compgen -e | grep -E '^(SUPABASE_|NEXT_PUBLIC_SUPABASE_|HONE_)' || true); do
  case "${!v}" in *supabase.co*|*supabase.com*) fail "$v points at a hosted Supabase URL; refusing";; esac
done
for p in 56620 56621 56622 56623 56624 56627 56629 8783; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then fail "port $p is already in use"; fi
done
command -v age >/dev/null && command -v age-keygen >/dev/null || fail "age and age-keygen are required"
[ "${GITHUB_ACTIONS:-}" = true ] || fail "the rehearsal runs only in a GitHub Actions job (GITHUB_ACTIONS=true); refusing"

STOPPED_AT=""
cleanup() {
  log "stopping and deleting the rehearsal stack (volumes included)"
  $CLI stop --workdir "$WORK/stack" --no-backup >/dev/null 2>&1 || true
  STOPPED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "stack_deleted_utc=$STOPPED_AT" >>"$EVIDENCE/receipt-v7.txt" || true
  export_cleanup_secrets
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- scratch stack: own project id and ports, never another lane's -------------------
mkdir -p "$WORK/stack/supabase"
cp "$REPO_ROOT/supabase/config.toml" "$WORK/stack/supabase/config.toml"
cp -r "$REPO_ROOT/supabase/migrations" "$WORK/stack/supabase/migrations"
sed -i -E \
  -e "s/^project_id = .*/project_id = \"${PROJECT_ID}\"/" \
  -e 's/\b5432([0-9])\b/5662\1/g' \
  -e 's/\b8083\b/8783/g' \
  "$WORK/stack/supabase/config.toml"
EXCLUDE="studio,realtime,edge-runtime,logflare,vector,imgproxy,mailpit,postgres-meta,supavisor"
start_stack() { $CLI start --workdir "$WORK/stack" -x "$EXCLUDE" >"$EVIDENCE/start-$1.log" 2>&1 || { tail -20 "$EVIDENCE/start-$1.log"; fail "stack start ($1)"; }; }
psql_q() { docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At "$@"; }
service_key() {
  node -e '
const c = require("crypto");
const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const h = b({ alg: "HS256", typ: "JWT" });
const p = b({ iss: "supabase-demo", role: "service_role", exp: Math.floor(Date.now() / 1000) + 3600 });
const s = c.createHmac("sha256", "super-secret-jwt-token-with-at-least-32-characters-long").update(h + "." + p).digest("base64url");
console.log(h + "." + p + "." + s);'
}
upload() { # upload NAME FILE CONTENT-TYPE
  curl -fsS -X POST "$API/storage/v1/object/$BUCKET/$(urlencode_path "$PREFIX/$1")" \
    -H @"$AUTH_HDR_FILE" -H "Content-Type: $3" \
    --data-binary "@$2" >/dev/null || fail "upload $1"
}

# The environment every tool run sees (rehearsal mode, loopback, a container for pg_dump/psql).
rehearse() { # rehearse TOOL ARGS...   (runs with the rehearsal environment; stdout/stderr to caller)
  EXPORT_REHEARSAL=1 EXPORT_REHEARSAL_REF="$PROJECT_ID" DB_URL="$DBURL" SERVICE_KEY="$KEY" \
  EXPORT_PG_DUMP="${EXPORT_PG_DUMP_OVERRIDE:-docker exec -i $DB_CONTAINER pg_dump -U postgres -d postgres}" \
  EXPORT_PSQL="${EXPORT_PSQL_OVERRIDE:-docker exec -i $DB_CONTAINER psql -U postgres -d postgres}" \
  "$@"
}

# env_rehearse VAR=value... COMMAND...: rehearse, with the given variables set for that call only.
env_rehearse() {
  local -a vars=()
  while [ $# -gt 0 ] && [[ "$1" == [A-Z_]*=* ]]; do vars+=("$1"); shift; done
  local v
  for v in "${vars[@]}"; do export "${v?}"; done
  local rc=0
  rehearse "$@" || rc=$?
  for v in "${vars[@]}"; do unset "${v%%=*}"; done
  return $rc
}

RESULT=PASS
check() { # check LABEL "pass|fail"
  if [ "$2" = pass ]; then log "ok   $1"; else RESULT=FAIL; log "FAIL $1"; fi
}
expect_fail() { # expect_fail LABEL EXPECTED_TEXT CMD...   the command must fail AND say the expected thing
  local label="$1" text="$2"; shift 2
  local out; out="$("$@" 2>&1)" && { check "negative control: $label (it PASSED, it must fail)" fail; return; }
  if printf '%s' "$out" | grep -q "$text"; then check "negative control: $label" pass
  else check "negative control: $label (failed, but not for the expected reason: $(printf '%s' "$out" | tail -2 | tr '\n' ' ' | cut -c1-200))" fail; fi
}

# --- 1. build the "production" stack and seed SYNTHETIC rows and objects ------------------
T0=$(date +%s)
log "starting rehearsal stack $PROJECT_ID from $(git -C "$REPO_ROOT" rev-parse --short HEAD) migrations"
start_stack before
KEY="$(service_key)"; [ -n "$KEY" ] || fail "no service-role key from the stack"
SERVICE_KEY="$KEY"; make_auth_header_file   # the key goes through a private 0600 header file, never argv
psql_q -f - <"$OPS/restore-drill-seed.sql" >"$EVIDENCE/seed.log"
# THREE content types, so a restore that defaulted every object to one type would be caught (Codex P2 4371272761).
for i in 1 2 3; do
  head -c $((4096 * i)) /dev/urandom >"$WORK/o$i.bin"
  case "$i" in 2) T=image/jpeg;; *) T=image/png;; esac
  upload "synthetic-$i.png" "$WORK/o$i.bin" "$T"
done
head -c 2048 /dev/urandom >"$WORK/thumb.bin"; upload "synthetic-1.thumb.webp" "$WORK/thumb.bin" image/webp
head -c 1500 /dev/urandom >"$WORK/spaced.bin"; upload "synthetic 4+plus.png" "$WORK/spaced.bin" image/jpeg   # a path that needs URL encoding

age-keygen -o "$WORK/key.txt" >/dev/null 2>&1
RECIPIENT="$(age-keygen -y "$WORK/key.txt")"
age-keygen -o "$WORK/otherkey.txt" >/dev/null 2>&1
log "age key generated in the job (destroyed at exit)"

# --- 2. take both exports ------------------------------------------------------------------
LOGICAL="$WORK/export-logical"; OBJECTS="$WORK/export-objects"
rehearse bash "$OPS/logical-export.sh" --out "$LOGICAL" --recipient "$RECIPIENT" --expect-ref "$PROJECT_ID" 2>&1 | tee -a "$EVIDENCE/rehearsal.log" \
  || fail "logical export"
rehearse bash "$OPS/object-export.sh" --out "$OBJECTS" --recipient "$RECIPIENT" --expect-ref "$PROJECT_ID" --storage-url "$API" --bucket "$BUCKET" 2>&1 | tee -a "$EVIDENCE/rehearsal.log" \
  || fail "object export"
check "logical export taken, V1 hashes and V3 gate passed" pass
check "object export taken, sample re-download matched" pass

# manifest version 2 records each object's OWN content type: three different ones were seeded
TYPES="$(age -d -i "$WORK/key.txt" "$OBJECTS/manifest.age" | awk -F "$US" 'NF == 5 {print $5}' | sort -u | tr '\n' ' ')"
[ "$TYPES" = "image/jpeg image/png image/webp " ] && check "manifest v2 records three different content types (jpeg, png, webp)" pass || check "manifest v2 records three different content types (got: $TYPES)" fail
age -d -i "$WORK/key.txt" "$OBJECTS/manifest.age" | head -n 1 | grep -qx 'manifest-version=2' && check "manifest carries manifest-version=2" pass || check "manifest carries manifest-version=2" fail

# the coverage line must say exactly what was seeded: 3 rows, all with objects; 5 objects, 1 (the spaced one) with no row
grep -q '^rows_total=3 rows_without_object=0 objects_total=5 objects_without_row=1$' "$OBJECTS/coverage.txt" \
  && check "coverage counts equal what was seeded" pass || check "coverage counts equal what was seeded ($(cat "$OBJECTS/coverage.txt"))" fail
# no plaintext anywhere
if find "$LOGICAL" "$OBJECTS" -type f ! -name '*.age' ! -name '*.sha256' ! -name '*.count' ! -name '*.tables' ! -name 'receipt.txt' ! -name 'coverage.txt' | grep -q .; then
  check "no unexpected plaintext file in either export" fail
else check "no unexpected plaintext file in either export" pass; fi
# The side files are the ONLY plaintext an export directory may hold (the find above
# proves nothing else exists); none of them may name a path or carry a row. (Ciphertext
# is not grepped: that would prove nothing.)
if grep -rqs 'synthetic-1.png\|Synthetic Client' "$LOGICAL" "$OBJECTS" --include='*.tables' --include='*.count' --include='*.sha256' --include='receipt.txt' --include='coverage.txt'; then
  check "no path or row text in the plaintext side files (markers, hashes, receipts, coverage)" fail
else check "no path or row text in the plaintext side files (markers, hashes, receipts, coverage)" pass; fi

# --- 3. verify with the key ----------------------------------------------------------------
bash "$OPS/verify-export.sh" logical "$LOGICAL" --identity "$WORK/key.txt" 2>&1 | tee -a "$EVIDENCE/rehearsal.log" | tail -1 | grep -q 'VERIFY PASS' \
  && check "V3 verify logical (decrypt reproduces the markers)" pass || check "V3 verify logical" fail
bash "$OPS/verify-export.sh" objects "$OBJECTS" --identity "$WORK/key.txt" 2>&1 | tee -a "$EVIDENCE/rehearsal.log" | tail -1 | grep -q 'VERIFY PASS' \
  && check "V5 verify objects (every object re-hashed)" pass || check "V5 verify objects" fail

# --- 4. negative controls: each MUST fail, for its own reason -----------------------------------
expect_fail "V3 gate: public.clients removed from the dump" "COMPLETENESS GATE FAILED" \
  env_rehearse EXPORT_PG_DUMP_OVERRIDE="docker exec -i $DB_CONTAINER pg_dump -U postgres -d postgres --exclude-table=public.clients" \
  bash "$OPS/logical-export.sh" --out "$WORK/nc-clients" --recipient "$RECIPIENT" --expect-ref "$PROJECT_ID"
[ ! -e "$WORK/nc-clients" ] && check "negative control (L3): the failed export left NO output directory behind" pass || check "negative control (L3): the failed export left NO output directory behind" fail

cp -r "$LOGICAL" "$WORK/tampered-logical"
printf '\x00' | dd of="$WORK/tampered-logical/public-data.sql.age" bs=1 seek=40 count=1 conv=notrunc 2>/dev/null
expect_fail "V1: one flipped ciphertext byte" "V1" bash "$OPS/verify-export.sh" logical "$WORK/tampered-logical" --identity "$WORK/key.txt"

cp -r "$OBJECTS" "$WORK/tampered-objects"
printf '\x00' | dd of="$WORK/tampered-objects/objects/000001.age" bs=1 seek=40 count=1 conv=notrunc 2>/dev/null
expect_fail "V1/V5: one flipped object byte" "V1" bash "$OPS/verify-export.sh" objects "$WORK/tampered-objects" --identity "$WORK/key.txt"

expect_fail "the wrong key cannot verify" "FAIL" bash "$OPS/verify-export.sh" logical "$LOGICAL" --identity "$WORK/otherkey.txt"

expect_fail "wrong project ref is refused" "does not name project ref" \
  rehearse bash "$OPS/logical-export.sh" --out "$WORK/nc-ref" --recipient "$RECIPIENT" --expect-ref "some-other-project"

# M1: rehearsal mode is unreachable outside CI; an override may only be the docker-exec form on the rehearsal container
expect_fail "M1: EXPORT_REHEARSAL without GITHUB_ACTIONS is refused" "exist only for the CI rehearsal" \
  rehearse env -u GITHUB_ACTIONS bash "$OPS/logical-export.sh" --out "$WORK/nc-ci" --recipient "$RECIPIENT" --expect-ref "$PROJECT_ID"
expect_fail "M1: an EXPORT_PSQL override naming another container is refused" "not the allow-listed rehearsal form" \
  env_rehearse EXPORT_PSQL_OVERRIDE="docker exec -i some-other-container psql -U postgres -d postgres" \
  bash "$OPS/export-restore.sh" logical "$LOGICAL" --identity "$WORK/key.txt" --target-ref "$PROJECT_ID" --production-ref "a-production-ref-that-is-not-this"
expect_fail "M1: an EXPORT_PSQL override reaching another host (-h) is refused" "not the allow-listed rehearsal form" \
  env_rehearse EXPORT_PSQL_OVERRIDE="docker exec -i $DB_CONTAINER psql -h elsewhere.example -U postgres -d postgres" \
  bash "$OPS/export-restore.sh" logical "$LOGICAL" --identity "$WORK/key.txt" --target-ref "$PROJECT_ID" --production-ref "a-production-ref-that-is-not-this"

# an object deleted BETWEEN the listing and the download must fail the object export
HOOK="curl -fsS -X DELETE '$API/storage/v1/object/$BUCKET/$(urlencode_path "$PREFIX/synthetic-2.png")' -H @'$AUTH_HDR_FILE' >/dev/null"
expect_fail "T-1: an object deleted between listing and download" "could not be downloaded" \
  env_rehearse EXPORT_TEST_HOOK_AFTER_LIST="$HOOK" \
  bash "$OPS/object-export.sh" --out "$WORK/nc-obj" --recipient "$RECIPIENT" --expect-ref "$PROJECT_ID" --storage-url "$API" --bucket "$BUCKET"
[ ! -e "$WORK/nc-obj" ] && check "negative control (L3): the failed object export left NO output directory behind" pass || check "negative control (L3): the failed object export left NO output directory behind" fail
# put it back (same bytes) so the later restore compares the taken export, not the damaged world
curl -fsS -X POST "$API/storage/v1/object/$BUCKET/$(urlencode_path "$PREFIX/synthetic-2.png")" -H @"$AUTH_HDR_FILE" \
  -H "Content-Type: image/jpeg" --data-binary "@$WORK/o2.bin" >/dev/null

expect_fail "restore refuses a target equal to production" "equals the production ref" \
  rehearse bash "$OPS/export-restore.sh" logical "$LOGICAL" --identity "$WORK/key.txt" --target-ref "$PROJECT_ID" --production-ref "$PROJECT_ID"

# L1: the typed production ref must match supabase/.temp/project-ref when the checkout is linked
echo "the-linked-production-ref" >"$WORK/project-ref"
expect_fail "L1: --production-ref that differs from the linked project ref is refused" "does not match" \
  env_rehearse EXPORT_PROJECT_REF_FILE="$WORK/project-ref" \
  bash "$OPS/export-restore.sh" logical "$LOGICAL" --identity "$WORK/key.txt" --target-ref "$PROJECT_ID" --production-ref "a-different-production-ref"

# Codex P2 4371111142: a wrong identity on a RESTORE must fail loudly, never end in an empty PASS
expect_fail "wrong identity on the OBJECT restore (no empty PASS, nothing uploaded)" "does not decrypt manifest.age" \
  rehearse bash "$OPS/export-restore.sh" objects "$OBJECTS" --identity "$WORK/otherkey.txt" --target-ref "$PROJECT_ID" --production-ref "a-production-ref-that-is-not-this" --storage-url "$API" --bucket "$BUCKET"
expect_fail "wrong identity on the LOGICAL restore (the database is not touched)" "does not decrypt" \
  rehearse bash "$OPS/export-restore.sh" logical "$LOGICAL" --identity "$WORK/otherkey.txt" --target-ref "$PROJECT_ID" --production-ref "a-production-ref-that-is-not-this"

# --- 5. disaster, then V4: restore into a NEW project built from the migrations --------------------
log "destroying the rehearsal project (stop --no-backup)"
$CLI stop --workdir "$WORK/stack" --no-backup >/dev/null 2>&1
TR=$(date +%s)
log "starting a fresh project from migrations"
start_stack after
KEY="$(service_key)"; [ -n "$KEY" ] || fail "no service-role key after rebuild"
SERVICE_KEY="$KEY"; make_auth_header_file
rehearse bash "$OPS/export-restore.sh" logical "$LOGICAL" --identity "$WORK/key.txt" --target-ref "$PROJECT_ID" --production-ref "a-production-ref-that-is-not-this" 2>&1 | tee -a "$EVIDENCE/rehearsal.log" | tail -1 | grep -q 'RESTORE PASS (logical)' \
  && check "V4/V2: rows restored into a NEW project, fingerprints identical" pass || check "V4/V2: logical restore" fail
rehearse bash "$OPS/export-restore.sh" objects "$OBJECTS" --identity "$WORK/key.txt" --target-ref "$PROJECT_ID" --production-ref "a-production-ref-that-is-not-this" --storage-url "$API" --bucket "$BUCKET" 2>&1 | tee -a "$EVIDENCE/rehearsal.log" | tail -1 | grep -q 'RESTORE PASS (objects)' \
  && check "V4/V5: every object re-uploaded and re-hashed" pass || check "V4/V5: objects restore" fail
# Codex P2 4371272761: a content type that differs after the restore must FAIL the verification.
# The hook changes one restored object's mimetype in the target between the uploads and the check.
read -r -d '' HOOK_UP <<HOOK || true
docker exec -i $DB_CONTAINER psql -U postgres -d postgres -c "update storage.objects set metadata = jsonb_set(metadata, '{mimetype}', '\"image/gif\"') where name like '%synthetic-2.png'"
HOOK
expect_fail "wrong content type after the restore fails verification (no PASS)" "content type or size differs from the original" \
  env_rehearse EXPORT_TEST_HOOK_AFTER_UPLOAD="$HOOK_UP" \
  bash "$OPS/export-restore.sh" objects "$OBJECTS" --identity "$WORK/key.txt" --target-ref "$PROJECT_ID" --production-ref "a-production-ref-that-is-not-this" --storage-url "$API" --bucket "$BUCKET"
RESTORE_SECONDS=$(( $(date +%s) - TR ))

# --- 6. V7: the receipt (hashes, counts, durations; no names, ids, paths or rows) ----------------------
{
  echo "receipt=export-rehearsal (SYNTHETIC; nothing real was read or exported)"
  echo "repo_head=$(git -C "$REPO_ROOT" rev-parse HEAD)"
  echo "result=$RESULT"
  echo "V1=checked on both exports, and a flipped byte was caught"
  echo "V2=fingerprint identical after restore (storage.objects by count)"
  echo "V3=completeness gate passed; removing public.clients failed it and discarded the output"
  echo "V4=restored into a NEW project built from the repository migrations"
  echo "V5=every object re-hashed; a missing object failed the export; each object restored with its own content type (jpeg, png, webp) and the restored metadata verified; a wrong type fails"
  echo "V6=NOT RUN in CI (manual look at real data in a disposable project, by Sam)"
  echo "V7=this receipt"
  echo "total_seconds=$(( $(date +%s) - T0 )) restore_seconds=$RESTORE_SECONDS"
  echo "--- logical export receipt"; cat "$LOGICAL/receipt.txt"
  echo "--- object export receipt"; cat "$OBJECTS/receipt.txt"
} >"$EVIDENCE/receipt-v7.txt"

cat "$EVIDENCE/receipt-v7.txt" | sed -n '1,12p'
log "RESULT: $RESULT"
[ "$RESULT" = PASS ]
