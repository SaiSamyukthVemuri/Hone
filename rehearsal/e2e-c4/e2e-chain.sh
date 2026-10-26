#!/bin/bash
# REHEARSAL - NEVER MERGE. E2E-C4: the candidate-4 Mac scripts as ONE chain in ONE fake HOME on macOS arm64 (macos-14).
# Step 1: SEVEN published download lines as published (c3 install kept: WINDOW-COMMAND-MACOS a68f3def; c4 WINDOW-COMMAND-MACOS-C4 72f55345;
#         pitr-backups.sh 85407d0b; Team's s1-apply 2dfd3354; watchdog; window-s1read; partc), with a fake scp serving the real files (./vps).
# Step 2: REAL pitr-backups.sh (test copy) + REAL darwin supabase-go -> c4 window-s0a.sh (with the ack) -> c4 window-row4.sh (named_restore_point,
#         capture taken after the select) -> negatives (latest < stamp refused; s1-apply refuses it and a bare OVERALL PASS, zero connections)
#         -> row 4 again -> s1-apply (REAL bundle 599adf08, dry run 34, push to 0246) -> window-s1read OVERALL PASS.
# STUBBED: scp; the Management API (stub-api.py serving the real 2026-10-26 capture SHAPE: backups [], a physical range of exactly 7 days, with
#         the times made fresh); the S0 gate-file hosted reads (canned); the typed dashboard/restore-point answers; the watchdog confirmation;
#         PIN SUBSTITUTIONS in test copies (GO_SHA / RUNNER_SHA / BASELINE_SHA, baseline 4's runner and g4_pitr_api pins).
# REAL: every script's logic, the comparator and lib, the gate files, the bundle and its 34 migrations, the darwin supabase-go v2.102.0 (dce26b75).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
VPS="$HERE/vps"
WSD="$HERE/../window-script"
DRV="$HERE/driver.py"
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
TOKEN="sbp_$(openssl rand -hex 20)"   # a throwaway value made at run time (the real CLI validates the token shape); never stored in the repository
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
mkdir -p "$W/dl" && ( cd "$W/dl" && curl -fsSL -o cli.tgz https://github.com/supabase/cli/releases/download/v2.102.0/supabase_2.102.0_darwin_arm64.tar.gz && tar -xzf cli.tgz ) || { echo "could not fetch the CLI"; exit 2; }
echo "release archive members and sha256:"; ( cd "$W/dl" && tar -tzf cli.tgz && for f in $(tar -tzf cli.tgz); do [ -f "$f" ] && shasum -a 256 "$f"; done )
REALBIN=""
for f in "$W/dl/"*; do [ -f "$f" ] && [ "$(sha "$f")" = dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b ] && REALBIN="$f"; done
[ -n "$REALBIN" ] && ok "the real darwin_arm64 supabase-go v2.102.0 ($(basename "$REALBIN") in the release archive) hashes to the pinned dce26b75" || { bad "no member of the release archive hashes to dce26b75"; exit 2; }
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
snap() { ( cd "$ROOT" && find . -type f ! -path './e2e-*' ! -path './_e2e/*' ! -path './s1apply.*' ! -path './window.*' ! -path './row4.*' ! -path './s1read.*' ! -path './pitr-backups.*' ! -path './supabase-cli/real/*' | LC_ALL=C sort | while IFS= read -r f; do printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "${f#./}"; done ); }

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
L1C4=$(grep -E '^    \( set -u; S=\$\(mktemp -d\)' "$VPS/machines/window-reads-c4/WINDOW-COMMAND-MACOS-C4.md" | sed 's/^    //')
LPB=$(grep -E '^    \( set -u; S=\$\(mktemp -d\)' "$VPS/machines/pitr-status/PITR-BACKUPS-MACOS.md" | sed 's/^    //' | head -n 1)
L5=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).download_cmd)' "$VPS/willow/PARTC-LAST-END.json")
for n in 1 1C4 PB 2 3 4 5; do eval "l=\$L$n"; [ -n "$l" ] && [ "$(printf '%s\n' "$l" | grep -c '')" = 1 ] || bad "line $n is not exactly one line"; done
EXPECT1="window-reads/window-s0a.sh window-reads/window-row4.sh window-reads/BASELINE-W1-MACOS-CANDIDATE-3.json window-reads/G3-CHECKSUMS-d189768b.txt window-reads/compare-preflight.mjs window-reads/compare-preflight-lib.mjs"
EXPECT1C4="window-reads-c4/window-s0a.sh window-reads-c4/window-row4.sh window-reads-c4/compare-preflight.mjs window-reads-c4/compare-preflight-lib.mjs window-reads-c4/BASELINE-W1-MACOS-CANDIDATE-4.json window-reads-c4/G3-CHECKSUMS-d189768b.txt window-reads-c4/MANIFEST.sha256 window-reads-c4/run-window-read-macos.sh window-reads-c4/g02-history.sql window-reads-c4/g06-payment-drain.sql window-reads-c4/g07-sms-claimed-number-duplicates.sql window-reads-c4/g09a-0214-reach-summary.sql window-reads-c4/g09b-0214-reach-per-studio.sql window-reads-c4/g09c-0214-bound-account-mode.sql window-reads-c4/g09d-0214-currency-history.sql window-reads-c4/g10-constraint-names.sql window-reads-c4/g11-0244-legacy-laser-types.sql window-reads-c4/g11b-0244-legacy-laser-classes.sql window-reads-c4/g12-0243-intake-definers.sql window-reads-c4/census-0213-0246.sql window-reads-c4/s1-open-transactions.sql window-reads-c4/w03-table-sizes.sql"
EXPECTPB="pitr-status/pitr-backups.sh"
EXPECT2="s1-apply/s1-apply.sh s1-apply/migrations-d189768b.tar s1-apply/MIGRATIONS-d189768b.sha256"
EXPECT3="d3-watchdog.zsh"
EXPECT4="window-reads-s1/window-s1read.sh window-reads-s1/run-window-read-macos.sh window-reads-s1/MANIFEST.sha256 window-reads-s1/s1-history.sql window-reads-s1/census-0213-0246.sql window-reads-s1/s1-g10.sql window-reads-s1/s1-closures.sql window-reads-s1/s1-table-privileges.sql window-reads-s1/s1-body-md5.sql"
EXPECT5="partc-script/partc-readback.sh"
src_of() { # installed path (relative to ~/hone-s1) -> VPS source
  case "$1" in
    window-reads-c4/*) echo "$VPS/machines/window-reads-c4/${1#window-reads-c4/}" ;;
    pitr-status/*) echo "$VPS/machines/pitr-status/${1#pitr-status/}" ;;
    window-reads/*) echo "$VPS/machines/window-reads/${1#window-reads/}" ;;
    s1-apply/*) echo "$VPS/team/s1-apply/${1#s1-apply/}" ;;
    d3-watchdog.zsh) echo "$VPS/general/d3-watchdog.zsh" ;;
    window-reads-s1/*) echo "$VPS/machines/window-reads-s1/${1#window-reads-s1/}" ;;
    partc-script/*) echo "$VPS/willow/partc/${1#partc-script/}" ;;
  esac
}
snap > "$W/snap.0"; cp "$W/snap.0" "$W/snap.prev"
ALLNEW=""
for n in 1 1C4 PB 2 3 4 5; do
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
ok "all seven published download lines ran as published under zsh with a fake scp; every installed file equals its VPS copy"
# modes the scripts need
[ -x "$ROOT/window-reads-c4/window-s0a.sh" ] && [ -x "$ROOT/window-reads-c4/window-row4.sh" ] && [ -x "$ROOT/pitr-status/pitr-backups.sh" ] && [ -x "$ROOT/s1-apply/s1-apply.sh" ] && [ -x "$ROOT/window-reads-s1/window-s1read.sh" ] && [ -x "$ROOT/window-reads-s1/run-window-read-macos.sh" ] && [ -x "$ROOT/partc-script/partc-readback.sh" ] && ok "the installed scripts are executable" || bad "a script is not executable"
# the published watchdog step-2 line 1 (sha check) and a syntax check of the installed watchdog under zsh
W2=$(grep -E '^cd "\$HOME/hone-s1" && \[ "\$\(shasum' "$VPS/01-ops/watchdog-operator/WATCHDOG-OPERATOR.txt")
RC=0; OUT=$(env -i PATH="$SAFEPATH" HOME="$H" /bin/zsh -c "$W2" 2>&1) || RC=$?
[ "$OUT" = "watchdog sha256 OK" ] && ok "the watchdog step-2 line finds ~/hone-s1/d3-watchdog.zsh and prints: watchdog sha256 OK" || bad "watchdog step 2" "$OUT"
/bin/zsh -n "$ROOT/d3-watchdog.zsh" && ok "zsh -n d3-watchdog.zsh" || bad "watchdog syntax"
for s in "$ROOT/window-reads-c4/window-s0a.sh" "$ROOT/window-reads-c4/window-row4.sh" "$ROOT/pitr-status/pitr-backups.sh" "$ROOT/s1-apply/s1-apply.sh" "$ROOT/window-reads-s1/window-s1read.sh" "$ROOT/partc-script/partc-readback.sh"; do /bin/bash -n "$s" || bad "bash -n $s"; done; ok "bash -n on the installed scripts"
snap > "$W/snap.published"

# =====================================================================================================================
CUR=step2-setup
# ---- the wrapper becomes the supabase-go the scripts see; the real binary moves one directory down
mkdir -p "$ROOT/supabase-cli/real"; mv "$ROOT/supabase-cli/supabase-go" "$ROOT/supabase-cli/real/supabase-go"
cp "$HERE/supabase-go-wrapper.sh" "$ROOT/supabase-cli/supabase-go"; chmod 0755 "$ROOT/supabase-cli/supabase-go"
printf '%s\n' "$LOCALURL" > "$ROOT/e2e-target"; : > "$ROOT/e2e-calls.log"; : > "$ROOT/e2e-backups.log"
GOSHA=$(sha "$ROOT/supabase-cli/supabase-go")
mkdir -p "$ROOT/e2e-canned"
node "$WSD/gen-results.mjs" "$ROOT/e2e-canned" "$VPS/machines/window-reads-c4/BASELINE-W1-MACOS-CANDIDATE-4.json" "" "$WSD/window-reads" || { bad "canned results"; exit 2; }
# PIN SUBSTITUTIONS (test copies only): wrapper sha for GO_SHA / the runner's SUPABASE_GO_SHA256; the runner copies' sha in baseline 4's
# runner_sha256; baseline 4's g4_pitr_api pins (the test copy of pitr-backups.sh and the wrapper) for the sidecar the test copy writes.
sed "s/^SUPABASE_GO_SHA256=.*/SUPABASE_GO_SHA256=$GOSHA/" "$VPS/machines/window-reads/run-window-read-macos.sh" > "$W/runner.test"
RSHA=$(sha "$W/runner.test")
cp "$W/runner.test" "$ROOT/window-reads-c4/run-window-read-macos.sh"; cp "$W/runner.test" "$ROOT/window-reads-s1/run-window-read-macos.sh"; chmod 0755 "$ROOT/window-reads-c4/run-window-read-macos.sh" "$ROOT/window-reads-s1/run-window-read-macos.sh"
mkdir -p "$ROOT/_e2e/s1-apply"
subst() { sed -e "s/^GO_SHA=.*/GO_SHA=$GOSHA/" -e "s/^RUNNER_SHA=.*/RUNNER_SHA=$RSHA/" -e "s/^BASELINE_SHA=.*/BASELINE_SHA=$2/" "$1" > "$3"; chmod 0755 "$3"; }
sed -e "s/^GO_SHA=.*/GO_SHA=$GOSHA/" "$ROOT/pitr-status/pitr-backups.sh" > "$ROOT/_e2e/pitr-backups.sh"; chmod 0755 "$ROOT/_e2e/pitr-backups.sh"
PBSHA=$(sha "$ROOT/_e2e/pitr-backups.sh")
node -e '
  const fs=require("fs");const [src,dst,rsha,gosha,pbsha]=process.argv.slice(1);
  const b=JSON.parse(fs.readFileSync(src));b.runner_sha256=rsha;b.g4_pitr_api.supabase_go_sha256=gosha;b.g4_pitr_api.script_sha256=pbsha;
  fs.writeFileSync(dst,JSON.stringify(b,null,2)+"\n");' "$VPS/machines/window-reads-c4/BASELINE-W1-MACOS-CANDIDATE-4.json" "$ROOT/window-reads-c4/BASELINE-W1-MACOS-CANDIDATE-4.json" "$RSHA" "$GOSHA" "$PBSHA"
node -e '
  const fs=require("fs");const [src,dst,rsha]=process.argv.slice(1);
  const b=JSON.parse(fs.readFileSync(src));b.runner_sha256=rsha;
  fs.writeFileSync(dst,JSON.stringify(b,null,2)+"\n");' "$VPS/machines/window-reads/BASELINE-W1-MACOS-CANDIDATE-3.json" "$ROOT/window-reads/BASELINE-W1-MACOS-CANDIDATE-3.json" "$RSHA"
B4SHA=$(sha "$ROOT/window-reads-c4/BASELINE-W1-MACOS-CANDIDATE-4.json"); B3SHA=$(sha "$ROOT/window-reads/BASELINE-W1-MACOS-CANDIDATE-3.json")
subst "$ROOT/window-reads-c4/window-s0a.sh" "$B4SHA" "$ROOT/_e2e/window-s0a.sh"
subst "$ROOT/window-reads-c4/window-row4.sh" "$B4SHA" "$ROOT/_e2e/window-row4.sh"
subst "$ROOT/window-reads-s1/window-s1read.sh" "$B3SHA" "$ROOT/_e2e/window-s1read.sh"
sed -e "s/^GO_SHA=.*/GO_SHA=$GOSHA/" "$ROOT/s1-apply/s1-apply.sh" > "$ROOT/_e2e/s1-apply/s1-apply.sh"; chmod 0755 "$ROOT/_e2e/s1-apply/s1-apply.sh"
cp "$ROOT/s1-apply/migrations-d189768b.tar" "$ROOT/s1-apply/MIGRATIONS-d189768b.sha256" "$ROOT/_e2e/s1-apply/"
for pair in "window-reads-c4/window-s0a.sh:_e2e/window-s0a.sh" "window-reads-c4/window-row4.sh:_e2e/window-row4.sh" "window-reads-s1/window-s1read.sh:_e2e/window-s1read.sh" "s1-apply/s1-apply.sh:_e2e/s1-apply/s1-apply.sh" "pitr-status/pitr-backups.sh:_e2e/pitr-backups.sh"; do
  a=${pair%%:*}; b=${pair#*:}
  d=$(diff "$ROOT/$a" "$ROOT/$b" | grep '^[<>]' | grep -Ev '^[<>] (GO_SHA|RUNNER_SHA|BASELINE_SHA)=' | wc -l | tr -d ' ')
  [ "$d" = 0 ] && ok "test copy of $(basename "$a") differs from the published script only on GO_SHA / RUNNER_SHA / BASELINE_SHA lines" || bad "test copy of $a differs elsewhere"
done

drive() { # drive NAME ANSWERS SCRIPT -> OUT, RC
  RC=0
  python3 "$DRV" "$W/$1.out" "$2" -- env -i PATH="$SAFEPATH" HOME="$H" TERM=dumb /bin/bash "$3" || RC=$?
  OUT="$W/$1.out"
}
calls() { grep -c . "$ROOT/e2e-calls.log"; }
bcalls() { grep -c . "$ROOT/e2e-backups.log"; }
# capture NAME LATEST_OFFSET_S : the REAL pitr-backups.sh (test copy) with the REAL darwin supabase-go against a stub Management API that serves
# the real 2026-10-26 capture shape (backups [], pitr_enabled, walg_enabled, a physical range of EXACTLY 7 days). Writes $W/NAME.early/.late.
capture() {
  local lo="$2" js="$W/$1.api.json"
  node -e '
    const [out,lo]=process.argv.slice(1);const now=Math.floor(Date.now()/1000),latest=now+Number(lo);
    require("fs").writeFileSync(out,JSON.stringify({backups:[],physical_backup_data:{earliest_physical_backup_date_unix:latest-7*86400,latest_physical_backup_date_unix:latest},pitr_enabled:true,region:"us-east-1",walg_enabled:true}));' "$js" "$lo"
  python3 -I "$HERE/stub-api.py" "$js" "$W/$1.api.log" > "$W/$1.api.out" 2>&1 & local ap=$!
  local i=0; while [ $i -lt 20 ]; do /usr/bin/nc -z 127.0.0.1 8080 2>/dev/null && break; /bin/sleep 0.5; i=$((i+1)); done
  printf 'Supabase access token\t%s\n' "$TOKEN" > "$W/$1.tok"
  RC=0; python3 "$DRV" "$W/$1.out" "$W/$1.tok" -- env -i PATH="$SAFEPATH" HOME="$H" TERM=dumb /bin/bash "$ROOT/_e2e/pitr-backups.sh" >/dev/null 2>&1 || RC=$?
  kill $ap 2>/dev/null; wait $ap 2>/dev/null
  node -e '
    const [js,e,l]=process.argv.slice(1);const p=JSON.parse(require("fs").readFileSync(js)).physical_backup_data;
    const iso=(s)=>new Date(s*1000).toISOString().replace(/\.\d+Z$/,"Z");
    require("fs").writeFileSync(e,iso(p.earliest_physical_backup_date_unix));require("fs").writeFileSync(l,iso(p.latest_physical_backup_date_unix));' "$js" "$W/$1.early" "$W/$1.late"
  return $RC
}
ans_s0a() {
  { printf 'Operator label\tOP-1\nWindow start\t%s\nWindow end\t%s\nCron-job.org\tyes\nPeople hold\tyes\nMaintenance flag\tno_flag\n' "$WS" "$WE"
    printf 'PITR enabled\ttrue\nPITR retention\t7\nEarliest recovery point\t{cat:%s}\nLatest recovery point\t{cat:%s}\nUse the idle proof\tno\n' "$W/$2.early" "$W/$2.late"
    printf 'R-6 choice\taccept_rpo\nType exactly: base backup unverified\tbase backup unverified, restore not tested\nR-6 answer\tAccept the unverified base backup for the cutover.\nR-6 decision reference\tdecision-ref-1\n0242 disposition (\tR-3\n0242 disposition reference\tdecision-ref-2\n'
    printf 'Supabase access token\t%s\nDatabase password\t%s\n' "$TOKEN" "$PASSWORD"; } > "$1"
}
# row 4: select, the capture is taken by a background job AFTER the select stamp (as Sam would in another Terminal), then ready
ans_row4() { # ans_row4 FILE BASIS CAPNAME [SLEEP]
  { printf 'Window start\t%s\nWindow end\t%s\nType exactly select\tselect\nType ready when\t{sleep:%s}ready\nBasis (\t%s\n' "$WS" "$WE" "${4:-24}" "$2"
    [ "$2" = named_restore_point ] && printf 'Restore point name\ths1-e2e-rp\nRestore point status\tAVAILABLE\nRestore point completed at\t{now-2}\n'
    printf 'PITR enabled\ttrue\nPITR retention\t7\nEarliest recovery point\t{cat:%s}\nLatest recovery point\t{cat:%s}\n' "$W/$3.early" "$W/$3.late"; } > "$1"
}
row4_run() { # row4_run NAME BASIS LATEST_OFFSET_OF_THE_CAPTURE : starts the background capture 7 s after the script starts, then drives row 4
  local nm="$1" basis="$2" lo="$3"
  ( /bin/sleep 7; capture "cap-$nm" "$lo"; cp "$W/cap-$nm.early" "$W/$nm.early"; cp "$W/cap-$nm.late" "$W/$nm.late" ) &
  BG=$!
  ans_row4 "$W/a-$nm.txt" "$basis" "$nm"; drive "$nm" "$W/a-$nm.txt" "$ROOT/_e2e/window-row4.sh"; wait $BG
}
latest_r4() { ls -dt "$ROOT"/row4.* 2>/dev/null | head -1; }
L1='OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested)'

# =====================================================================================================================
CUR=pitr-backups
B0=$(bcalls); capture cap0 -120
[ $RC = 0 ] && ok "pitr-backups.sh (installed via its published line, test copy) ran with the REAL supabase-go against the stub API: exit 0" || { bad "pitr-backups.sh" "rc=$RC"; tail -20 "$W/cap0.out"; }
CAPD=$(ls -dt "$ROOT"/pitr-backups.* | head -n 1)
[ "$(bcalls)" = $((B0+1)) ] && [ "$(grep -c . "$W/cap0.api.log")" = 1 ] && grep -qx "GET /v1/projects/$REF/database/backups auth=yes" "$W/cap0.api.log" && ok "exactly ONE backups-list call reached the stub API: GET .../database/backups with a Bearer token (no write)" || bad "backups call shape" "$(cat "$W/cap0.api.log")"
[ -f "$CAPD/backups.json" ] && [ -f "$CAPD/backups.meta.json" ] && [ -f "$CAPD/backups.err" ] && [ -d "$CAPD/cwd" ] && ok "the capture has the real layout: backups.json, backups.meta.json, backups.err and cwd/" || bad "capture layout" "$(ls -A "$CAPD")"
tr -d '[:space:]' < "$CAPD/backups.json" | grep -q '"backups":\[\]' && ok "backups is [] (the real PITR shape)" || bad "backups not empty"

# =====================================================================================================================
CUR=s0a
ans_s0a "$W/a-s0a.txt" cap0; drive s0a "$W/a-s0a.txt" "$ROOT/_e2e/window-s0a.sh"
tail -n 24 "$OUT" | cut -c1-210
[ "$RC" = 0 ] && tr -d '\r' < "$OUT" | grep -Fxq "$L1" && ok "c4 window-s0a.sh (with the ack) -> $L1 (exit 0)" || bad "window-s0a.sh" "rc=$RC"
! { tr -d '\r' < "$OUT" | grep -qx 'OVERALL PASS'; } && ok "  ... no bare OVERALL PASS anywhere in the S0a transcript" || bad "  ... bare OVERALL PASS printed"
[ "$(calls)" = 14 ] && ok "S0a made exactly 14 reads through the supabase-go the layout holds" || bad "S0a call count" "$(calls)"
grep -q '"base_backup_unverified_ack": true' "$ROOT"/window.*/attest/attestation.json && ! grep -qE 'latest_base_backup|base_backup_source' "$ROOT"/window.*/attest/attestation.json && ok "  ... the attestation carries the ack and no typed base-backup field" || bad "  ... attestation"

# =====================================================================================================================
CUR=row4-pass-1
row4_run r4a named_restore_point -1
tail -n 14 "$OUT" | cut -c1-210
[ "$RC" = 0 ] && tr -d '\r' < "$OUT" | grep -Fxq "$L1" && ok "c4 window-row4.sh, basis named_restore_point (stubbed restore point values, capture taken after the select) -> $L1 (exit 0)" || bad "window-row4.sh (named_restore_point)" "rc=$RC"
R4A=$(latest_r4); [ -f "$R4A/row4-attestation.json" ] && grep -Fxq "$L1" "$R4A/verdict.txt" && ok "row 4 left row4-attestation.json and verdict.txt (the labelled line) under ~/hone-s1/$(basename "$R4A")" || bad "row-4 result files"
[ "$(calls)" = 14 ] && ok "row 4 made no database connection (call count unchanged)" || bad "row 4 call count" "$(calls)"

# =====================================================================================================================
CUR=negatives
sleep 2
# N1: no restore point (latest_at_or_after) and the latest recovery point is BEFORE the stamp (the capture's latest is 120 s old)
row4_run r4b latest_at_or_after -120
[ "$RC" != 0 ] && has "$OUT" "before the selected restore point" && ok "N1: a row-4 run without a restore point (latest_at_or_after) whose latest recovery point is before the stamp is refused (exit $RC)" || { bad "N1 row-4 not refused" "rc=$RC"; tail -12 "$OUT"; }
R4B=$(latest_r4); [ "$R4B" != "$R4A" ] && ! grep -Fxq "$L1" "$R4B/verdict.txt" 2>/dev/null && ok "  ... the newest row-4 directory is the refused run" || bad "  ... newest row-4 dir is not the refused run"
C0=$(calls)
printf 'Window start\t%s\nWindow end\t%s\n' "$WS" "$WE" > "$W/a-sa-neg.txt"
drive sa_neg "$W/a-sa-neg.txt" "$ROOT/_e2e/s1-apply/s1-apply.sh"
[ "$RC" != 0 ] && has "$OUT" "the latest row-4 run was refused" && ok "  ... s1-apply.sh refuses after the passing run was followed by a refused one" || bad "  ... s1-apply did not refuse" "rc=$RC"
[ "$(calls)" = "$C0" ] && ok "  ... with ZERO connections" || bad "  ... connections were made" "$C0 -> $(calls)"
# N2: a bare OVERALL PASS verdict (a newer row-4 directory whose verdict.txt is the unlabelled line)
BARE0="$ROOT/row4.bare0"
mkdir -p "$BARE0" && chmod 700 "$BARE0" && cp "$R4A/row4-attestation.json" "$BARE0/" && printf 'OVERALL PASS\n' > "$BARE0/verdict.txt" && touch "$BARE0" "$BARE0"/*
[ "$(latest_r4)" = "$BARE0" ] || bad "N2 setup: the bare directory is not the newest"
drive sa_bare "$W/a-sa-neg.txt" "$ROOT/_e2e/s1-apply/s1-apply.sh"
[ "$RC" != 0 ] && has "$OUT" "accepts only the candidate-4 line" && ok "N2: s1-apply.sh refuses a bare 'OVERALL PASS' row-4 verdict (exit $RC)" || { bad "N2 s1-apply accepted or mis-refused a bare PASS" "rc=$RC"; tail -6 "$OUT"; }
[ "$(calls)" = "$C0" ] && ok "  ... with ZERO connections" || bad "  ... connections were made" "$C0 -> $(calls)"
rm -rf "${ROOT:?}/row4.bare0"
[ ! -e "$ROOT/s1-apply/FAILED-LOGIN" ] && [ "$(PSQL -c "select count(*)||'|'||max(version) from supabase_migrations.schema_migrations")" = "211|0212" ] && ok "  ... no tombstone; database history still 211 rows, max 0212" || bad "  ... state changed"

# =====================================================================================================================
CUR=row4-pass-2
sleep 2
row4_run r4c named_restore_point -1
[ "$RC" = 0 ] && tr -d '\r' < "$OUT" | grep -Fxq "$L1" && ok "c4 window-row4.sh again (named_restore_point) -> $L1 (a newer passing run)" || { bad "window-row4.sh (third run)" "rc=$RC"; tail -12 "$OUT"; }
R4C=$(latest_r4); grep -Fxq "$L1" "$R4C/verdict.txt" 2>/dev/null && [ "$R4C" != "$R4B" ] && ok "the newest row-4 directory is the new passing run" || bad "newest row-4 dir"
RPOINT=$(sed -n 's/^ *"selected_at_utc": "\([^"]*\)".*/\1/p' "$R4C/row4-attestation.json" | head -1)

# =====================================================================================================================
CUR=s1-apply
C1=$(calls)
{ printf 'Window start (UTC)\t%s\nWindow end (UTC)\t%s\nType the selected restore point exactly\t%s\nDatabase password\t%s\n' "$WS" "$WE" "$RPOINT" "$PASSWORD"
  printf 'printed  WATCHDOG armed\tyes\nprinted  watching for the push session\tyes\nType  APPLY  to run\tAPPLY\n'; } > "$W/a-sa.txt"
drive sa "$W/a-sa.txt" "$ROOT/_e2e/s1-apply/s1-apply.sh"
tail -n 16 "$OUT" | cut -c1-200
[ "$RC" = 0 ] && has "$OUT" "S1 APPLIED: exactly 34 migrations (0213 .. 0246) in order" && ok "s1-apply.sh (Team's new line, 2dfd3354) with the REAL bundle 599adf08: dry run exactly 34, stub watchdog confirmation, push to 0246, exit 0" || bad "s1-apply.sh" "rc=$RC"
has "$OUT" "Dry run OK: exactly 34 migrations, 0213 .. 0246, in order." && ok "  ... the real CLI's dry-run output was parsed: exactly 34, 0213..0246 in order" || bad "  ... dry-run"
DRYLINES=$(grep -cE 'db push +dry-run' "$ROOT/e2e-calls.log"); PUSHLINES=$(grep -cE 'db push +yes' "$ROOT/e2e-calls.log")
[ "$DRYLINES" = 1 ] && [ "$PUSHLINES" = 1 ] && [ "$(( $(calls) - C1 ))" = 2 ] && ok "  ... exactly two connections: one dry run, one push" || bad "  ... connection count" "dry=$DRYLINES push=$PUSHLINES total=$(( $(calls) - C1 ))"
HIST1=$(PSQL -c "select count(*)||'|'||max(version) from supabase_migrations.schema_migrations")
[ "$HIST1" = "245|0246" ] && ok "  ... the synthetic database is at 0246 (245 history rows) after the real CLI push" || bad "  ... history" "$HIST1"
if grep -rqF --exclude-dir=real -e "$TOKEN" -e "$PASSWORD" "$OUT" "$ROOT" 2>/dev/null; then bad "a typed secret appears in a transcript or file under ~/hone-s1"; else ok "no typed secret appears in the s1-apply transcript or any file under ~/hone-s1"; fi

CUR=s1read
ans="$W/a-s1r.txt"; printf 'Supabase access token\t%s\nDatabase password\t%s\n' "$TOKEN" "$PASSWORD" > "$ans"
drive s1r "$ans" "$ROOT/_e2e/window-s1read.sh"
tail -n 16 "$OUT" | cut -c1-200
[ "$RC" = 0 ] && has "$OUT" "WINDOW S1 READ-BACK: OVERALL PASS" && ok "window-s1read.sh -> OVERALL PASS on the database s1-apply just migrated (it uses the kept c3 install in ~/hone-s1/window-reads)" || bad "window-s1read.sh" "rc=$RC"
for id in S1-1 S1-2 S1-2b S1-2c S1-3 S1-4; do has "$OUT" "PASS          $id " || bad "$id not PASS"; done; ok "S1-1, S1-2, S1-2b, S1-2c, S1-3 and S1-4 all PASS"
if grep -rqF --exclude-dir=real -e "$TOKEN" -e "$PASSWORD" "$OUT" "$ROOT" 2>/dev/null; then bad "a typed secret appears after s1read"; else ok "no typed secret appears in any transcript or file under ~/hone-s1 after the whole chain"; fi

CUR=final
snap > "$W/snap.final"
for f in window-reads-c4/window-s0a.sh window-reads-c4/window-row4.sh pitr-status/pitr-backups.sh s1-apply/s1-apply.sh window-reads-s1/window-s1read.sh d3-watchdog.zsh partc-script/partc-readback.sh s1-apply/migrations-d189768b.tar; do [ "$(sha "$ROOT/$f")" = "$(sha "$(src_of "$f")")" ] || bad "$f changed during the chain"; done; ok "the published scripts and the bundle stayed byte-identical to the VPS copies"
for f in window-reads/window-s0a.sh window-reads/window-row4.sh window-reads/compare-preflight.mjs window-reads/compare-preflight-lib.mjs; do [ "$(sha "$ROOT/$f")" = "$(sha "$(src_of "$f")")" ] || bad "the kept c3 install changed: $f"; done; ok "the kept c3 install in ~/hone-s1/window-reads (scripts, comparator, lib) is byte-identical to the VPS copies"
[ -z "$(find "$ROOT" -name FAILED-LOGIN)" ] && ok "no FAILED-LOGIN tombstone anywhere" || bad "a tombstone exists"
echo "wrapper call log:"; cat "$ROOT/e2e-calls.log"; echo "backups log:"; cat "$ROOT/e2e-backups.log"
cp "$STEPS" "$W/steps-final.tsv"
echo "passed: $pass failed: $fail"
[ "$fail" = 0 ] || exit 1
