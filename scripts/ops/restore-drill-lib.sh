#!/usr/bin/env bash
# Pure helpers for scripts/ops/restore-drill.sh, in their own file so
# tests/scripts/restore-drill-app-check.test.ts can run them on fixtures.
# Sourced, never executed; no side effects at load.

# The stable, comparable part of storage.objects, one line per object:
#   bucket_id|name|size|mimetype
# The full rows are NOT comparable (the restore re-uploads each object with an
# upsert, which refreshes timestamps, version and etag), so the row hash skips
# the table and THIS projection stands in for it. Run inside the drill's psql.
OBJECTS_PROJECTION_SQL="select bucket_id || '|' || name || '|' || coalesce(metadata->>'size', '') || '|' || coalesce(metadata->>'mimetype', '') from storage.objects order by bucket_id, name"

# Number of objects the drill hashed: the lines of the sha256 file, not a constant.
objects_hashed() {
  grep -c '  obj-[0-9]*\.bin$' "$1" || true
}

# 0 when the two projections are identical AND non-empty AND hold exactly
# $3 lines (the number of objects hashed). Anything else prints why and returns 1.
compare_objects_projection() {
  local before="$1" after="$2" expected="$3" nb na
  nb="$(wc -l <"$before" | tr -d ' ')"; na="$(wc -l <"$after" | tr -d ' ')"
  if [ "$nb" -eq 0 ]; then echo "storage.objects projection is empty before the destroy"; return 1; fi
  if [ "$nb" != "$expected" ]; then echo "storage.objects projection has $nb row(s) before, but $expected object(s) were hashed"; return 1; fi
  if [ "$na" != "$nb" ]; then echo "storage.objects projection has $na row(s) after the restore, $nb before"; return 1; fi
  if ! diff -u "$before" "$after"; then echo "storage.objects projection differs (bucket, name, size or mimetype)"; return 1; fi
  return 0
}

# The negative control (the rebuilt project BEFORE any row is loaded) must prove
# "signed in, and the data is absent". Its log must contain, in the check's own
# words: a successful sign-in, the control line, and ONE miss line naming
# exactly the three reads, each with a data-absent result (a 307 to /no-access,
# or a 404). A sign-in problem, a 5xx, a read that passed, or any other reason
# is NOT a valid control. Returns 0 only for the expected shape.
control_reasons_ok() {
  local log="$1" absent='(307 -> /no-access|404)'
  grep -q 'sign-in: ok$' "$log" || return 1
  grep -q '^app check CONTROL: signed in, data absent (3/3 reads)$' "$log" || return 1
  grep -Eq "^app check MISS: client list: GET /clients answered ${absent}; client record: GET /clients/<id> answered ${absent}; photo bytes: the signed-URL route answered ${absent}\$" "$log"
}
