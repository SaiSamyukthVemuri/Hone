#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Verify an encrypted export (RECOVERY-LAYERS-PLAN.md section 4: V1, V3, V5).
# Run by whoever holds the PRIVATE age key, on a machine they control: it
# decrypts to STDOUT only and prints counts and pass/fail, never a row or a path.
#
#   verify-export.sh logical DIR --identity KEY_FILE
#     V1  every ciphertext hashes as recorded
#     V3  decrypting each data part reproduces the markers taken while it streamed
#         (this also proves the key works), and the table list equals the
#         schema-only dump's, for the schemas exported whole
#   verify-export.sh objects DIR --identity KEY_FILE
#     V1  every ciphertext hashes as recorded
#     V5  the manifest is well formed; EVERY object decrypts and re-hashes to its
#         manifest line; the count equals the manifest's count
# ---------------------------------------------------------------------------
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/ops/export-lib.sh
. "$HERE/export-lib.sh"

KIND="${1:-}"; DIR="${2:-}"; shift 2 || true
ID=""
while [ $# -gt 0 ]; do case "$1" in --identity) ID="$2"; shift 2;; *) export_fail "unknown argument: $1";; esac; done
[ -n "$KIND" ] && [ -d "$DIR" ] && [ -f "$ID" ] || export_fail "usage: (logical|objects) DIR --identity KEY_FILE"
command -v age >/dev/null || export_fail "age is not installed"

dec() { age -d -i "$ID" "$1"; }
fail=0
note() { echo "FAIL: $*"; fail=1; }

hash_verify "$DIR" || note "V1: a ciphertext does not match hashes.sha256"

case "$KIND" in
  logical)
    check() { # check PART MARKER REGEX
      local got want
      got="$(dec "$DIR/$1" | grep -c "$3" || true)"
      want="$(marker_count "$DIR/markers/$2.count")"
      [ -n "$want" ] && [ "$got" = "$want" ] || note "V3: $1 decrypts to $got line(s) of $2, recorded ${want:-none}"
    }
    check public-data.sql.age public-clients '^COPY public\.clients '
    check auth-data.sql.age auth-identities '^COPY auth\.identities '
    check storage-meta.sql.age storage-objects '^COPY storage\.objects '
    { dec "$DIR/schema-only.sql.age" | grep -E '^CREATE TABLE ' | awk '{print $3}' | sed -E 's/\($//' | sort -u >"$DIR/markers/schema.verify.tables"; } || note "V3: the schema-only part does not decrypt"
    [ -f "$DIR/markers/schema.verify.tables" ] || : >"$DIR/markers/schema.verify.tables"
    tables_equal "$DIR/markers/schema.tables" "$DIR/markers/schema.verify.tables" || note "V3: the schema table list differs from the one recorded at export"
    rm -f "$DIR/markers/schema.verify.tables"
    m2="$(dec "$DIR/manifest.age")" || m2=""
    grep -q ' rows=[0-9]* md5=' <<<"$m2" || note "V2: the manifest does not decrypt or has no fingerprint lines"
    ;;
  objects)
    if ! read_object_manifest "$DIR" "$ID"; then
      note "V5: $MANIFEST_REASON"
      MANIFEST=(); MANIFEST_DECLARED=0
    fi
    n="${#MANIFEST[@]}"
    files="$(find "$DIR/objects" -name '*.age' | wc -l | tr -d ' ')"
    [ "$files" = "${MANIFEST_DECLARED:-0}" ] || note "V5: $files object file(s), ${MANIFEST_DECLARED:-0} declared in the manifest"
    for line in "${MANIFEST[@]}"; do
      idx="${line%%"$US"*}"; want="${line##*"$US"}"
      have="$(dec "$DIR/objects/$idx.age" | sha256sum | cut -d' ' -f1)" || { note "V5: object $idx does not decrypt"; continue; }
      [ "$have" = "$want" ] || note "V5: object $idx re-hashes differently"
    done
    ;;
  *) export_fail "kind must be logical or objects";;
esac

if [ "$fail" = 0 ]; then echo "VERIFY PASS ($KIND)"; else echo "VERIFY FAIL ($KIND)"; exit 1; fi
