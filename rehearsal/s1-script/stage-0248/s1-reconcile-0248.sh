#!/bin/bash
# REHEARSAL - NEVER MERGE. Hone STAGE 0248-ONLY: clear the s1-apply-0248.sh APPLY-STATE marker, and ONLY by a recorded reconcile.
# READ-ONLY on the database (it makes no connection at all): it classifies the marker from READ-BACK EVIDENCE that already exists on this Mac,
# written by the reviewed read scripts, and only when that evidence is newer than the marker:
#   ALL   the newest s1read.* run printed its OVERALL PASS and its history is exactly 246 rows, max 0248, 0248 once, 0247 absent
#   NONE  the newest window.* S0a run passed, its history read is exactly 245 rows, max 0246, nothing at or above 0247, AND it was taken at least
#         1200 s after the marker (the watchdog cap): a read taken while the push could still be running proves nothing
# Anything else (no evidence, older evidence, unreadable files, an evidence run that failed) REFUSES and leaves the marker. The marker is ARCHIVED
# (renamed with the UTC time), never deleted, and a RECONCILE record names the evidence by sha256. Nothing is retried and no push is made.
set -u
umask 077
ROOT="$HOME/hone-s1"
STATEF="$ROOT/s1-apply/APPLY-STATE"
NONE_WAIT_S=1200
SEALED_SHA=1f6f9ad0026cee66b970e9dc630f1497aa10966df2adb9433d8f8c85bbc44cc3
die() { echo "STOP: $*" >&2; exit 1; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
utcnow() { date -u +%Y-%m-%dT%H:%M:%SZ; }
iso='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'
epoch() { date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null || date -u -d "$1" +%s 2>/dev/null; }
[ $# -eq 0 ] || die "this script takes no arguments"
#RECONCILE-BEGIN
mine() { [ -d "$1" ] && [ ! -L "$1" ] && [ -n "$(find "$1" -maxdepth 0 -user "$(id -un)" ! -perm -020 ! -perm -002 2>/dev/null)" ]; }
sidecar_at() { # sidecar_at FILE KEY -> the single-line sidecar's time, or nothing
  [ -f "$1" ] && [ ! -L "$1" ] && [ "$(grep -c '' "$1")" = 1 ] || return 1
  sed -n "s/.*\"$2\":\"\\([^\"]*\\)\".*/\\1/p" "$1" | LC_ALL=C grep -E "^$iso\$"
}
reconcile() {
  [ -f "$STATEF" ] && [ ! -L "$STATEF" ] || die "there is no APPLY-STATE marker at $STATEF: nothing to reconcile."
  local mk mt mt_s d f cls="" ev="" at at_s r
  mk=$(cat "$STATEF"); mt=$(printf '%s' "$mk" | awk '{print $2}')
  printf '%s' "$mt" | LC_ALL=C grep -Eq "^$iso\$" || die "the marker has no readable time ($mk): it is not a marker of the s1-apply-0248.sh script. Report it to OPS."
  mt_s=$(epoch "$mt"); case "$mt_s" in ''|*[!0-9]*) die "cannot read the marker time" ;; esac
  # ALL
  d=$(ls -dt "$ROOT"/s1read.* 2>/dev/null | head -1)
  if [ -n "$d" ] && mine "$d" && [ -f "$d/verdict.txt" ] && grep -Fxq 'OVERALL PASS (0248 read-back: history and 2 verify-bundle checks; read-only, not a promotion)' "$d/verdict.txt" \
     && [ "$(grep -c '^OVERALL PASS' "$d/verdict.txt")" = 1 ]; then
    f="$d/results/s1-history-0248.json"; at=$(sidecar_at "$d/results/s1-history-0248.meta.json" captured_at_utc) || at=""
    if [ -n "$at" ] && [ -f "$f" ] && [ ! -L "$f" ]; then
      at_s=$(epoch "$at"); c=$(LC_ALL=C tr -d '[:space:]' < "$f")
      if [ "$at_s" -gt "$mt_s" ] && printf '%s' "$c" | grep -Eq '"applied_count":"?246"?[,}]' && printf '%s' "$c" | grep -q '"hosted_max":"0248"' \
         && printf '%s' "$c" | grep -Eq '"rows_0248":"?1"?[,}]' && printf '%s' "$c" | grep -Eq '"rows_0247":"?0"?[,}]'; then cls=ALL; ev=$d; fi
    fi
  fi
  # NONE
  if [ -z "$cls" ]; then
    d=$(ls -dt "$ROOT"/window.* 2>/dev/null | head -1)
    if [ -n "$d" ] && mine "$d" && [ -f "$d/verdict.txt" ] && [ -f "$d/attest/attestation.json" ] && grep -q "$SEALED_SHA" "$d/attest/attestation.json" \
       && [ "$(grep -cFx -e 'OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested)' -e 'OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested; idle path)' "$d/verdict.txt")" = 1 ] \
       && ! grep -qx 'OVERALL PASS' "$d/verdict.txt"; then
      f="$d/results/g02-history-0248.json"; at=$(sidecar_at "$d/results/g02-history-0248.meta.json" captured_at_utc) || at=""
      if [ -n "$at" ] && [ -f "$f" ] && [ ! -L "$f" ]; then
        at_s=$(epoch "$at"); c=$(LC_ALL=C tr -d '[:space:]' < "$f")
        if [ "$at_s" -ge $((mt_s + NONE_WAIT_S)) ] && printf '%s' "$c" | grep -Eq '"applied_count":"?245"?[,}]' && printf '%s' "$c" | grep -q '"hosted_max":"0246"' \
           && printf '%s' "$c" | grep -Eq '"versions_ge_0247":"?0"?[,}]'; then cls=NONE; ev=$d; fi
      fi
    fi
  fi
  [ -n "$cls" ] || die "no usable read-back evidence newer than the marker ($mk). ALL needs a passing s1read run captured after the marker; NONE needs a passing S0a run whose history read was taken at least $NONE_WAIT_S s after the marker. The marker stays. Nothing was changed."
  r="$ROOT/s1-apply/RECONCILE-$(utcnow)"
  { echo "reconcile $cls $(utcnow)"; echo "marker: $mk"; echo "marker sha256 $(sha "$STATEF")"; echo "evidence: $ev"; echo "verdict sha256 $(sha "$ev/verdict.txt")"; } > "$r" || die "cannot write the reconcile record"
  mv "$STATEF" "$STATEF.cleared.$(utcnow)" || die "cannot archive the marker (the record $r was written)"
  echo "RECONCILED $cls: the marker was archived as $STATEF.cleared.* and the record is $r." >&2
  RECONCILE_CLASS=$cls
}
#RECONCILE-END
[ "$(uname -s)" = Darwin ] || die "not macOS"
[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || die "$ROOT is missing or a symlink"
reconcile
