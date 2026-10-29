#!/bin/bash
# REHEARSAL - NEVER MERGE. CI check of the STAGE-0248-ONLINE delta (no hosted access, no database, canary secrets only). It runs the REAL text of
# s1-apply-0248-online.sh, s1-reconcile-0248-online.sh and g02-read-0248-online.sh; a test variant differs from the shipped file ONLY inside the #CONST and #GOPEND blocks
# (asserted). The terminal is a FIFO fed one line per read; supabase-go, the read-back script and the runner's pinned binary hash are stubs. N of N asserted.
# Runs under bash 3.2 (macOS) and bash 5 (Linux). Reuses, and does not repeat, the earlier evidence for the unchanged bundle gate (67/67 cases, 18/18 mutations).
set -u
D="$(cd "$(dirname "$0")" && pwd)"; T=${RUNNER_TEMP:-/tmp}/online0248; rm -rf "$T"; mkdir -p "$T/tv"
pass=0; fail=0; ok() { pass=$((pass+1)); echo "ok   - $1"; }; bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
A=$D/s1-apply-0248-online.sh; R=$D/s1-reconcile-0248-online.sh; G=$D/g02-read-0248-online.sh; REF=$D/reference
CTOK=canary-token-4f1c; CPW=canary-pw-9d2e

# ------------------------------------------------------------------ pins: the package values, hard-coded here on purpose
P_RUNNER=471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357; P_MANIFEST=df3e4e9a6d2601a67c79d7ef97c33f738ea271da2cee58f09b9fa3ed77c01f52
P_G02=19e4e05793e5fa033921ac35cd2a7337b7a6477d0f6a25747134791f7b317cfe; P_G12=e4080f1d35d9c0219a27c23238451b830dd39360be11dda6561221f081a6ed79
P_OPEN=b110fd6052e9cc237e44c7f585ad0bcae48d75d456b29331e84fb1cf3713b207; P_W03=82ff0460f682b95b20b019ab26f1458883b372d91e5329c12a3d58101f03750e
P_S1READ=6c96ff3b78bc63985003fc89771643768e9aca4121fb28e10d2e2ea9ca85cfd6; P_S1MAN=c7666befb9c7c8806d24417d404f80085fe71953bcd0ae1eba7e49d0981653f4
P_GO=dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b; P_BUNDLE=c9ebfcec810cf1fe49119c38e64beb0eba63230a21be502531464818a79c7fc7
P_LIST=c71fb7674fdaad384bfabb42185df7b3240207afabc9c4e641760eb5ce376c80; P_SEALED=1f6f9ad0026cee66b970e9dc630f1497aa10966df2adb9433d8f8c85bbc44cc3
P_APPLY0=a31e048b98ccef87955425d60d32c28587bb641d884b804faf8dc6aaab403ec9; P_REC0=91bbee68476e92d6bad0529a11d43c26651420f00153f4c2205a2715b7042c72
[ "$(sha "$REF/s1-apply-0248.a31e048b.sh")" = $P_APPLY0 ] && [ "$(sha "$REF/s1-reconcile-0248.91bbee68.sh")" = $P_REC0 ] && ok "the reference copies are the pinned originals a31e048b and 91bbee68" || bad "reference originals differ"
c=0; for pair in run-window-read-macos.sh:$P_RUNNER MANIFEST.sha256:$P_MANIFEST g02-history-0248.sql:$P_G02 g12-0243-intake-definers-0248.sql:$P_G12 s1-open-transactions-0248.sql:$P_OPEN w03-table-sizes-0248.sql:$P_W03 window-s1read-0248.sh:$P_S1READ; do
  [ "$(sha "$REF/${pair%%:*}")" = "${pair#*:}" ] || { c=1; bad "reference ${pair%%:*} is not its pin"; }; done
[ $c = 0 ] && ok "the pinned runner 471ecb9d, manifest df3e4e9a, four gate queries and read-back script 6c96ff3b equal their pins"
(cd "$REF" && grep -E "^($P_G02|$P_G12|$P_OPEN|$P_W03)  " MANIFEST.sha256 | wc -l | tr -d ' ') | grep -qx 4 && ok "the four pinned queries are exactly the four manifest entries" || bad "manifest does not list the four queries"
# the shipped scripts carry the package constants in their #CONST blocks
cv() { sed -n "s/^$2=//p" "$1" | head -1; }
c=0; for kv in GO_SHA:$P_GO BUNDLE_SHA:$P_BUNDLE LIST_SHA:$P_LIST SEALED_SHA:$P_SEALED RUNNER_SHA:$P_RUNNER RMANIFEST_SHA:$P_MANIFEST S1READ_SHA:$P_S1READ S1RUNNER_SHA:$P_RUNNER S1MANIFEST_SHA:$P_S1MAN SQL_S1H:a4d3c5afad277cef9c720ea534309b6e6843d92e8ecf15b5232e180f03246e2a SQL_G02:$P_G02 SQL_G12:$P_G12 SQL_OPEN:$P_OPEN SQL_W03:$P_W03 PLAT_OS:Darwin PLAT_ARCH:arm64 TTY:/dev/tty; do
  [ "$(cv "$A" "${kv%%:*}")" = "${kv#*:}" ] || { c=1; bad "apply constant ${kv%%:*} is not the pin"; }; done
[ $c = 0 ] && ok "the apply script's constants are the package pins (Darwin, arm64, /dev/tty, binary, bundle, runner, manifest, queries, read-back)"
c=0; for kv in GO_SHA:$P_GO RUNNER_SHA:$P_RUNNER RMANIFEST_SHA:$P_MANIFEST SQL_G02:$P_G02 PLAT_OS:Darwin PLAT_ARCH:arm64 TTY:/dev/tty; do [ "$(cv "$G" "${kv%%:*}")" = "${kv#*:}" ] || { c=1; bad "g02 helper constant ${kv%%:*} is not the pin"; }; done
[ $c = 0 ] && ok "the g02 helper's constants are the package pins"
grep -q "^SQL_G02=$P_G02\$" "$R" && grep -q "^RUNNER_SHA=$P_RUNNER\$" "$R" && grep -q "^SQL_S1H=a4d3c5af" "$R" && ok "the reconcile variant pins the g02 query, the runner and the s1 history query" || bad "reconcile pins"

# ------------------------------------------------------------------ the REMOVALS and the unchanged regions, against a31e048b
O=$REF/s1-apply-0248.a31e048b.sh
region() { awk -v s="$2" -v e="$3" 'index($0,s)==1 {on=1} on {print} on && index($0,e)==1 {exit}' "$1"; }
b1=$(region "$O" '[ -f "$SELF/$BUNDLE" ]' '# a fresh private project dir'); b2=$(region "$A" '[ -f "$SELF/$BUNDLE" ]' '# a fresh private project dir')
[ -n "$b1" ] && [ "$b1" = "$b2" ] && ok "the bundle gate (Part 1) is byte-identical to a31e048b" || bad "the bundle gate differs from a31e048b"
d1=$(region "$O" 'STAGE=dry-run' 'echo "dry run listed exactly'); d2=$(region "$A" 'STAGE=dry-run' 'echo "dry run listed exactly')
[ -n "$d1" ] && [ "$d1" = "$d2" ] && ok "the dry-run block (exactly 0248, auth tombstone, scan) is byte-identical to a31e048b" || bad "the dry-run block differs"
sf1=$(sed -n '/^#SINGLEFLIGHT-BEGIN$/,/^#SINGLEFLIGHT-END$/p' "$O" | grep -v '^#' | sed 's/s1-reconcile-0248.sh/X/g'); sf2=$(sed -n '/^#SINGLEFLIGHT-BEGIN$/,/^#SINGLEFLIGHT-END$/p' "$A" | grep -v '^#' | sed 's/s1-reconcile-0248-online.sh/X/g')
[ "$sf1" = "$sf2" ] && ok "the single-flight gate refuses on ANY marker exactly as a31e048b (only the reconcile script's name differs)" || bad "single-flight gate changed"
ex=$(grep -v '^ *#' "$A" | grep -Ev '^ *echo ' | grep -E 'Window start|Window end|WSTART|WEND|S0A_|s0a_gate|window\.\*|row4|R4DIR|RPOINT|restore point|WATCHDOG|watchdog|-ge 75|-le 3600|-le 2700' | head -3)
[ -z "$ex" ] && ok "REMOVED: no window prompt, S0a record or age gate, row-4 restore point, 75/120-minute timer or watchdog prompt remains in executable text" || bad "a removed item remains" "$ex"
prompts=$(grep -v '^ *#' "$A" | grep -E '^ *ask [A-Z0-9]+ ' | sed -E 's/^ *ask ([A-Z0-9]+) .*/\1/' | tr '\n' ' '); tty_reads=$(grep -v '^ *#' "$A" | grep -c 'read -rs -p')
[ "$prompts" = "GOWORD " ] && [ "$tty_reads" = 2 ] && ok "the only prompts: one APPLY (before any credential) and the two hidden credential entries" || bad "prompt set is '$prompts' / hidden reads $tty_reads"
grep -v '^ *#' "$A" | grep -Ev '^ *(echo|printf|\{|\}) ' | grep -Eiq 'alter role|psql|set statement_timeout|pg_logical_emit|pg_create_restore_point|--include-all' && bad "a settings write, heartbeat or restore point appears in the apply text" || ok "NO settings write: no ALTER ROLE, SET, psql, heartbeat, restore point or --include-all in the executable text"

# ------------------------------------------------------------------ test fixtures: stub binary, test runner copy, synthetic bundle (one-time)
TV=$T/tv; cp "$D/stubs/supabase-go" "$TV/supabase-go"; chmod 755 "$TV/supabase-go"; STUBSHA=$(sha "$TV/supabase-go")
sed "s/^SUPABASE_GO_SHA256=.*/SUPABASE_GO_SHA256=$STUBSHA/" "$REF/run-window-read-macos.sh" > "$TV/run-window-read-macos.sh"; chmod 755 "$TV/run-window-read-macos.sh"
diff <(sed '/^SUPABASE_GO_SHA256=/d' "$REF/run-window-read-macos.sh") <(sed '/^SUPABASE_GO_SHA256=/d' "$TV/run-window-read-macos.sh") >/dev/null && ok "the test runner copy differs from 471ecb9d only in the pinned-binary constant (its header allows exactly that)" || bad "runner copy differs elsewhere"
TRUN=$(sha "$TV/run-window-read-macos.sh"); echo "stub s1 manifest" > "$TV/S1MAN"; TS1MAN=$(sha "$TV/S1MAN")
python3 -I - "$TV" <<'PY'
import hashlib, io, os, sys, tarfile
t = sys.argv[1]; P = "supabase/migrations/"
f = {}
for v in range(1, 247):
    if v == 100: continue
    f["%s%04d_x%d.sql" % (P, v, v)] = ("select %d;\n" % v).encode()
f[P + "0248_intake_protected_write_enforcement.sql"] = b"select 248; -- synthetic stand-in for the sealed file\n"
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as tf:
    for d in ("supabase", "supabase/migrations"):
        ti = tarfile.TarInfo(d + "/"); ti.type = tarfile.DIRTYPE; ti.mode = 0o755; tf.addfile(ti)
    for n in sorted(f):
        ti = tarfile.TarInfo(n); ti.size = len(f[n]); ti.mode = 0o644; tf.addfile(ti, io.BytesIO(f[n]))
open(os.path.join(t, "b.tar"), "wb").write(buf.getvalue())
open(os.path.join(t, "l.txt"), "w").write("".join("%s  %s\n" % (hashlib.sha256(f[n]).hexdigest(), os.path.basename(n)) for n in sorted(f)))
open(os.path.join(t, "sealed.txt"), "w").write(hashlib.sha256(f[P + "0248_intake_protected_write_enforcement.sql"]).hexdigest())
PY
TBUN=$(sha "$TV/b.tar"); TLIST=$(sha "$TV/l.txt"); TSEAL=$(cat "$TV/sealed.txt")
[ "$(grep -c '' "$TV/l.txt")" = 246 ] && ok "the synthetic bundle has 246 files, 0001..0246 less one slot plus a stand-in 0248 (the gate is the real text)" || bad "synthetic bundle"

want() { [ -z "${ONLY:-}" ] || echo ",${ONLY}," | grep -q ",$1,"; }
N=0
mkdir -p "$T/bin" "$T/shim"; ln -sf "$(node -p 'process.execPath')" "$T/bin/node"; export PATH="$T/bin:$PATH"
mkvar() { # mkvar SRC DST CONSTFILE [GOPENDFILE]
  awk -v cf="$3" -v gf="${4:-}" '
    /^#CONST-BEGIN$/ {print; while ((getline l < cf) > 0) print l; skip=1; next}
    /^#CONST-END$/ {skip=0}
    gf != "" && /^#GOPEND-BEGIN$/ {print; while ((getline l < gf) > 0) print l; skip=1; next}
    /^#GOPEND-END$/ {skip=0}
    !skip {print}' "$1" > "$2"
}
# newhome: a fresh fake HOME with the installed layout. Sets H.
newhome() {
  N=$((N+1)); H=$T/h$N; local r=$H/hone-s1
  mkdir -p "$r/supabase-cli" "$r/window-reads-0248" "$r/window-reads-s1-0248" "$r/s1-apply-0248-online" "$r/s1-apply"; chmod 700 "$r" "$r/window-reads-0248" "$r/window-reads-s1-0248"
  cp "$TV/supabase-go" "$r/supabase-cli/supabase-go"
  cp "$TV/run-window-read-macos.sh" "$r/window-reads-0248/"; cp "$TV/run-window-read-macos.sh" "$r/window-reads-s1-0248/"
  cp "$REF"/MANIFEST.sha256 "$REF"/g02-history-0248.sql "$REF"/g12-0243-intake-definers-0248.sql "$REF"/s1-open-transactions-0248.sql "$REF"/w03-table-sizes-0248.sql "$r/window-reads-0248/"
  cp "$TV/S1MAN" "$r/window-reads-s1-0248/MANIFEST.sha256"
  sed "s#__TTY__#$H/tty#" "$D/stubs/window-s1read-0248.sh" > "$r/window-reads-s1-0248/window-s1read-0248.sh"; chmod 755 "$r/window-reads-s1-0248/window-s1read-0248.sh"
  cp "$TV/b.tar" "$r/s1-apply-0248-online/migrations-stage0248.tar"; cp "$TV/l.txt" "$r/s1-apply-0248-online/MIGRATIONS-stage0248.sha256"
  : > "$H/stubcfg"
}
cfgset() { printf '%s\n' "$@" >> "$H/stubcfg"; }
mkconst() { # mkconst SCRIPTKIND -> $H/const.txt for the apply (full) or g02 helper (short)
  local s1sha; s1sha=$(sha "$H/hone-s1/window-reads-s1-0248/window-s1read-0248.sh")
  { echo "PLAT_OS=$(uname -s)"; echo "PLAT_ARCH=$(uname -m)"; echo "TTY=$H/tty"; echo "GO_SHA=$STUBSHA"
    if [ "$1" = apply ]; then echo "BUNDLE=migrations-stage0248.tar"; echo "BUNDLE_SHA=$TBUN"; echo "LIST=MIGRATIONS-stage0248.sha256"; echo "LIST_SHA=$TLIST"; echo "SEALED_SHA=$TSEAL"; fi
    echo "RUNNER_SHA=$TRUN"; echo "RMANIFEST_SHA=$P_MANIFEST"
    if [ "$1" = apply ]; then echo "S1READ_SHA=$s1sha"; echo "S1RUNNER_SHA=$TRUN"; echo "S1MANIFEST_SHA=$TS1MAN"; echo "SQL_S1H=a4d3c5afad277cef9c720ea534309b6e6843d92e8ecf15b5232e180f03246e2a"; echo "SQL_G02=$P_G02"; echo "SQL_G12=$P_G12"; echo "SQL_OPEN=$P_OPEN"; echo "SQL_W03=$P_W03"; else echo "SQL_G02=$P_G02"; fi; } > "$H/const.txt"
  echo "$TSEAL  0248_intake_protected_write_enforcement.sql" | sed "s/^/'/; s/\$/'/" | sed "1s/^/GOPEND=/" > "$H/gopend.txt"
}
mkapply() { # mkapply [SRC] : the variant of the apply script inside the fake HOME (mutations pass another SRC)
  mkconst apply; mkvar "${1:-$A}" "$H/hone-s1/s1-apply-0248-online/s1-apply-0248-online.sh" "$H/const.txt" "$H/gopend.txt"; VAR=$H/hone-s1/s1-apply-0248-online/s1-apply-0248-online.sh
}
# feed: a FIFO terminal. ONE persistent writer (fd 9, O_RDWR) holds the FIFO open and holds ALL the lines, so no reader's close can race a writer's open (a
# writer-per-line feeder loses lines that way); each read of the script takes exactly one line and the lines left over are counted afterwards.
leftover() { python3 -I -c 'import os,sys
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NONBLOCK)
d=b""
while True:
    try: x=os.read(fd,4096)
    except BlockingIOError: break
    if not x: break
    d+=x
print(d.count(b"\n"))' "$1"; }
runscript() { # runscript SCRIPT line... -> RC OUT CONSUMED TIMEOUT
  local script="$1"; shift; local total=$#
  rm -f "$H/tty"; mkfifo "$H/tty"; exec 9<>"$H/tty"; printf '%s\n' "$@" >&9
  TIMEOUT=0; local i=0
  ( cd "$H" && exec env -i HOME="$H" PATH="$PATH" LC_ALL=C /bin/bash "$script" ) > "$H/out.txt" 2>&1 & local p=$!
  while kill -0 $p 2>/dev/null; do sleep 0.2; i=$((i+1)); if [ $i -gt 200 ]; then kill -9 $p 2>/dev/null; TIMEOUT=1; break; fi; done
  wait $p 2>/dev/null; RC=$?
  CONSUMED=$(( total - $(leftover "$H/tty") )); exec 9>&-; rm -f "$H/tty"
  OUT=$(cat "$H/out.txt")
}
calls() { [ -f "$H/calls.log" ] && sed -E 's/ sql=.*//' "$H/calls.log" | tr '\n' ' ' | sed 's/ $//' || true; }
marker() { [ -f "$H/hone-s1/s1-apply/APPLY-STATE" ] && awk '{print $1}' "$H/hone-s1/s1-apply/APPLY-STATE" || echo none; }
receipt_of() { echo "$OUT" | sed -n 's/^RESULT: //p' | head -1; }
leaks() { rm -f "$H/tty"; { [ -f "$H/leak.log" ] && cat "$H/leak.log"; grep -rIl -e "$CTOK" -e "$CPW" "$H" 2>/dev/null | grep -v -e '/stubcfg$' -e '/supabase-cli/supabase-go$' ; echo "$OUT" | grep -e "$CTOK" -e "$CPW"; } | head -3; }
READS4="query:g02-history-0248 query:g12-0243-intake-definers-0248 query:s1-open-transactions-0248 query:w03-table-sizes-0248"
APPLYIN=(APPLY "$CTOK" "$CPW" "$CTOK" "$CPW")

# expect_stop NAME 'cfg lines (; separated)' 'STOP regex' 'expected calls' [marker]  : the run must STOP before the push with this reason and nothing pushed
expect_stop() {
  local name="$1" cfgs="$2" pat="$3" want="$4"
  newhome; [ -z "$cfgs" ] || cfgset $(echo "$cfgs" | tr ';' ' '); mkapply; runscript "$VAR" "${APPLYIN[@]}"
  local got; got=$(calls); local rc_ok=0; [ $RC != 0 ] && [ $TIMEOUT = 0 ] && rc_ok=1
  if [ $rc_ok = 1 ] && echo "$OUT" | grep -Eq "STOP: .*($pat)" && [ "$got" = "$want" ] && [ "$(receipt_of)" = "NOT APPLIED" ] && [ "$(marker)" = none ] && [ -z "$(leaks)" ]; then ok "$name"
  else bad "$name" "rc=$RC timeout=$TIMEOUT calls=[$got] want=[$want] marker=$(marker) receipt=$(receipt_of) $(echo "$OUT" | grep STOP | head -2) leaks=$(leaks)"; fi
}

# ------------------------------------------------------------------ the variant differs only in the constant blocks
newhome; mkapply
diff <(sed '/^#CONST-BEGIN$/,/^#CONST-END$/d;/^#GOPEND-BEGIN$/,/^#GOPEND-END$/d' "$A") <(sed '/^#CONST-BEGIN$/,/^#CONST-END$/d;/^#GOPEND-BEGIN$/,/^#GOPEND-END$/d' "$VAR") >/dev/null && ok "the apply test variant differs from the shipped script ONLY inside #CONST and #GOPEND" || bad "apply variant differs outside the constant blocks"
mkconst g02; mkvar "$G" "$H/g.sh" "$H/const.txt"
diff <(sed '/^#CONST-BEGIN$/,/^#CONST-END$/d' "$G") <(sed '/^#CONST-BEGIN$/,/^#CONST-END$/d' "$H/g.sh") >/dev/null && ok "the g02 helper test variant differs ONLY inside #CONST" || bad "g02 variant differs outside the constant block"

if want A; then
# ------------------------------------------------------------------ A. the happy path
newhome; mkapply; runscript "$VAR" "${APPLYIN[@]}"
want="$READS4 dry push"
[ $RC = 0 ] && [ "$(calls)" = "$want" ] && [ "$(receipt_of)" = "APPLIED+VERIFIED" ] && [ "$(marker)" = APPLIED-UNVERIFIED ] && [ "$CONSUMED" = 5 ] && [ -z "$(leaks)" ] && ok "HAPPY: four pinned reads, one dry run, ONE push, read-back; receipt APPLIED+VERIFIED; marker kept for the reconcile; 5 terminal reads (APPLY, token, password, then the read-back's two); no secret anywhere" || bad "happy path" "rc=$RC calls=[$(calls)] receipt=$(receipt_of) marker=$(marker) consumed=$CONSUMED leaks=$(leaks) $(echo "$OUT" | tail -5)"
[ "$(grep -c '^push$' "$H/calls.log")" = 1 ] && [ "$(grep -c 'sql=' "$H/calls.log")" = 4 ] && ok "exactly ONE push and exactly four queries" || bad "call counts"
c=0; for pair in g02-history-0248:$P_G02 g12-0243-intake-definers-0248:$P_G12 s1-open-transactions-0248:$P_OPEN w03-table-sizes-0248:$P_W03; do grep -q "query:${pair%%:*} sql=${pair#*:}\$" "$H/calls.log" || c=1; done
[ $c = 0 ] && ok "the CLI was handed exactly the four pinned query files (their sha256 at call time equal the pins)" || bad "queries are not the pinned files"
od=$(ls -d "$H"/hone-s1/online.* 2>/dev/null | head -1); [ -n "$od" ] && [ "$(ls "$od/results" | wc -l | tr -d ' ')" = 8 ] && [ "$(ls "$od/results"/*.meta.json | wc -l | tr -d ' ')" = 4 ] && ok "the reads are saved with sidecars in a new online.* directory (4 results + 4 sidecars)" || bad "online.* directory" "$od"
echo "$OUT" | grep -q 'NO settings write' && [ "$(echo "$OUT" | grep -n 'NO settings write: this script' | head -1 | cut -d: -f1)" -lt "$(echo "$OUT" | grep -n '^ok g02-history-0248.sql' | head -1 | cut -d: -f1)" ] && grep -q '^APPLY typed' "$H/hone-s1/s1apply."*/run.txt && ok "the summary (target, sealed sha, bundle sha, what runs, stop rules, no settings write) is printed BEFORE any credential is read or any read runs (APPLY is typed after it)" || bad "summary order"
cp "$H/out.txt" "$T/happy-output.txt"
grep -q "$TSEAL" "$H/out.txt" && grep -q "$TBUN" "$H/out.txt" && grep -q 'alhhybgqdmcdyzpybykj' "$H/out.txt" && ok "the summary names the target ref, the sealed sha and the bundle sha" || bad "summary content"

# the summary exactly as Sam sees it, rendered from the SHIPPED text with the shipped (real) constants
{ sed -n '/^#CONST-BEGIN$/,/^#CONST-END$/p' "$A"; grep -E '^(REF|NFILES|MAXV)=' "$A"; sed -n '/^STAGE=summary$/,/^ask GOWORD/p' "$A" | sed '/^ask() {/,/^}$/d;/^ask GOWORD/d'; } > "$T/summary.sh"
bash "$T/summary.sh" 2> "$T/summary-real.txt"; grep -q "$P_SEALED" "$T/summary-real.txt" && grep -q "$P_BUNDLE" "$T/summary-real.txt" && grep -q "$P_GO" "$T/summary-real.txt" && ok "the summary Sam sees renders with the real target, sealed sha, bundle sha and tool sha (saved as summary-real.txt)" || bad "real summary render" "$(head -3 "$T/summary-real.txt")"

fi
if want B; then
# ------------------------------------------------------------------ B. pre-push STOP rules (each: STOP reason, exact calls, nothing pushed, no marker, receipt NOT APPLIED)
expect_stop "history 246 rows -> STOP (g02), nothing after it runs" "V_g02-history-0248=count246" "not 245 rows" "query:g02-history-0248"
expect_stop "history max 0247 -> STOP (g02)" "V_g02-history-0248=max0247" "max is not 0246" "query:g02-history-0248"
expect_stop "versions at or above 0247 present -> STOP (g02)" "V_g02-history-0248=ge0247" "at or above 0247" "query:g02-history-0248"
expect_stop "g12 predicts the sealed 0248 would refuse -> STOP" "V_g12-0243-intake-definers-0248=bad" "predicted to refuse: context_ok" "query:g02-history-0248 query:g12-0243-intake-definers-0248"
expect_stop "g12 reports unexpected callable definers -> STOP" "V_g12-0243-intake-definers-0248=definers" "unexpected_callable_definers" "query:g02-history-0248 query:g12-0243-intake-definers-0248"
expect_stop "g12 read FAILS -> STOP, nothing after it runs" "FAIL=g12-0243-intake-definers-0248" "g12-0243-intake-definers-0248.sql failed" "query:g02-history-0248 query:g12-0243-intake-definers-0248"
expect_stop "an open transaction over 60 s on a scanned table -> STOP" "V_s1-open-transactions-0248=old" "older than 60 s" "query:g02-history-0248 query:g12-0243-intake-definers-0248 query:s1-open-transactions-0248"
expect_stop "the open-transaction read does not cover the ten tables -> STOP" "V_s1-open-transactions-0248=nine" "not exactly the ten scanned tables" "query:g02-history-0248 query:g12-0243-intake-definers-0248 query:s1-open-transactions-0248"
expect_stop "a scanned table is missing -> STOP" "V_s1-open-transactions-0248=absent" "table_present is not true" "query:g02-history-0248 query:g12-0243-intake-definers-0248 query:s1-open-transactions-0248"
W="$READS4"
expect_stop "statement_timeout 0 (unbounded) -> STOP" "ST=0" "is 0 \\(unbounded\\)" "$W"
expect_stop "statement_timeout 3min (over 2 min) -> STOP" "ST=3min" "longer than 2 min" "$W"
expect_stop "statement_timeout 121s (over 2 min) -> STOP" "ST=121s" "longer than 2 min" "$W"
expect_stop "statement_timeout 1h -> STOP" "ST=1h" "longer than 2 min" "$W"
expect_stop "statement_timeout unreadable -> STOP" "ST=garbage" "not a readable duration" "$W"
expect_stop "statement_timeout differs between rows -> STOP" "V_w03-table-sizes-0248=mixed" "inconsistent" "$W"
expect_stop "a table over 512 MiB -> STOP (the size bound the 2-minute reasoning rests on)" "V_w03-table-sizes-0248=big" "over 512 MiB" "$W"
for st in 2min 120s 120000ms 1min 30s; do
  newhome; cfgset "ST=$st"; mkapply; runscript "$VAR" "${APPLYIN[@]}"
  [ $RC = 0 ] && [ "$(receipt_of)" = "APPLIED+VERIFIED" ] && ok "statement_timeout $st is accepted (1 ms .. 2 min)" || bad "statement_timeout $st was refused" "$(echo "$OUT" | grep STOP | head -1)"
done

fi
if want C; then
# ------------------------------------------------------------------ C. single flight, tombstone, pins, decline
for w in IN-FLIGHT APPLIED-UNVERIFIED; do
  newhome; mkapply; printf '%s 2026-10-29T10:00:00Z head=x run=y\n' "$w" > "$H/hone-s1/s1-apply/APPLY-STATE"; runscript "$VAR" "${APPLYIN[@]}"
  [ $RC != 0 ] && echo "$OUT" | grep -q "STOP: a previous run left .*APPLY-STATE" && [ "$(calls)" = "" ] && [ "$CONSUMED" = 0 ] && [ "$(marker)" = "$w" ] && ok "a $w marker refuses the start: no prompt, no call, marker untouched" || bad "marker $w not refused" "rc=$RC $(echo "$OUT" | tail -2)"
done
newhome; mkapply; echo "failed login at 2026-10-29T10:00:00Z in phase push" > "$H/hone-s1/s1-apply/FAILED-LOGIN"; runscript "$VAR" "${APPLYIN[@]}"
[ $RC != 0 ] && echo "$OUT" | grep -q "STOP: a previous run failed a login" && [ "$(calls)" = "" ] && [ "$CONSUMED" = 0 ] && ok "a FAILED-LOGIN tombstone refuses the start" || bad "tombstone not refused"
newhome; mkapply; runscript "$VAR" nope "$CTOK" "$CPW"
[ $RC != 0 ] && echo "$OUT" | grep -q "STOP: not confirmed" && [ "$(calls)" = "" ] && [ "$CONSUMED" = 1 ] && [ "$(receipt_of)" = "NOT APPLIED" ] && ok "anything but APPLY stops before any credential is requested (1 terminal read, no call)" || bad "decline" "consumed=$CONSUMED calls=$(calls)"
tamper() { # tamper NAME PATHSUFFIX PATTERN : append a byte to a pinned file, expect a specific refusal and zero calls
  newhome; mkapply; echo "x" >> "$H/hone-s1/$2"; runscript "$VAR" "${APPLYIN[@]}"
  [ $RC != 0 ] && echo "$OUT" | grep -Eq "STOP: .*($3)" && [ "$(calls)" = "" ] && [ "$CONSUMED" = 0 ] && ok "$1" || bad "$1" "rc=$RC calls=$(calls) $(echo "$OUT" | grep STOP | head -1)"
}
tamper "an altered runner is refused before any prompt" window-reads-0248/run-window-read-macos.sh "runner missing or sha256 mismatch"
tamper "an altered gate query is refused (manifest check)" window-reads-0248/g12-0243-intake-definers-0248.sql "gate file does not match MANIFEST"
tamper "an altered manifest is refused" window-reads-0248/MANIFEST.sha256 "manifest missing or sha256 mismatch"
tamper "an altered read-back script is refused (pinned 6c96ff3b)" window-reads-s1-0248/window-s1read-0248.sh "not the pinned window-s1read-0248.sh"
tamper "an altered supabase-go is refused" supabase-cli/supabase-go "supabase-go missing or sha256 mismatch"
tamper "an altered bundle is refused" s1-apply-0248-online/migrations-stage0248.tar "sha256 mismatch"
newhome; mkapply; rm "$H/hone-s1/window-reads-0248/s1-open-transactions-0248.sql"; runscript "$VAR" "${APPLYIN[@]}"
[ $RC != 0 ] && echo "$OUT" | grep -Eq "STOP: .*(gate file does not match|missing)" && [ "$(calls)" = "" ] && ok "a missing gate query is refused" || bad "missing gate query"
newhome; mkapply; mkdir -p "$H/x"; mv "$H/hone-s1/window-reads-0248" "$H/x/real"; ln -s "$H/x/real" "$H/hone-s1/window-reads-0248"; runscript "$VAR" "${APPLYIN[@]}"
[ $RC != 0 ] && echo "$OUT" | grep -Eq "STOP: .*(symlink|private directory)" && [ "$(calls)" = "" ] && ok "a symlinked read directory is refused" || bad "symlinked directory"

fi
if want D; then
# ------------------------------------------------------------------ D. authentication failures: tombstone, no retry
newhome; cfgset READ_AUTH=fail; mkapply; runscript "$VAR" "${APPLYIN[@]}"
[ $RC != 0 ] && [ "$(calls)" = "query:g02-history-0248" ] && [ -f "$H/hone-s1/s1-apply/FAILED-LOGIN" ] && [ "$(marker)" = none ] && [ "$(receipt_of)" = "NOT APPLIED" ] && ok "auth failure on the first read: FAILED-LOGIN tombstone, ONE attempt, no retry, nothing pushed" || bad "read auth failure" "calls=$(calls)"
newhome; cfgset DRY=authfail; mkapply; runscript "$VAR" "${APPLYIN[@]}"
[ $RC != 0 ] && [ "$(calls)" = "$READS4 dry" ] && [ -f "$H/hone-s1/s1-apply/FAILED-LOGIN" ] && [ "$(marker)" = none ] && [ "$(receipt_of)" = "NOT APPLIED" ] && ok "auth failure on the dry run: tombstone, no push, no retry" || bad "dry-run auth failure" "calls=$(calls)"
newhome; cfgset PUSH=authfail; mkapply; runscript "$VAR" "${APPLYIN[@]}"
[ $RC != 0 ] && [ "$(calls)" = "$READS4 dry push" ] && [ -f "$H/hone-s1/s1-apply/FAILED-LOGIN" ] && [ "$(marker)" = IN-FLIGHT ] && [ "$(receipt_of)" = "UNKNOWN -> reconcile" ] && [ "$CONSUMED" = 3 ] && ok "auth failure on the push: tombstone, ONE push, marker kept, UNKNOWN -> reconcile, no read-back prompt" || bad "push auth failure" "calls=$(calls) marker=$(marker) consumed=$CONSUMED"
newhome; cfgset DRY=two; mkapply; runscript "$VAR" "${APPLYIN[@]}"
[ $RC != 0 ] && echo "$OUT" | grep -q "lists 2 migrations" && [ "$(calls)" = "$READS4 dry" ] && [ "$(marker)" = none ] && ok "a dry run that lists two migrations stops: no push" || bad "dry run two"
newhome; cfgset DRY=wrong; mkapply; runscript "$VAR" "${APPLYIN[@]}"
[ $RC != 0 ] && echo "$OUT" | grep -q "not the expected 0248" && [ "$(calls)" = "$READS4 dry" ] && ok "a dry run that lists another migration stops: no push" || bad "dry run wrong"

fi
if want E; then
# ------------------------------------------------------------------ E. the push: UNKNOWN handling, no blind retry
for m in fail killed two nofinish; do
  newhome; cfgset PUSH=$m; mkapply; runscript "$VAR" "${APPLYIN[@]}"
  [ $RC != 0 ] && [ "$(calls)" = "$READS4 dry push" ] && [ "$(marker)" = IN-FLIGHT ] && [ "$(receipt_of)" = "UNKNOWN -> reconcile" ] && [ "$CONSUMED" = 3 ] && echo "$OUT" | grep -q "Do NOT rerun" && [ ! -f "$H/s1read-called" ] && ok "push '$m': ONE push, IN-FLIGHT marker kept, UNKNOWN -> reconcile, no automatic retry, no read-back" || bad "push $m" "rc=$RC calls=$(calls) marker=$(marker) consumed=$CONSUMED receipt=$(receipt_of)"
  before=$(calls); runscript "$VAR" "${APPLYIN[@]}"
  [ $RC != 0 ] && echo "$OUT" | grep -q "STOP: a previous run left" && [ "$(calls)" = "$before" ] && [ "$(grep -c '^push$' "$H/calls.log")" = 1 ] && [ "$CONSUMED" = 0 ] && ok "a rerun after the '$m' push is refused by the marker: no prompt, no call, still exactly one push in the log" || bad "rerun after $m" "rc=$RC calls=$(calls)"
done
newhome; cfgset S1READ=fail; mkapply; runscript "$VAR" "${APPLYIN[@]}"
[ $RC != 0 ] && [ "$(marker)" = APPLIED-UNVERIFIED ] && [ "$(receipt_of)" = "UNKNOWN -> reconcile" ] && [ "$(calls)" = "$READS4 dry push" ] && ok "a clean push whose read-back fails: UNKNOWN -> reconcile, marker APPLIED-UNVERIFIED, no retry" || bad "read-back fails" "marker=$(marker) receipt=$(receipt_of)"
newhome; cfgset S1READ=history245; mkapply; runscript "$VAR" "${APPLYIN[@]}"
[ $RC != 0 ] && [ "$(receipt_of)" = "UNKNOWN -> reconcile" ] && ok "a read-back that shows 245 rows is never reported as APPLIED+VERIFIED" || bad "history245" "receipt=$(receipt_of)"

fi
if want F; then
# ------------------------------------------------------------------ F. interruption (INT, TERM, HUP) before, during and after the push: process-group signal, marker and receipt
cat > "$T/sig.py" <<'PY'
import os, signal, subprocess, sys, threading, time
script, home, trig, signame = sys.argv[1:5]; lines = sys.argv[5:]
tty = os.path.join(home, "tty")
if os.path.exists(tty): os.unlink(tty)
os.mkfifo(tty)
fifo = os.open(tty, os.O_RDWR)
os.write(fifo, "".join(l + "\n" for l in lines).encode())
out = open(os.path.join(home, "out.txt"), "w")
env = {"HOME": home, "PATH": os.environ["PATH"], "LC_ALL": "C"}
p = subprocess.Popen(["/bin/bash", script], env=env, cwd=home, stdout=out, stderr=out, stdin=subprocess.DEVNULL, start_new_session=True)
t0 = time.time()
while not os.path.exists(os.path.join(home, trig)) and time.time() - t0 < 60 and p.poll() is None: time.sleep(0.1)
if p.poll() is not None: print("EXITED-BEFORE-TRIGGER", p.returncode); sys.exit(0)
time.sleep(0.3)
os.killpg(p.pid, getattr(signal, "SIG" + signame))
try: p.wait(timeout=30)
except Exception:
    os.killpg(p.pid, signal.SIGKILL); print("HUNG"); sys.exit(0)
print("RC", p.returncode)
PY
sigcase() { # sigcase WHEN SIGNAME cfg trigger expected-marker expected-receipt expected-consumed
  local when="$1" sg="$2"
  newhome; cfgset $3; mkapply; local r; r=$(python3 -I "$T/sig.py" "$VAR" "$H" "$4" "$sg" "${APPLYIN[@]}" 2>&1); OUT=$(cat "$H/out.txt")
  [ "$r" = "RC 130" ] && [ "$(marker)" = "$5" ] && [ "$(receipt_of)" = "$6" ] && echo "$OUT" | grep -q "STOP: interrupted at stage" && [ -z "$(leaks)" ] && [ "$(grep -c '^push$' "$H/calls.log" 2>/dev/null)" = "$7" ] \
    && ok "$sg $when: exit 130, marker '$5', receipt '$6', credentials cleared, no secret on disk, $7 push" || bad "$sg $when" "r=$r marker=$(marker) receipt=$(receipt_of) pushes=$(grep -c '^push$' "$H/calls.log" 2>/dev/null) leaks=$(leaks)"
}
for sg in ${SGS:-INT TERM HUP}; do
  sigcase "during the reads (before any push)" $sg "QUERY_HANG=g12-0243-intake-definers-0248" query-started none "NOT APPLIED" 0
  sigcase "during the push" $sg "PUSH=hang" push-started IN-FLIGHT "UNKNOWN -> reconcile" 1
  sigcase "after the push (in the read-back)" $sg "S1READ=hang" s1read-started APPLIED-UNVERIFIED "UNKNOWN -> reconcile" 1
done

fi
if want G; then
# ------------------------------------------------------------------ G. the reconcile variant
now=$(date -u +%s); stamp() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; }
mkrec() { newhome; local r=$H/hone-s1; cp "$R" "$r/rec.sh"; }
printf '%s\n' '#!/bin/bash' 'if [ "${1:-}" = -s ]; then echo Darwin; else exec "$(PATH=/usr/bin:/bin command -v uname)" "$@"; fi' > "$T/shim/uname"; chmod 755 "$T/shim/uname"
printf '%s\n' '#!/bin/bash' '[ -f "$HOME/pgrep-busy" ] && exit 0; exit 1' > "$T/shim/pgrep"; chmod 755 "$T/shim/pgrep"
recrun() { rm -f "$H/out.txt"; ( cd "$H" && env -i HOME="$H" PATH="$T/shim:$PATH" LC_ALL=C /bin/bash "$H/hone-s1/rec.sh" > "$H/out.txt" 2>&1 ); RC=$?; OUT=$(cat "$H/out.txt"); }
mkmarker() { printf '%s %s head=x run=y\n' "$1" "$(stamp "$2")" > "$H/hone-s1/s1-apply/APPLY-STATE"; }
mkevidence() { # mkevidence DIRNAME CAPTURED_EPOCH SQLSHA BODY EXIT RUNNERSHA
  local d=$H/hone-s1/$1; mkdir -p "$d/results"; chmod 700 "$d"; printf '%s\n' "$4" > "$d/results/g02-history-0248.json"
  printf '{"file":"g02-history-0248.sql","sql_sha256":"%s","result_sha256":"%s","started_at_utc":"%s","captured_at_utc":"%s","exit_code":%s,"runner_sha256":"%s","manifest_sha256":"%s"}\n' "$3" "$(sha "$d/results/g02-history-0248.json")" "$(stamp $(($2-1)))" "$(stamp $2)" "$5" "$6" "$P_MANIFEST" > "$d/results/g02-history-0248.meta.json"
}
H245='[{"applied_count":245,"hosted_max":"0246","versions_ge_0247":0}]'
rec_expect() { # rec_expect NAME 'RC!=0 pattern or RECONCILED' marker-after
  [ "$2" = ok ] && { [ $RC = 0 ] && echo "$OUT" | grep -q "RECONCILED NONE" && ls "$H/hone-s1/s1-apply/"APPLY-STATE.cleared.* >/dev/null 2>&1 && [ "$(marker)" = none ] && ok "$1" || bad "$1" "rc=$RC $OUT"; return; }
  [ $RC != 0 ] && echo "$OUT" | grep -Eq "STOP: .*($2)" && [ "$(marker)" = "$3" ] && ok "$1" || bad "$1" "rc=$RC marker=$(marker) $OUT"
}
mkrec; mkmarker IN-FLIGHT $((now-1500)); mkevidence online.A $((now-100)) $P_G02 "$H245" 0 $P_RUNNER; recrun
rec_expect "NONE via a fresh online.* g02 read taken 1400 s after the marker: RECONCILED NONE, marker archived" ok
mkrec; mkmarker IN-FLIGHT $((now-1500)); mkevidence online.A $((now-100)) $P_G02 "$H245" 0 $P_RUNNER; : > "$H/pgrep-busy"; recrun
rec_expect "NONE refuses while a supabase or apply process may still be running (the first push may be alive)" "may still be alive" IN-FLIGHT
mkrec; mkmarker IN-FLIGHT $((now-1500)); mkevidence online.A $((now-400)) $P_G02 "$H245" 0 $P_RUNNER; recrun
rec_expect "NONE refuses an online.* read taken only 1100 s after the marker (the 1200 s rule)" "no usable read-back evidence" IN-FLIGHT
mkrec; mkmarker IN-FLIGHT $((now-1500)); mkevidence online.A $((now-1600)) $P_G02 "$H245" 0 $P_RUNNER; recrun
rec_expect "NONE refuses a PRE-PUSH online.* read (older than the marker): it can never clear a marker" "no usable read-back evidence" IN-FLIGHT
mkrec; mkmarker IN-FLIGHT $((now-1500)); mkevidence online.A $((now-100)) 0000000000000000000000000000000000000000000000000000000000000000 "$H245" 0 $P_RUNNER; recrun
rec_expect "NONE refuses a sidecar bound to the WRONG query sha" "no usable read-back evidence" IN-FLIGHT
mkrec; mkmarker IN-FLIGHT $((now-1500)); mkevidence online.A $((now-100)) $P_G02 "$H245" 0 $P_RUNNER; echo '[{"applied_count":245,"hosted_max":"0246","versions_ge_0247":0}] ' > "$H/hone-s1/online.A/results/g02-history-0248.json"; recrun
rec_expect "NONE refuses a result whose bytes no longer match the sidecar's result sha" "no usable read-back evidence" IN-FLIGHT
mkrec; mkmarker IN-FLIGHT $((now-1500)); mkevidence online.A $((now-100)) $P_G02 "$H245" 1 $P_RUNNER; recrun
rec_expect "NONE refuses an online.* sidecar with exit_code 1" "no usable read-back evidence" IN-FLIGHT
mkrec; mkmarker IN-FLIGHT $((now-1500)); mkevidence online.A $((now-100)) $P_G02 "$H245" 0 0000000000000000000000000000000000000000000000000000000000000000; recrun
rec_expect "NONE refuses an online.* sidecar from some other runner" "no usable read-back evidence" IN-FLIGHT
mkrec; mkmarker IN-FLIGHT $((now-1500)); mkevidence online.A $((now-100)) $P_G02 '[{"applied_count":246,"hosted_max":"0248","versions_ge_0247":1}]' 0 $P_RUNNER; recrun
rec_expect "NONE refuses a read that shows 246 rows / max 0248 (it would be ALL, not NONE)" "no usable read-back evidence" IN-FLIGHT
mkrec; mkmarker APPLIED-UNVERIFIED $((now-1500)); mkevidence online.A $((now-100)) $P_G02 "$H245" 0 $P_RUNNER; recrun
rec_expect "NONE needs the IN-FLIGHT word: an APPLIED-UNVERIFIED marker with a 245 read STOPs" "not IN-FLIGHT" APPLIED-UNVERIFIED
mkrec; recrun
[ $RC != 0 ] && echo "$OUT" | grep -q "no APPLY-STATE marker" && ok "no marker: nothing to reconcile" || bad "no marker"
# ALL via s1read (unchanged route)
mkrec; mkmarker APPLIED-UNVERIFIED $((now-600)); d=$H/hone-s1/s1read.A; mkdir -p "$d/results"; chmod 700 "$d"
echo 'OVERALL PASS (0248 read-back: history and 2 verify-bundle checks; read-only, not a promotion)' > "$d/verdict.txt"; echo '[{"applied_count":246,"hosted_max":"0248","rows_0248":1,"rows_0247":0}]' > "$d/results/s1-history-0248.json"
printf '{"file":"s1-history-0248.sql","sql_sha256":"a4d3c5afad277cef9c720ea534309b6e6843d92e8ecf15b5232e180f03246e2a","result_sha256":"%s","started_at_utc":"%s","captured_at_utc":"%s","exit_code":0}\n' "$(sha "$d/results/s1-history-0248.json")" "$(stamp $((now-100)))" "$(stamp $((now-100)))" > "$d/results/s1-history-0248.meta.json"
recrun; [ $RC = 0 ] && echo "$OUT" | grep -q "RECONCILED ALL" && [ "$(marker)" = none ] && ok "ALL via s1read (unchanged route): RECONCILED ALL, marker archived" || bad "ALL route" "$OUT"
mkrec; mkmarker APPLIED-UNVERIFIED $((now-600)); d=$H/hone-s1/s1read.A; mkdir -p "$d/results"; chmod 700 "$d"
echo 'OVERALL PASS (0248 read-back: history and 2 verify-bundle checks; read-only, not a promotion)' > "$d/verdict.txt"; echo '[{"applied_count":246,"hosted_max":"0248","rows_0248":1,"rows_0247":0}]' > "$d/results/s1-history-0248.json"
printf '{"file":"s1-history-0248.sql","sql_sha256":"a4d3c5afad277cef9c720ea534309b6e6843d92e8ecf15b5232e180f03246e2a","result_sha256":"%s","started_at_utc":"%s","captured_at_utc":"%s","exit_code":0}\n' "$(sha "$d/results/s1-history-0248.json")" "$(stamp $((now-900)))" "$(stamp $((now-900)))" > "$d/results/s1-history-0248.meta.json"
recrun; rec_expect "ALL refuses a read-back captured BEFORE the marker" "no usable read-back evidence" APPLIED-UNVERIFIED

# the end-to-end chain: an UNKNOWN push, then the standalone g02 helper, then the reconcile
newhome; cfgset PUSH=fail; mkapply; runscript "$VAR" "${APPLYIN[@]}"
echo "RUNNER_SHA=$TRUN" > "$H/rconst.txt"; mkvar "$R" "$H/hone-s1/rec.sh" "$H/rconst.txt"; recrun
[ $RC != 0 ] && echo "$OUT" | grep -q "no usable read-back evidence" && [ "$(marker)" = IN-FLIGHT ] && ok "END-TO-END: after a failed push the apply run's own pre-push online.* reads do NOT clear the marker" || bad "e2e pre-push evidence" "$OUT"
# the apply run's own online.* directory is removed, so the ONLY evidence left is the fresh standalone read; the marker is made 1300 s old, then the helper reads
rm -rf "$H"/hone-s1/online.*
mt=$(awk '{print $2}' "$H/hone-s1/s1-apply/APPLY-STATE"); printf 'IN-FLIGHT %s head=x run=y\n' "$(stamp $(( $(date -u -d "$mt" +%s 2>/dev/null || date -u -j -f %Y-%m-%dT%H:%M:%SZ "$mt" +%s) - 1300 )))" > "$H/hone-s1/s1-apply/APPLY-STATE"
mkconst g02; mkvar "$G" "$H/hone-s1/g.sh" "$H/const.txt"; cfgset PUSH=none; rm -f "$H/calls.log"
runscript "$H/hone-s1/g.sh" "$CTOK" "$CPW"
[ $RC = 0 ] && [ "$(calls)" = "query:g02-history-0248" ] && [ "$CONSUMED" = 2 ] && [ -z "$(leaks)" ] && ok "the standalone g02 helper reads once with the pinned query while a marker exists (token and password typed hidden, once)" || bad "g02 helper" "rc=$RC calls=$(calls) consumed=$CONSUMED $(echo "$OUT" | tail -3)"
recrun; [ $RC = 0 ] && echo "$OUT" | grep -q "RECONCILED NONE" && ok "END-TO-END: the fresh standalone read (taken >= 1200 s after the marker) lets the reconcile clear it as NONE" || bad "e2e standalone evidence" "$OUT"
newhome; cfgset READ_AUTH=fail; mkconst g02; mkvar "$G" "$H/g.sh" "$H/const.txt"; runscript "$H/g.sh" "$CTOK" "$CPW"
[ $RC != 0 ] && [ -f "$H/hone-s1/s1-apply/FAILED-LOGIN" ] && [ "$(calls)" = "query:g02-history-0248" ] && ok "the g02 helper: an auth failure writes the tombstone, one attempt, no retry" || bad "g02 helper auth"
newhome; echo "x" > "$H/hone-s1/s1-apply/FAILED-LOGIN"; mkconst g02; mkvar "$G" "$H/g.sh" "$H/const.txt"; runscript "$H/g.sh" "$CTOK" "$CPW"
[ $RC != 0 ] && [ "$(calls)" = "" ] && [ "$CONSUMED" = 0 ] && ok "the g02 helper refuses to start while a FAILED-LOGIN tombstone exists" || bad "g02 helper tombstone"

fi
if want H; then
# ------------------------------------------------------------------ H. mutation pass: each deliberate break of the shipped text must turn a named scenario red
mutcheck() { # mutcheck NAME SEDEXPR cfg pattern expected-calls [pre-state snippet]
  local name="$1"; local m=$T/mut-$N.sh; N=$((N+1))
  sed -e "$2" "$A" > "$m"; if cmp -s "$m" "$A"; then bad "mutation '$name' did not change the script"; return; fi
  newhome; [ -z "$3" ] || cfgset $3; [ -z "${6:-}" ] || eval "$6"; mkapply "$m"; runscript "$VAR" "${APPLYIN[@]}"
  if [ $RC != 0 ] && echo "$OUT" | grep -Eq "STOP: .*($4)" && [ "$(calls)" = "$5" ]; then bad "MUTATION SURVIVED: $name"; else ok "mutation killed: $name"; fi
}
mutcheck "the g02 history rule is removed" 's/^read_gate g02-history-0248.sql .*$/:/' "V_g02-history-0248=count246" "not 245 rows" "query:g02-history-0248"
mutcheck "the g12 rule is removed" 's/^read_gate g12-0243-intake-definers-0248.sql .*$/:/' "V_g12-0243-intake-definers-0248=bad" "predicted to refuse" "query:g02-history-0248 query:g12-0243-intake-definers-0248"
mutcheck "the open-transaction rule is removed" 's/^read_gate s1-open-transactions-0248.sql .*$/:/' "V_s1-open-transactions-0248=old" "older than 60 s" "query:g02-history-0248 query:g12-0243-intake-definers-0248 query:s1-open-transactions-0248"
mutcheck "the statement_timeout upper bound is removed" 's/ms > 120000/ms > 12000000000/' "ST=3min" "longer than 2 min" "$READS4"
mutcheck "the statement_timeout zero check is removed" 's/ms === 0/ms === -1/' "ST=0" "is 0" "$READS4"
mutcheck "the 512 MiB bound is removed" 's/512 \* 1024 \* 1024/512 * 1024 * 1024 * 1024/' "V_w03-table-sizes-0248=big" "over 512" "$READS4"
mutcheck "the single-flight marker refusal is removed" 's/^if \[ -e "\$STATEF" \] || \[ -L "\$STATEF" \]; then$/if false; then/' "" "a previous run left" "" 'printf "IN-FLIGHT 2026-10-29T10:00:00Z head=x run=y\n" > "$H/hone-s1/s1-apply/APPLY-STATE"'
mutcheck "the tombstone refusal is removed" 's/^if \[ -e "\$TOMB" \] || \[ -L "\$TOMB" \]; then$/if false; then/' "" "previous run failed a login" "" 'echo x > "$H/hone-s1/s1-apply/FAILED-LOGIN"'

fi
echo
echo "RESULT: $pass passed, $fail failed"
[ -n "${EXPECT_N:-}" ] && { [ "$((pass+fail))" = "$EXPECT_N" ] && echo "N-of-N: $((pass+fail)) of $EXPECT_N assertions ran" || { echo "N-of-N MISMATCH: ran $((pass+fail)), expected $EXPECT_N"; exit 1; }; }
[ "$fail" = 0 ]
