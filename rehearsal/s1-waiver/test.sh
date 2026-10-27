#!/bin/bash
# REHEARSAL - NEVER MERGE. S1-WAIVER on macOS arm64 (macos-14): s1-apply-waiver.sh (the REAL script; the test copy differs from it only
# on the GO_SHA line) and, as the control, the unchanged s1-apply.sh 2dfd3354, driven through a pty with a STUB supabase-go (dry run /
# push output in the real CLI's format, built from the real bundle list). NOT stubbed: all script logic, the real bundle 599adf08 and
# list 51303504. No hosted call, no secret. The stub logs every call, so "nothing attempted" is proved by an empty call log.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; SRC="$HERE/s1-apply"
T="$(mktemp -d "${TMPDIR:-/tmp}/s1w.XXXXXX")"; T="$(cd "$T" && pwd -P)"
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
has() { grep -qF -- "$2" "$1"; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
PASSWORD=PW-SECRET-77c2de
WSTART='{now-600}'; WEND='{now+7200}'
WP=2026-10-27T01:18:33Z
WL="ROW 4 WAIVED (NOT PASSED) BY SAM; ACCEPTED RECOVERY POINT $WP"

# ---- static: pins, original untouched, the diff is only the row-4 block
[ "$(sha "$SRC/s1-apply.sh")" = 2dfd335461d09561d4b427cbf1918b8a5165709da3184ff7642a149344009004 ] && ok "s1-apply.sh is still 2dfd3354 (untouched)" || bad "original changed"
[ "$(sha "$SRC/migrations-d189768b.tar")" = 599adf08712f6c702f5921ee54f7a83c653ee9faba60604d501aba7af841527b ] && [ "$(sha "$SRC/MIGRATIONS-d189768b.sha256")" = 513035041c76717b5f8df1e2133cf2951c1b03c58d0cde5ce1e5dcdf5492c069 ] && ok "bundle 599adf08 and list 51303504" || bad "bundle/list sha"
bash -n "$SRC/s1-apply-waiver.sh" && ok "bash -n on the waiver variant" || bad "syntax"
diff "$SRC/s1-apply.sh" "$SRC/s1-apply-waiver.sh" > "$T/diff.txt"
if grep '^<' "$T/diff.txt" | grep -qE 'APPLY|75 minutes|FAILED|TOMB|BUNDLE|GO34|GO_SHA|watchdog|dry|WANT|NFILES|tombstone|scan_log|run_cli|URL|pooler'; then bad "the diff removes a line that is not a row-4 check"; else ok "every line the variant removes is a row-4 / restore-point-age line (none touches bundle, dry run, watchdog, APPLY, 75 min, tombstone, pooler)"; fi
[ "$(grep -c '^<.*R4DIR\|^<.*R4SEL\|^<.*rp_s' "$T/diff.txt")" -ge 8 ] && ok "  ... the removed lines are the R4DIR / R4SEL / rp_s checks" || bad "removed lines are not the row-4 checks"

GOSTUB_BODY='#!/bin/sh
echo "$*" >> "@CALLS@"
mode=$(cat "@MODE@")
case "$*" in
  *--dry-run*)
    [ "$mode" = authfail ] && { echo "failed SASL auth (FATAL: password authentication failed)" ; exit 1; }
    echo "DRY RUN: migrations will *not* be pushed to the database."
    echo "Would push these migrations:"
    awk "{print \" • \" \$2}" "@LIST@" | sed -n "/ 0213_/,\$p"
    echo "Finished supabase db push." > /dev/null ;;
  *--yes*)
    awk "{print \$2}" "@LIST@" | sed -n "/^0213_/,\$p" | while read n; do echo "Applying migration $n..."; done
    echo "Finished supabase db push." ;;
esac
exit 0'

mkfix() { # mkfix NAME SCRIPT -> F, H, RUNSCRIPT
  F="$T/$1"; H="$F/home"; ROOT="$H/hone-s1"; mkdir -p "$ROOT/supabase-cli" "$ROOT/s1-apply"; chmod 700 "$ROOT"
  CALLS="$F/calls.log"; : > "$CALLS"; echo ok > "$F/mode"
  body=${GOSTUB_BODY//@CALLS@/$CALLS}; body=${body//@MODE@/$F/mode}; body=${body//@LIST@/$ROOT/s1-apply/MIGRATIONS-d189768b.sha256}
  printf '%s\n' "$body" > "$ROOT/supabase-cli/supabase-go"; chmod 755 "$ROOT/supabase-cli/supabase-go"
  GOSHA=$(sha "$ROOT/supabase-cli/supabase-go")
  cp "$SRC/migrations-d189768b.tar" "$SRC/MIGRATIONS-d189768b.sha256" "$ROOT/s1-apply/"
  sed "s/^GO_SHA=.*/GO_SHA=$GOSHA/" "$SRC/$2" > "$ROOT/s1-apply/$2"; chmod 755 "$ROOT/s1-apply/$2"
  RUNSCRIPT="$ROOT/s1-apply/$2"
}
mkwaiver() { printf '%s\nSam waived row 4 for this release.\n' "${1:-$WL}" > "$ROOT/ROW4-WAIVER.txt"; chmod "${2:-600}" "$ROOT/ROW4-WAIVER.txt"; }
answers() { # answers FILE [watchdog1] [apply] [wend]
  { printf 'Window start (UTC)\t%s\nWindow end (UTC)\t%s\n' "$WSTART" "${4:-$WEND}"
    printf 'Database password\t%s\n' "$PASSWORD"
    printf 'printed  WATCHDOG armed\t%s\nprinted  watching for the push session\tyes\nType  APPLY  to run\t%s\n' "${2:-yes}" "${3:-APPLY}"; } > "$1"
}
run() { RC=0; python3 "$HERE/driver.py" "$F/out.txt" "$F/answers.txt" -- env -i PATH=${SHIM:+$SHIM:}/usr/bin:/bin:/usr/sbin:/sbin HOME="$H" TERM=dumb /bin/bash "$RUNSCRIPT" || RC=$?; OUT="$F/out.txt"; }
ncalls() { grep -c . "$CALLS"; }
refuse() { # refuse LABEL MSG
  if [ "$RC" != 0 ] && has "$OUT" "$2" && [ "$(ncalls)" = 0 ] && [ ! -e "$ROOT/s1-apply/FAILED-LOGIN" ] && [ ! -e "$ROOT/FAILED-LOGIN" ]; then ok "$1 (exit $RC, zero supabase-go calls)"; else bad "$1" "rc=$RC calls=$(ncalls)"; tail -8 "$OUT"; fi; }

# ---- waiver: the happy path
mkfix happy s1-apply-waiver.sh; mkwaiver; answers "$F/answers.txt"; run
tail -n 8 "$OUT" | cut -c1-180
[ "$RC" = 0 ] && has "$OUT" "S1 APPLIED: exactly 34 migrations (0213 .. 0246) in order" && ok "waiver file present: dry run exactly 34, watchdog confirmations, APPLY, push, exit 0" || bad "happy path" "rc=$RC"
has "$OUT" "row 4 WAIVED, not passed; accepted recovery point $WP" && ok "  ... prints 'row 4 WAIVED, not passed; accepted recovery point $WP'" || bad "  ... waived line not printed"
[ ! -d "$(ls -d "$ROOT"/row4.* 2>/dev/null | head -1)" ] && ok "  ... no row-4 directory exists anywhere (none was needed)" || bad "  ... a row4 dir exists"
RUNREC=$(ls -d "$ROOT"/s1apply.*/run.txt | head -1)
grep -qxF "row 4 WAIVED, not passed; accepted recovery point $WP" "$RUNREC" && ok "  ... the run record holds the waived line" || bad "  ... run record lacks the waived line"
[ "$(grep -c 'db push' "$CALLS")" = 2 ] && [ "$(grep -c -e '--dry-run' "$CALLS")" = 1 ] && [ "$(grep -c -e '--yes' "$CALLS")" = 1 ] && ok "  ... exactly two connections: one dry run, one push (single login per phase, no retry)" || bad "  ... call counts" "$(cat "$CALLS")"
grep -rqF "$PASSWORD" "$OUT" "$ROOT" 2>/dev/null && bad "  ... the password appears in output or on disk" || ok "  ... the password appears nowhere in the output or on disk"

# ---- waiver: refusals (nothing attempted)
mkfix missing s1-apply-waiver.sh; answers "$F/answers.txt"; run
refuse "waiver file missing is refused" "waiver file $ROOT/ROW4-WAIVER.txt is missing"
mkfix wrongline s1-apply-waiver.sh; mkwaiver "ROW 4 WAIVED (NOT PASSED) BY SAM; ACCEPTED RECOVERY POINT 2026-10-27T01:18:34Z"; answers "$F/answers.txt"; run
refuse "wrong first line (other time) is refused" "is not exactly: $WL"
mkfix trail s1-apply-waiver.sh; mkwaiver "$WL "; answers "$F/answers.txt"; run
refuse "first line with a trailing space is refused" "is not exactly"
mkfix second s1-apply-waiver.sh; { printf 'note\n%s\n' "$WL"; } > "$ROOT/ROW4-WAIVER.txt"; chmod 600 "$ROOT/ROW4-WAIVER.txt"; answers "$F/answers.txt"; run
refuse "the waiver line on the SECOND line is refused" "is not exactly"
mkfix empty s1-apply-waiver.sh; : > "$ROOT/ROW4-WAIVER.txt"; chmod 600 "$ROOT/ROW4-WAIVER.txt"; answers "$F/answers.txt"; run
refuse "an empty waiver file is refused" "is not exactly"
mkfix m644 s1-apply-waiver.sh; mkwaiver "$WL" 644; answers "$F/answers.txt"; run
refuse "mode 644 is refused" "mode 600"
mkfix m660 s1-apply-waiver.sh; mkwaiver "$WL" 660; answers "$F/answers.txt"; run
refuse "mode 660 is refused" "mode 600"
mkfix m400 s1-apply-waiver.sh; mkwaiver "$WL" 400; answers "$F/answers.txt"; run
refuse "mode 400 is refused (exactly 600)" "mode 600"
mkfix sym s1-apply-waiver.sh; mkwaiver; mv "$ROOT/ROW4-WAIVER.txt" "$F/real-waiver.txt"; ln -s "$F/real-waiver.txt" "$ROOT/ROW4-WAIVER.txt"; answers "$F/answers.txt"; run
refuse "a symlink (to a perfect file) is refused" "no link"
mkfix dangling s1-apply-waiver.sh; ln -s "$F/nowhere" "$ROOT/ROW4-WAIVER.txt"; answers "$F/answers.txt"; run
refuse "a dangling symlink is refused" "no link"
mkfix dir s1-apply-waiver.sh; mkdir "$ROOT/ROW4-WAIVER.txt"; answers "$F/answers.txt"; run
refuse "a directory in its place is refused" "regular file"
mkfix hard s1-apply-waiver.sh; mkwaiver; ln "$ROOT/ROW4-WAIVER.txt" "$F/second-name"; answers "$F/answers.txt"; run
refuse "a second hard link is refused" "more than one hard link"

# ---- everything else is unchanged in behaviour (waiver present in each)
mkfix tomb s1-apply-waiver.sh; mkwaiver; mkdir -p "$ROOT/s1-apply"; echo x > "$ROOT/s1-apply/FAILED-LOGIN"; answers "$F/answers.txt"; run
[ "$RC" != 0 ] && has "$OUT" "a previous run failed a login" && [ "$(ncalls)" = 0 ] && ok "a FAILED-LOGIN tombstone still refuses (zero calls)" || bad "tombstone" "rc=$RC"
mkfix wdno s1-apply-waiver.sh; mkwaiver; answers "$F/answers.txt" no; run
[ "$RC" != 0 ] && has "$OUT" "watchdog 'armed' not confirmed" && [ "$(ncalls)" = 1 ] && ok "watchdog not confirmed stops after the dry run; nothing applied" || bad "watchdog gate" "rc=$RC calls=$(ncalls)"
mkfix noapply s1-apply-waiver.sh; mkwaiver; answers "$F/answers.txt" yes apply; run
[ "$RC" != 0 ] && has "$OUT" "not confirmed (type exactly: APPLY)" && [ "$(grep -c -e '--yes' "$CALLS")" = 0 ] && ok "APPLY typed wrongly: no push" || bad "APPLY gate" "rc=$RC"
mkfix short s1-apply-waiver.sh; mkwaiver; answers "$F/answers.txt" yes APPLY '{now+3000}'; run
[ "$RC" != 0 ] && has "$OUT" "fewer than 75 minutes" && [ "$(grep -c -e '--yes' "$CALLS")" = 0 ] && ok "fewer than 75 minutes left: refused at APPLY, no push (the 75-min gate is intact)" || bad "75-min gate" "rc=$RC"
mkfix authf s1-apply-waiver.sh; mkwaiver; echo authfail > "$F/mode"; answers "$F/answers.txt"; run
[ "$RC" != 0 ] && [ -e "$ROOT/s1-apply/FAILED-LOGIN" ] && [ "$(ncalls)" = 1 ] && ok "an authentication failure writes the FAILED-LOGIN tombstone and is not retried (1 call)" || bad "auth failure" "rc=$RC calls=$(ncalls)"
mkfix badbundle s1-apply-waiver.sh; mkwaiver; printf 'x' >> "$ROOT/s1-apply/migrations-d189768b.tar"; answers "$F/answers.txt"; run
[ "$RC" != 0 ] && has "$OUT" "sha256 mismatch" && [ "$(ncalls)" = 0 ] && ok "a tampered bundle still refuses (zero calls)" || bad "bundle gate" "rc=$RC"
mkfix badwin s1-apply-waiver.sh; mkwaiver; printf 'Window start (UTC)\tnot-a-time\n' > "$F/answers.txt"; run
[ "$RC" != 0 ] && has "$OUT" "window start is not" && [ "$(ncalls)" = 0 ] && ok "a malformed window start still refuses" || bad "window gate" "rc=$RC"

# ---- control: the ORIGINAL still demands row 4 and ignores a waiver file
mkfix ctrl s1-apply.sh; mkwaiver; answers "$F/answers.txt"; run
[ "$RC" != 0 ] && has "$OUT" "no row-4 result was found" && [ "$(ncalls)" = 0 ] && ok "control: the original s1-apply.sh refuses without a row-4 directory even with the waiver file present" || bad "control" "rc=$RC"

echo; echo "passed: $pass failed: $fail"
[ "$fail" = 0 ]
