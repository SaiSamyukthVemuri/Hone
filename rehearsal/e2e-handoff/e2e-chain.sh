#!/bin/bash
# REHEARSAL - NEVER MERGE. E2E-HANDOFF: the reviewed Mac scripts run as ONE chain in ONE fake HOME on macOS arm64.
# Step 1: the five reviewed download lines, exactly as published, with a fake scp serving the real files (VPS mirror in ./vps).
# Step 2: window-s0a.sh -> window-row4.sh -> (negative: a refused second row-4 run, s1-apply refuses with zero connections)
#         -> window-row4.sh -> s1-apply.sh with the REAL bundle 599adf08 -> window-s1read.sh.
# REAL: every script's logic, the comparator and lib, the 14 + 6 gate files, the bundle and its 34 migrations, the real darwin
#       supabase-go v2.102.0 (dce26b75) executing `db push` and the S1 `db query` reads against a throwaway local PostgreSQL 17 (TLS,
#       scram) that the real CLI first brought to 0212 from the real chain; the pty-typed answers; the fake HOME layout.
# STUBBED: scp (copies from ./vps); the S0 gate-file hosted reads (canned results, no hosted data exists); the Management API
#       (--linked is rewritten to --db-url of the local database by a thin wrapper that is the only supabase-go the scripts see; the
#       real binary sits one directory below); the typed dashboard/PITR answers; the watchdog confirmation (yes, yes); and PIN
#       SUBSTITUTIONS in test copies (the wrapper's sha for GO_SHA / the runner's SUPABASE_GO_SHA256, the baseline's runner_sha256).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
VPS="$HERE/vps"
WSD="$HERE/../window-script"
W="${E2E_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/e2e.XXXXXX")}"; mkdir -p "$W"; W="$(cd "$W" && pwd -P)"
H="$W/home"; ROOT="$H/hone-s1"; mkdir -p "$H"
STEPS="$W/steps.tsv"; : > "$STEPS"
pass=0; fail=0
note() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$STEPS"; }
ok()  { pass=$((pass+1)); echo "ok   - $1"; note "$CUR" ok "$1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; note "$CUR" FAIL "$1 ${2:-}"; }
has() { grep -qF -- "$2" "$1"; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
CUR=setup
TOKEN=TOKEN-SECRET-9f3a1b
PASSWORD=PW-SECRET-77c2de
REF=alhhybgqdmcdyzpybykj
nowplus() { python3 -c 'import datetime,sys;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=int(sys.argv[1]))).strftime("%Y-%m-%dT%H:%M:%SZ"))' "$1"; }
NODEDIR="$(dirname "$(node -p process.execPath)")"
SAFEPATH="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$NODEDIR"

# ---- the window must not meet the daily blackout 07:45-10:00 UTC (the comparator would, correctly, refuse)
WS=$(nowplus -10); WE=$(nowplus 125)
if [ -n "$(python3 - "$WS" "$WE" <<'PY'
import sys, datetime as d
p=lambda s:d.datetime.strptime(s,"%Y-%m-%dT%H:%M:%SZ")
a,b=p(sys.argv[1]),p(sys.argv[2])
day=a.replace(hour=0,minute=0,second=0)-d.timedelta(days=1)
while day<=b:
    bs=day+d.timedelta(hours=7,minutes=45); be=day+d.timedelta(hours=10)
    if a<be and b>bs: print("yes"); break
    day+=d.timedelta(days=1)
PY
)" ]; then echo "STOP: the 135-minute window $WS .. $WE meets 07:45-10:00 UTC; re-run after 10:00 UTC"; exit 3; fi

# =====================================================================================================================
CUR=infra
# ---- throwaway PostgreSQL 17 with TLS, the shim, the login role postgres.<ref>
B=$("$HERE/pg-setup.sh" "$W/pg" "$PASSWORD") || { echo "pg-setup failed"; tail -20 "$W/pg/pg.log" 2>/dev/null; exit 2; }
PSQL() { "$B/psql" -X -At -h "$W/pg" -p 55432 -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }
LOCALURL="postgresql://postgres.$REF@127.0.0.1:55432/postgres?sslmode=require"
# ---- the REAL darwin supabase-go v2.102.0
mkdir -p "$W/dl" && ( cd "$W/dl" && curl -fsSL -o cli.tgz https://github.com/supabase/cli/releases/download/v2.102.0/supabase_2.102.0_darwin_arm64.tar.gz && tar -xzf cli.tgz supabase ) || { echo "could not fetch the CLI"; exit 2; }
REALBIN="$W/dl/supabase"
[ "$(sha "$REALBIN")" = dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b ] && ok "the real darwin_arm64 supabase-go v2.102.0 hashes to the pinned dce26b75" || { bad "real CLI sha" "$(sha "$REALBIN")"; exit 2; }
# ---- the real CLI brings the throwaway database to 0212 from the real chain (0001..0212 of the bundle)
mkdir -p "$W/build/supabase/migrations" "$W/build/supabase/.temp" && tar -xf "$VPS/team/s1-apply/migrations-d189768b.tar" -C "$W/build"
for f in "$W/build/supabase/migrations/"*.sql; do v=$(basename "$f" | cut -c1-4); [ "$v" -gt 0212 ] && rm "$f"; done
printf 'v2.102.0\n' > "$W/build/supabase/.temp/cli-latest"
( cd "$W/build" && PGPASSWORD="$PASSWORD" SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 "$REALBIN" db push --db-url "$LOCALURL" --yes ) > "$W/build.log" 2>&1 || { echo "building 0212 failed"; tail -30 "$W/build.log"; tail -20 "$W/pg/pg.log"; exit 2; }
HIST0=$(PSQL -c "select count(*)||'|'||max(version) from supabase_migrations.schema_migrations")
[ "$HIST0" = "211|0212" ] && ok "the synthetic database is at 0212 (211 history rows) after the real CLI applied the real chain" || { bad "build 0212" "$HIST0"; tail -20 "$W/build.log"; exit 2; }

# =====================================================================================================================
CUR=layout
# ---- what the Mac check leaves: ~/hone-s1 with the real CLI, and window-reads with the runner, manifest and 14 gate files
mkdir -p "$ROOT/supabase-cli" "$ROOT/window-reads"
cp "$REALBIN" "$ROOT/supabase-cli/supabase-go"; chmod 0755 "$ROOT/supabase-cli/supabase-go"
for f in run-window-read-macos.sh MANIFEST.sha256 $(awk '{print $2}' "$VPS/machines/window-reads/MANIFEST.sha256"); do cp "$VPS/machines/window-reads/$f" "$ROOT/window-reads/$f"; done
chmod 0755 "$ROOT" "$ROOT/window-reads"
[ "$(ls "$ROOT/window-reads" | wc -l | tr -d ' ')" = 16 ] && ok "layout: supabase-cli/supabase-go (real) and window-reads with runner, manifest and the 14 gate files" || bad "layout"
snap() { ( cd "$ROOT" && find . -type f ! -path './e2e-*' ! -path './_e2e/*' ! -path './s1apply.*' ! -path './window.*' ! -path './row4.*' ! -path './s1read.*' ! -path './supabase-cli/real/*' | LC_ALL=C sort | while IFS= read -r f; do printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "${f#./}"; done ); }

# =====================================================================================================================
CUR=step1-downloads
mkdir -p "$W/bin"
cat > "$W/bin/scp" <<'FAKE'
#!/bin/sh
# fake scp: sam@100.123.145.56:/home/sam/hone-handoffs/2026-10-18/<path> -> $E2E_VPS/<path>
n=$#; i=0; dest=""
for a in "$@"; do i=$((i+1)); [ "$i" = "$n" ] && dest="$a"; done
i=0
for a in "$@"; do i=$((i+1)); [ "$i" -lt "$n" ] || continue
  case "$a" in
    sam@100.123.145.56:/home/sam/hone-handoffs/2026-10-18/*) cp "$E2E_VPS/${a#sam@100.123.145.56:/home/sam/hone-handoffs/2026-10-18/}" "$dest" || exit 1 ;;
    -*) ;;
    *) echo "fake scp: unexpected argument $a" >&2; exit 1 ;;
  esac
done
FAKE
chmod +x "$W/bin/scp"
L1=$(grep -E '^    \( set -u; S=\$\(mktemp -d\)' "$VPS/machines/window-reads/WINDOW-COMMAND-MACOS.md" | sed 's/^    //')
L2=$(grep -E '^\( set -u; S=\$\(mktemp -d\)' "$VPS/team/s1-apply/DOWNLOAD-COMMAND.txt")
L3=$(grep -E '^\( set -u; S=\$\(mktemp -d\)' "$VPS/01-ops/watchdog-operator/WATCHDOG-OPERATOR.txt")
L4=$(grep -E '^    \( set -u; S=\$\(mktemp -d\)' "$VPS/machines/window-reads-s1/WINDOW-S1READ-MACOS.md" | sed 's/^    //')
L5=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).download_cmd)' "$VPS/willow/PARTC-LAST-END.json")
for n in 1 2 3 4 5; do eval "l=\$L$n"; [ -n "$l" ] && [ "$(printf '%s\n' "$l" | grep -c '')" = 1 ] || bad "line $n is not exactly one line"; done
EXPECT1="window-reads/window-s0a.sh window-reads/window-row4.sh window-reads/BASELINE-W1-MACOS-CANDIDATE-3.json window-reads/G3-CHECKSUMS-d189768b.txt window-reads/compare-preflight.mjs window-reads/compare-preflight-lib.mjs"
EXPECT2="s1-apply/s1-apply.sh s1-apply/migrations-d189768b.tar s1-apply/MIGRATIONS-d189768b.sha256"
EXPECT3="d3-watchdog.zsh"
EXPECT4="window-reads-s1/window-s1read.sh window-reads-s1/run-window-read-macos.sh window-reads-s1/MANIFEST.sha256 window-reads-s1/s1-history.sql window-reads-s1/census-0213-0246.sql window-reads-s1/s1-g10.sql window-reads-s1/s1-closures.sql window-reads-s1/s1-table-privileges.sql window-reads-s1/s1-body-md5.sql"
EXPECT5="partc-script/partc-readback.sh"
src_of() { # installed path (relative to ~/hone-s1) -> VPS source
  case "$1" in
    window-reads/*) echo "$VPS/machines/window-reads/${1#window-reads/}" ;;
    s1-apply/*) echo "$VPS/team/s1-apply/${1#s1-apply/}" ;;
    d3-watchdog.zsh) echo "$VPS/general/d3-watchdog.zsh" ;;
    window-reads-s1/*) echo "$VPS/machines/window-reads-s1/${1#window-reads-s1/}" ;;
    partc-script/*) echo "$VPS/willow/partc/${1#partc-script/}" ;;
  esac
}
snap > "$W/snap.0"; cp "$W/snap.0" "$W/snap.prev"
ALLNEW=""
for n in 1 2 3 4 5; do
  eval "line=\$L$n"; eval "exp=\$EXPECT$n"
  RC=0; OUT=$(env -i PATH="$W/bin:$SAFEPATH" HOME="$H" TMPDIR="$W" E2E_VPS="$VPS" /bin/zsh -c "$line" 2>&1) || RC=$?
  echo "--- line $n output: $OUT"
  case "$OUT" in *"installed"*) ;; *) bad "line $n did not report an install" "$OUT" ;; esac
  snap > "$W/snap.$n"
  newp=$(awk 'NR==FNR{old[$2]=$1; next} !($2 in old){print $2}' "$W/snap.prev" "$W/snap.$n" | sort | tr '\n' ' ')
  chg=$(awk 'NR==FNR{old[$2]=$1; next} ($2 in old) && old[$2]!=$1{print $2}' "$W/snap.prev" "$W/snap.$n" | tr '\n' ' ')
  gone=$(awk 'NR==FNR{new[$2]=1; next} !($2 in new){print $2}' "$W/snap.$n" "$W/snap.prev" | tr '\n' ' ')
  want=$(for f in $exp; do echo $f; done | sort | tr '\n' ' ')
  # window-reads files the Mac check left must not appear as new, and nothing existing may change or vanish
  [ "$newp" = "$want" ] && ok "line $n installed exactly: $want" || bad "line $n installed [$newp], expected [$want]"
  [ -z "$chg" ] && [ -z "$gone" ] && ok "line $n changed no existing file and removed none (no overwrite of another line's or the layout's files)" || bad "line $n overwrote [$chg] or removed [$gone]"
  for f in $exp; do [ "$(sha "$ROOT/$f")" = "$(sha "$(src_of "$f")")" ] || bad "line $n: $f differs from the VPS copy"; done
  ALLNEW="$ALLNEW $exp"
  cp "$W/snap.$n" "$W/snap.prev"
done
ok "all five published download lines ran as published under zsh with a fake scp; every installed file equals its VPS copy"
# modes the scripts need
[ -x "$ROOT/window-reads/window-s0a.sh" ] && [ -x "$ROOT/window-reads/window-row4.sh" ] && [ -x "$ROOT/s1-apply/s1-apply.sh" ] && [ -x "$ROOT/window-reads-s1/window-s1read.sh" ] && [ -x "$ROOT/window-reads-s1/run-window-read-macos.sh" ] && [ -x "$ROOT/partc-script/partc-readback.sh" ] && ok "the installed scripts are executable" || bad "a script is not executable"
# the published watchdog step-2 line 1 (sha check) and a syntax check of the installed watchdog under zsh
W2=$(grep -E '^cd "\$HOME/hone-s1" && \[ "\$\(shasum' "$VPS/01-ops/watchdog-operator/WATCHDOG-OPERATOR.txt")
RC=0; OUT=$(env -i PATH="$SAFEPATH" HOME="$H" /bin/zsh -c "$W2" 2>&1) || RC=$?
[ "$OUT" = "watchdog sha256 OK" ] && ok "the watchdog step-2 line finds ~/hone-s1/d3-watchdog.zsh and prints: watchdog sha256 OK" || bad "watchdog step 2" "$OUT"
/bin/zsh -n "$ROOT/d3-watchdog.zsh" && ok "zsh -n d3-watchdog.zsh" || bad "watchdog syntax"
for s in "$ROOT/window-reads/window-s0a.sh" "$ROOT/window-reads/window-row4.sh" "$ROOT/s1-apply/s1-apply.sh" "$ROOT/window-reads-s1/window-s1read.sh" "$ROOT/partc-script/partc-readback.sh"; do /bin/bash -n "$s" || bad "bash -n $s"; done; ok "bash -n on the five installed scripts"
snap > "$W/snap.published"

# =====================================================================================================================
CUR=step2-setup
# ---- the wrapper becomes the supabase-go the scripts see; the real binary moves one directory down
mkdir -p "$ROOT/supabase-cli/real"; mv "$ROOT/supabase-cli/supabase-go" "$ROOT/supabase-cli/real/supabase-go"
cp "$HERE/supabase-go-wrapper.sh" "$ROOT/supabase-cli/supabase-go"; chmod 0755 "$ROOT/supabase-cli/supabase-go"
printf '%s\n' "$LOCALURL" > "$ROOT/e2e-target"; : > "$ROOT/e2e-calls.log"
GOSHA=$(sha "$ROOT/supabase-cli/supabase-go")
# canned results for the 14 S0 gate files (the hosted S0a reads are stubbed)
mkdir -p "$ROOT/e2e-canned"
node "$WSD/gen-results.mjs" "$ROOT/e2e-canned" "$VPS/machines/window-reads/BASELINE-W1-MACOS-CANDIDATE-3.json" "" "$WSD/window-reads" || { bad "canned results"; exit 2; }
# PIN SUBSTITUTIONS (test copies only; the published files in the layout stay byte-identical, except the two runner copies and the baseline,
# whose pinned constants are the thing being substituted): wrapper sha for the runner's SUPABASE_GO_SHA256, baseline runner_sha256 re-pin
sed "s/^SUPABASE_GO_SHA256=.*/SUPABASE_GO_SHA256=$GOSHA/" "$VPS/machines/window-reads/run-window-read-macos.sh" > "$W/runner.test"
RSHA=$(sha "$W/runner.test")
cp "$W/runner.test" "$ROOT/window-reads/run-window-read-macos.sh"; cp "$W/runner.test" "$ROOT/window-reads-s1/run-window-read-macos.sh"; chmod 0755 "$ROOT/window-reads/run-window-read-macos.sh" "$ROOT/window-reads-s1/run-window-read-macos.sh"
node -e '
  const fs=require("fs");const [src,dst,rsha]=process.argv.slice(1);
  const b=JSON.parse(fs.readFileSync(src));b.runner_sha256=rsha;
  fs.writeFileSync(dst,JSON.stringify(b,null,2)+"\n");' "$VPS/machines/window-reads/BASELINE-W1-MACOS-CANDIDATE-3.json" "$ROOT/window-reads/BASELINE-W1-MACOS-CANDIDATE-3.json" "$RSHA"
BSHA=$(sha "$ROOT/window-reads/BASELINE-W1-MACOS-CANDIDATE-3.json")
mkdir -p "$ROOT/_e2e/s1-apply"
subst() { sed -e "s/^GO_SHA=.*/GO_SHA=$GOSHA/" -e "s/^RUNNER_SHA=.*/RUNNER_SHA=$RSHA/" -e "s/^BASELINE_SHA=.*/BASELINE_SHA=$BSHA/" "$1" > "$2"; chmod 0755 "$2"; }
subst "$ROOT/window-reads/window-s0a.sh" "$ROOT/_e2e/window-s0a.sh"
subst "$ROOT/window-reads/window-row4.sh" "$ROOT/_e2e/window-row4.sh"
subst "$ROOT/window-reads-s1/window-s1read.sh" "$ROOT/_e2e/window-s1read.sh"
sed -e "s/^GO_SHA=.*/GO_SHA=$GOSHA/" "$ROOT/s1-apply/s1-apply.sh" > "$ROOT/_e2e/s1-apply/s1-apply.sh"; chmod 0755 "$ROOT/_e2e/s1-apply/s1-apply.sh"
cp "$ROOT/s1-apply/migrations-d189768b.tar" "$ROOT/s1-apply/MIGRATIONS-d189768b.sha256" "$ROOT/_e2e/s1-apply/"
# the copies differ from the published scripts only on the pinned-constant lines
for pair in "window-reads/window-s0a.sh:_e2e/window-s0a.sh" "window-reads/window-row4.sh:_e2e/window-row4.sh" "window-reads-s1/window-s1read.sh:_e2e/window-s1read.sh" "s1-apply/s1-apply.sh:_e2e/s1-apply/s1-apply.sh"; do
  a=${pair%%:*}; b=${pair#*:}
  d=$(diff "$ROOT/$a" "$ROOT/$b" | grep '^[<>]' | grep -Ev '^[<>] (GO_SHA|RUNNER_SHA|BASELINE_SHA)=' | wc -l | tr -d ' ')
  [ "$d" = 0 ] && ok "test copy of $(basename "$a") differs from the published script only on GO_SHA / RUNNER_SHA / BASELINE_SHA lines" || bad "test copy of $a differs elsewhere"
done

drive() { # drive NAME ANSWERS SCRIPT -> OUT, RC
  RC=0
  python3 "$WSD/driver.py" "$W/$1.out" "$2" -- env -i PATH="$SAFEPATH" HOME="$H" TERM=dumb /bin/bash "$3" || RC=$?
  OUT="$W/$1.out"
}
calls() { grep -c . "$ROOT/e2e-calls.log"; }
ans_s0a() {
  { printf 'Operator label\tOP-1\nWindow start\t%s\nWindow end\t%s\nCron-job.org\tyes\nPeople hold\tyes\nMaintenance flag\tno_flag\n' "$WS" "$WE"
    printf 'PITR enabled\ttrue\nPITR retention\t7\nEarliest recovery point\t%s\nLatest recovery point\t%s\nLatest base backup status\tCOMPLETED\nLatest base backup completed\t%s\nBase backup read from\tmanagement_api\nRecovery range read from\tdashboard\n' "$(nowplus -1800)" "$(nowplus -10)" "$(nowplus -60)"
    printf 'R-6 choice\taccept_rpo\nR-6 answer\tAccept the loss window for the cutover.\nR-6 decision reference\tdecision-ref-1\n0242 disposition (\tR-3\n0242 disposition reference\tdecision-ref-2\n'
    printf 'Supabase access token\t%s\nDatabase password\t%s\n' "$TOKEN" "$PASSWORD"; } > "$1"
}
ans_row4() { # ans_row4 FILE LATEOFF
  { printf 'Window start\t%s\nWindow end\t%s\nType exactly select\tselect\nType ready\tready\nBasis (\tlatest_at_or_after\n' "$WS" "$WE"
    printf 'PITR enabled\ttrue\nPITR retention\t7\nEarliest recovery point\t{now-86400}\nLatest recovery point\t{now%s}\nLatest base backup status\tCOMPLETED\nLatest base backup completed\t{now-3600}\nBase backup read from\tmanagement_api\nRecovery range read from\tdashboard\n' "$2"; } > "$1"
}
latest_r4() { ls -dt "$ROOT"/row4.* 2>/dev/null | head -1; }

# =====================================================================================================================
CUR=s0a
ans_s0a "$W/a-s0a.txt"; drive s0a "$W/a-s0a.txt" "$ROOT/_e2e/window-s0a.sh"
tail -n 24 "$OUT" | cut -c1-200
[ "$RC" = 0 ] && has "$OUT" "OVERALL PASS" && ok "window-s0a.sh -> OVERALL PASS (exit 0) in the chained world" || bad "window-s0a.sh" "rc=$RC"
[ "$(calls)" = 14 ] && ok "S0a made exactly 14 reads through the supabase-go the layout holds" || bad "S0a call count" "$(calls)"
CUR=row4-pass-1
ans_row4 "$W/a-r4.txt" "+0"; drive r4a "$W/a-r4.txt" "$ROOT/_e2e/window-row4.sh"
tail -n 12 "$OUT" | cut -c1-200
[ "$RC" = 0 ] && has "$OUT" "OVERALL PASS" && ok "window-row4.sh -> OVERALL PASS (exit 0)" || bad "window-row4.sh" "rc=$RC"
R4A=$(latest_r4); [ -f "$R4A/row4-attestation.json" ] && [ -f "$R4A/verdict.txt" ] && grep -qx 'OVERALL PASS' "$R4A/verdict.txt" && ok "row 4 left row4-attestation.json and verdict.txt (OVERALL PASS) under ~/hone-s1/$(basename "$R4A")" || bad "row-4 result files"
[ "$(calls)" = 14 ] && ok "row 4 made no hosted call (call count unchanged)" || bad "row 4 call count" "$(calls)"

CUR=negative
sleep 2
ans_row4 "$W/a-r4q.txt" "-120"; drive r4b "$W/a-r4q.txt" "$ROOT/_e2e/window-row4.sh"
[ "$RC" != 0 ] && has "$OUT" "latest_recovery_at_utc is before the selected restore point" && ok "a second row-4 run on a quiet database is refused (exit $RC)" || bad "second row-4 run not refused" "rc=$RC"
R4B=$(latest_r4); [ "$R4B" != "$R4A" ] && ! grep -qx 'OVERALL PASS' "$R4B/verdict.txt" 2>/dev/null && ok "the newest row-4 directory is the refused run (no OVERALL PASS in its verdict)" || bad "newest row-4 dir is not the refused run"
C0=$(calls)
printf 'Window start\t%s\nWindow end\t%s\n' "$WS" "$WE" > "$W/a-sa-neg.txt"
drive sa_neg "$W/a-sa-neg.txt" "$ROOT/_e2e/s1-apply/s1-apply.sh"
[ "$RC" != 0 ] && has "$OUT" "the latest row-4 run was refused (or did not finish): do not start S1" && ok "s1-apply.sh refuses after the passing run was followed by a refused one" || bad "s1-apply did not refuse" "rc=$RC"
[ "$(calls)" = "$C0" ] && ok "  ... with ZERO connections (the supabase-go call log did not change)" || bad "  ... connections were made" "$C0 -> $(calls)"
[ ! -e "$ROOT/s1-apply/FAILED-LOGIN" ] && [ "$(PSQL -c "select count(*)||'|'||max(version) from supabase_migrations.schema_migrations")" = "211|0212" ] && ok "  ... no tombstone, database history still 211 rows, max 0212" || bad "  ... state changed"

CUR=row4-pass-2
sleep 2
ans_row4 "$W/a-r4c.txt" "+0"; drive r4c "$W/a-r4c.txt" "$ROOT/_e2e/window-row4.sh"
[ "$RC" = 0 ] && has "$OUT" "OVERALL PASS" && ok "window-row4.sh again -> OVERALL PASS (a newer passing run)" || bad "window-row4.sh (third run)" "rc=$RC"
R4C=$(latest_r4); grep -qx 'OVERALL PASS' "$R4C/verdict.txt" 2>/dev/null && [ "$R4C" != "$R4B" ] && ok "the newest row-4 directory is the new passing run" || bad "newest row-4 dir"
RPOINT=$(sed -n 's/^ *"selected_at_utc": "\([^"]*\)".*/\1/p' "$R4C/row4-attestation.json" | head -1)

CUR=s1-apply
C1=$(calls)
{ printf 'Window start (UTC)\t%s\nWindow end (UTC)\t%s\nType the selected restore point exactly\t%s\nDatabase password\t%s\n' "$WS" "$WE" "$RPOINT" "$PASSWORD"
  printf 'printed  WATCHDOG armed\tyes\nprinted  watching for the push session\tyes\nType  APPLY  to run\tAPPLY\n'; } > "$W/a-sa.txt"
drive sa "$W/a-sa.txt" "$ROOT/_e2e/s1-apply/s1-apply.sh"
tail -n 16 "$OUT" | cut -c1-200
[ "$RC" = 0 ] && has "$OUT" "S1 APPLIED: exactly 34 migrations (0213 .. 0246) in order" && ok "s1-apply.sh with the REAL bundle 599adf08: dry run exactly 34, stub watchdog confirmation, push, exit 0" || bad "s1-apply.sh" "rc=$RC"
has "$OUT" "Dry run OK: exactly 34 migrations, 0213 .. 0246, in order." && ok "  ... the real CLI's dry-run output was parsed: exactly 34, 0213..0246 in order" || bad "  ... dry-run"
tail -n 2 "$ROOT/e2e-calls.log" | tr '\n' ';' | grep -q 'db push  dry-run' ; DRYLINES=$(grep -c 'db push  dry-run' "$ROOT/e2e-calls.log"); PUSHLINES=$(grep -c 'db push  yes' "$ROOT/e2e-calls.log")
[ "$DRYLINES" = 1 ] && [ "$PUSHLINES" = 1 ] && [ "$(( $(calls) - C1 ))" = 2 ] && ok "  ... exactly two connections: one dry run, one push" || bad "  ... connection count" "dry=$DRYLINES push=$PUSHLINES total=$(( $(calls) - C1 ))"
HIST1=$(PSQL -c "select count(*)||'|'||max(version) from supabase_migrations.schema_migrations")
[ "$HIST1" = "245|0246" ] && ok "  ... the synthetic database is at 0246 (245 history rows) after the real CLI push" || bad "  ... history" "$HIST1"
if grep -rqF --exclude-dir=real -e "$TOKEN" -e "$PASSWORD" "$OUT" "$ROOT" 2>/dev/null; then bad "a typed secret appears in a transcript or file under ~/hone-s1"; else ok "no typed secret appears in the s1-apply transcript or any file under ~/hone-s1"; fi

CUR=s1read
ans="$W/a-s1r.txt"; printf 'Supabase access token\t%s\nDatabase password\t%s\n' "$TOKEN" "$PASSWORD" > "$ans"
drive s1r "$ans" "$ROOT/_e2e/window-s1read.sh"
tail -n 16 "$OUT" | cut -c1-200
[ "$RC" = 0 ] && has "$OUT" "WINDOW S1 READ-BACK: OVERALL PASS" && ok "window-s1read.sh -> OVERALL PASS on the database s1-apply just migrated" || bad "window-s1read.sh" "rc=$RC"
for id in S1-1 S1-2 S1-2b S1-2c S1-3 S1-4; do has "$OUT" "PASS          $id " || bad "$id not PASS"; done; ok "S1-1, S1-2, S1-2b, S1-2c, S1-3 and S1-4 all PASS"
if grep -rqF --exclude-dir=real -e "$TOKEN" -e "$PASSWORD" "$OUT" "$ROOT" 2>/dev/null; then bad "a typed secret appears after s1read"; else ok "no typed secret appears in any transcript or file under ~/hone-s1 after the whole chain"; fi

CUR=final
snap > "$W/snap.final"
# the published scripts stay byte-identical to the VPS copies
for f in window-reads/window-s0a.sh window-reads/window-row4.sh s1-apply/s1-apply.sh window-reads-s1/window-s1read.sh d3-watchdog.zsh partc-script/partc-readback.sh s1-apply/migrations-d189768b.tar; do [ "$(sha "$ROOT/$f")" = "$(sha "$(src_of "$f")")" ] || bad "$f changed during the chain"; done; ok "the published scripts and the bundle are byte-identical to the VPS copies after the chain"
[ -z "$(find "$ROOT" -name FAILED-LOGIN)" ] && ok "no FAILED-LOGIN tombstone anywhere" || bad "a tombstone exists"
echo "wrapper call log:"; cat "$ROOT/e2e-calls.log"
cp "$STEPS" "$W/steps-final.tsv"
echo "passed: $pass failed: $fail"
[ "$fail" = 0 ] || exit 1
