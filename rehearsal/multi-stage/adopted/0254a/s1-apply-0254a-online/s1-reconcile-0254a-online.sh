#!/bin/bash
# Hone STAGE 0254-AFTER-0257 ONLINE (PREPARATION ONLY / HELD; constants-only sibling of s1-reconcile-0254-online.sh 6d6832bf; logic unchanged): clear the s1-apply-0254a-online.sh APPLY-STATE marker, and ONLY by a recorded reconcile.
# The ALL route is unchanged. The NONE route reads its history evidence from the newest window.* S0a run (as before) OR the newest online.* directory
# (the results of this stage's own pre-push reads, or of g02-read-0254a-online.sh); the 1200 s rule is the SAME for every source, so a pre-push read (always older
# than the marker) can never clear a marker.
# READ-ONLY on the database (it makes no connection at all): it classifies the marker from READ-BACK EVIDENCE that already exists on this Mac,
# written by the reviewed read scripts, and only when that evidence is newer than the marker:
#   ALL   the newest s1read.* run printed its OVERALL PASS and its history is exactly 248 rows, max 0257, 0254 once, 0257 once, 0247 absent
#   NONE  the newest window.* S0a run passed, its history read is exactly 247 rows, max 0257, 0257 once, 0254 absent, nothing else at 0249..0256, AND it was taken at least
#         1200 s after the marker (the watchdog cap): a read taken while the push could still be running proves nothing.
#         NONE also needs the marker word to be IN-FLIGHT (APPLIED-UNVERIFIED means a push finished: a 247-row read then means a restore or a
#         wrong read, which must STOP) and NO supabase or s1-apply-0254a process running.
# Every result file must be bound by its single-line sidecar: sql_sha256 = the pinned query above and result_sha256 = the sha256 of the JSON.
# Anything else (no evidence, older evidence, unreadable files, an evidence run that failed) REFUSES and leaves the marker. The marker is ARCHIVED
# (renamed with the UTC time), never deleted, and a RECONCILE record names the evidence by sha256. Nothing is retried and no push is made.
set -u
umask 077
ROOT="$HOME/hone-s1"
STATEF="$ROOT/s1-apply/APPLY-STATE"
NONE_WAIT_S=1200
SEALED_SHA=77f34d5c9b677faad344b5b1afc2c3f26321f9060db5653a2176d9a239bbba23
# the pinned read queries: a sidecar must name exactly these (a0d3c335 = s1-history-0254a.sql, 1d8ff119 = g02-history-0254a.sql)
SQL_S1H=a0d3c33556ec7fe13b32f776cf6bf3fef6ccece4de39c752d66778f9b19c9d66
SQL_G02=1d8ff11948dfe2c3dbae0ea88c290907292495461470a0d90175e3beace5559c
#CONST-BEGIN
RUNNER_SHA=471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357
#CONST-END
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
meta_ok() { # meta_ok META RESULT FILE SQLSHA : the sidecar names this file and the pinned query, and binds exactly this result's bytes
  local l rs; [ -f "$1" ] && [ ! -L "$1" ] && [ "$(grep -c '' "$1")" = 1 ] || return 1
  l=$(cat "$1"); rs=$(sha "$2") || return 1
  printf '%s\n' "$l" | grep -Fq -e "\"file\":\"$3\"," && printf '%s\n' "$l" | grep -Fq -e "\"sql_sha256\":\"$4\"," && printf '%s\n' "$l" | grep -Fq -e "\"result_sha256\":\"$rs\","
}
none_evidence() { # none_evidence DIR window|online : the g02 history read in DIR/results is bound, was taken at least NONE_WAIT_S after the marker, and shows exactly 247 rows, max 0257, 0254 absent
  local d="$1" kind="$2" f at at_s c
  f="$d/results/g02-history-0254a.json"; at=$(sidecar_at "$d/results/g02-history-0254a.meta.json" captured_at_utc) || at=""
  [ -n "$at" ] && [ -f "$f" ] && [ ! -L "$f" ] && meta_ok "$d/results/g02-history-0254a.meta.json" "$f" g02-history-0254a.sql "$SQL_G02" || return 1
  if [ "$kind" = online ]; then
    grep -Fq -e '"exit_code":0,' "$d/results/g02-history-0254a.meta.json" && grep -Fq -e "\"runner_sha256\":\"$RUNNER_SHA\"," "$d/results/g02-history-0254a.meta.json" || return 1
  fi
  at_s=$(epoch "$at"); c=$(LC_ALL=C tr -d '[:space:]' < "$f")
  [ "$at_s" -ge $((mt_s + NONE_WAIT_S)) ] && printf '%s' "$c" | grep -Eq '"applied_count":"?247"?[,}]' && printf '%s' "$c" | grep -q '"hosted_max":"0257"' \
    && printf '%s' "$c" | grep -Eq '"versions_ge_0249":"?1"?[,}]' && printf '%s' "$c" | grep -Eq '"rows_0257":"?1"?[,}]' && printf '%s' "$c" | grep -Eq '"rows_0254":"?0"?[,}]' && printf '%s' "$c" | grep -Eq '"versions_0249_0256":"?0"?[,}]'
}
reconcile() {
  [ -f "$STATEF" ] && [ ! -L "$STATEF" ] || die "there is no APPLY-STATE marker at $STATEF: nothing to reconcile."
  local mk mt d f cls="" ev="" at at_s r pr
  mk=$(cat "$STATEF"); mt=$(printf '%s' "$mk" | awk '{print $2}')
  printf '%s' "$mt" | LC_ALL=C grep -Eq "^$iso\$" || die "the marker has no readable time ($mk): it is not a marker of the s1-apply-0254a scripts. Report it to OPS."
  mt_s=$(epoch "$mt"); case "$mt_s" in ''|*[!0-9]*) die "cannot read the marker time" ;; esac
  # ALL
  d=$(ls -dt "$ROOT"/s1read.* 2>/dev/null | head -1)
  if [ -n "$d" ] && mine "$d" && [ -f "$d/verdict.txt" ] && grep -Fxq 'OVERALL PASS (0254 read-back: history, 2 verify checks and the owner-only read-policy proof; read-only, not a promotion)' "$d/verdict.txt" \
     && [ "$(grep -c '^OVERALL PASS' "$d/verdict.txt")" = 1 ]; then
    f="$d/results/s1-history-0254a.json"; at=$(sidecar_at "$d/results/s1-history-0254a.meta.json" captured_at_utc) || at=""
    if [ -n "$at" ] && [ -f "$f" ] && [ ! -L "$f" ] && meta_ok "$d/results/s1-history-0254a.meta.json" "$f" s1-history-0254a.sql "$SQL_S1H"; then
      at_s=$(epoch "$at"); c=$(LC_ALL=C tr -d '[:space:]' < "$f")
      if [ "$at_s" -gt "$mt_s" ] && printf '%s' "$c" | grep -Eq '"applied_count":"?248"?[,}]' && printf '%s' "$c" | grep -q '"hosted_max":"0257"' \
         && printf '%s' "$c" | grep -Eq '"rows_0254":"?1"?[,}]' && printf '%s' "$c" | grep -Eq '"rows_0257":"?1"?[,}]' && printf '%s' "$c" | grep -Eq '"rows_0247":"?0"?[,}]'; then cls=ALL; ev=$d; fi
    fi
  fi
  # NONE
  if [ -z "$cls" ]; then
    d=$(ls -dt "$ROOT"/window.* 2>/dev/null | head -1)
    if [ -n "$d" ] && mine "$d" && [ -f "$d/verdict.txt" ] && [ -f "$d/attest/attestation.json" ] && grep -q "$SEALED_SHA" "$d/attest/attestation.json" \
       && [ "$(grep -cFx -e 'OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested)' -e 'OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested; idle path)' "$d/verdict.txt")" = 1 ] \
       && ! grep -qx 'OVERALL PASS' "$d/verdict.txt"; then
      none_evidence "$d" window && { cls=NONE; ev=$d; }
    fi
  fi
  if [ -z "$cls" ]; then # ONLINE: the newest online.* directory; its g02 sidecar must also be an exit-0 capture by the pinned runner
    d=$(ls -dt "$ROOT"/online.* 2>/dev/null | head -1)
    if [ -n "$d" ] && mine "$d"; then none_evidence "$d" online && { cls=NONE; ev=$d; }; fi
  fi
  [ -n "$cls" ] || die "no usable read-back evidence newer than the marker ($mk). ALL needs a passing s1read run captured after the marker; NONE needs a history read (a passing S0a run, or an online.* directory from g02-read-0254a-online.sh) taken at least $NONE_WAIT_S s after the marker. The marker stays. Nothing was changed."
  if [ "$cls" = NONE ]; then # the one route that allows a second push: it must be an IN-FLIGHT marker and no first push may still be alive
    [ "$(printf '%s' "$mk" | awk '{print $1}')" = IN-FLIGHT ] || die "the marker word is not IN-FLIGHT ($mk): a push finished or the marker is not this script's, so a 247-row read means a restore or a wrong read, not 'nothing applied'. Report it to OPS. The marker stays."
    pgrep -f 'supabase|s1-apply-0254a|g02-read-0254' >/dev/null 2>&1; pr=$?
    [ "$pr" = 1 ] || die "a supabase or s1-apply-0254a process is running (or cannot be ruled out, pgrep status $pr): the first push may still be alive. Wait until it has ended, then run this again. The marker stays."
  fi
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
