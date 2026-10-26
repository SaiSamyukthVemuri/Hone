#!/bin/bash
# REHEARSAL - NEVER MERGE. Tests window-s1read.sh on macOS arm64 against a STUB supabase-go that serves stored results.
# STUBBED: supabase-go (a shell script serving a stored JSON result per gate file, its hash substituted into a TEST COPY of the
# runner), the hosted project (there is none) and the typed answers (a pty driver types the two hidden credentials).
# NOT stubbed: the real script logic, the real runner logic (only its supabase-go hash constant differs in the test copy), the real
# pinned comparator and lib, the real six S1 gate files and manifest, the real baseline (unchanged).
# Two sources of stored results: SYNTHETIC (built from the baseline by gen-s1-results.mjs) and REAL-DATABASE (the real gate files run
# with psql against a synthetic database built from the d189768b chain at 0212 and 0246; CI sets S1_REAL_FIXTURES).
# WS_DEV_LINUX=1 (local development only) removes the Darwin/arm64 check from the TEST COPY; CI never sets it.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
S1D="$HERE/window-reads-s1"
WSD="$HERE/../window-script/window-reads"
T="$(mktemp -d "${TMPDIR:-/tmp}/s1r.XXXXXX")"; T="$(cd "$T" && pwd -P)"
trap 'rm -rf "$T"' EXIT
pass=0; fail=0; skipped=0
ok()  { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
has() { grep -qF -- "$2" "$1"; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
TOKEN=TOKEN-SECRET-9f3a1b
PASSWORD=PW-SECRET-77c2de
BASE="$WSD/BASELINE-W1-MACOS-CANDIDATE-3.json"

# ---- static: the REAL script's constants equal the real files; the S1 gate files are what the baseline says
REAL="$S1D/window-s1read.sh"
st() { grep -E "^$1=" "$REAL" | head -1 | cut -d= -f2; }
[ "$(st RUNNER_SHA)" = "$(sha "$S1D/run-window-read-macos.sh")" ] && [ "$(st MANIFEST_SHA)" = "$(sha "$S1D/MANIFEST.sha256")" ] \
 && [ "$(st CMP_SHA)" = "$(sha "$WSD/compare-preflight.mjs")" ] && [ "$(st LIB_SHA)" = "$(sha "$WSD/compare-preflight-lib.mjs")" ] \
 && [ "$(st BASELINE_SHA)" = "$(sha "$BASE")" ] && ok "the real script's pins equal the real runner, S1 manifest, comparator, lib and baseline" || bad "script pins differ from the real files"
[ "$(sha "$S1D/run-window-read-macos.sh")" = "$(sha "$WSD/run-window-read-macos.sh")" ] && [ "$(sha "$S1D/run-window-read-macos.sh")" = 471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357 ] && ok "the S1 runner copy is byte-identical to the pinned runner 471ecb9d" || bad "runner copy differs"
[ "$(sha "$S1D/census-0213-0246.sql")" = "$(sha "$WSD/census-0213-0246.sql")" ] && ok "the census file is the byte-identical window-reads census (4817b78e): guard-free, valid after S1" || bad "census differs"
(cd "$S1D" && shasum -a 256 -c MANIFEST.sha256 >/dev/null 2>&1) && [ "$(grep -c . "$S1D/MANIFEST.sha256")" = 6 ] && ok "the S1 manifest verifies exactly its six gate files" || bad "S1 manifest"
bash -n "$REAL" && ok "bash -n (syntax)" || bad "syntax"
names_ok=$(node -e '
const fs=require("fs");const b=JSON.parse(fs.readFileSync(process.argv[1])).s1;const d=process.argv[2];
const inList=(f)=>{const m=/p\.proname in \(([^)]*)\)/.exec(fs.readFileSync(d+"/"+f,"utf8"));return m[1].split(",").map(x=>x.trim().replace(/\x27/g,"")).sort().join(",");};
const eq=(a,b)=>a===b;
const tp=fs.readFileSync(d+"/s1-table-privileges.sql","utf8");
const tpl=[...tp.matchAll(/\(\x27(\w+)\x27, \x27(\w+)\x27, \x27(\w+)\x27\)/g)].map(m=>m[1]+"|"+m[2]+"|"+m[3]).sort().join(",");
const okc=eq(inList("s1-closures.sql"),b.closures.map(c=>c.fn).sort().join(","));
const okb=eq(inList("s1-body-md5.sql"),Object.keys(b.body_md5).sort().join(","));
const okt=eq(tpl,b.table_privileges.map(t=>t.table+"|"+t.role+"|"+t.privilege).sort().join(","));
console.log(okc&&okb&&okt?"yes":"no "+okc+okb+okt);' "$BASE" "$S1D")
[ "$names_ok" = yes ] && ok "the functions, bodies and table privileges the SQL reads are exactly the baseline's s1.closures, s1.body_md5 and s1.table_privileges" || bad "SQL lists differ from the baseline: $names_ok"
for f in s1-g10 s1-closures s1-table-privileges s1-body-md5; do grep -q "= '0246'" "$S1D/$f.sql" && grep -q "1 / (case when" "$S1D/$f.sql" && ok "$f.sql carries the history max = 0246 chain guard" || bad "$f.sql has no 0246 guard"; done
grep -q "0212" "$S1D/s1-g10.sql" | grep -v '^--' >/dev/null 2>&1; [ -z "$(grep -v '^--' "$S1D/s1-g10.sql" | grep 0212)" ] && ok "s1-g10.sql has no 0212 guard left in its code" || bad "s1-g10.sql still names 0212 in code"
[ -z "$(grep -nE 'SUPABASE_DB_PASSWORD=|SUPABASE_ACCESS_TOKEN=' "$REAL" | grep -v 'read -rs' | grep -vE '^[0-9]+:(#|cleanup|unset)' | grep -E '=[^ ]')" ] && ok "secrets are only ever read with read -rs and cleared" || bad "a secret assignment outside read -rs"
if grep -nE '^[^#]*[A-Za-z0-9_"]+ +# ' "$REAL" | grep -vE "^[0-9]+:\s*#" | grep -E 'printf|export|unset' >/dev/null; then bad "inline comment after a command"; else ok "no inline comment follows a command"; fi
grep -q "^TOMB=\"\$ROOT/s1-read/FAILED-LOGIN\"" "$REAL" && grep -q 'tombstone "\$f"' "$REAL" && ok "a failed login writes a tombstone and the next run refuses (s1-apply's pattern)" || bad "no tombstone"

# ---- the test world
mkfix() { # mkfix NAME SCENARIO TIER -> F, a home with the stub CLI, the real files and the stored results
  F="$T/$1"; mkdir -p "$F/hone-s1/supabase-cli" "$F/hone-s1/window-reads" "$F/hone-s1/window-reads-s1" "$F/res"
  cp "$WSD/compare-preflight.mjs" "$WSD/compare-preflight-lib.mjs" "$BASE" "$F/hone-s1/window-reads/"
  cp "$S1D"/*.sql "$S1D/MANIFEST.sha256" "$F/hone-s1/window-reads-s1/"
  cat > "$F/hone-s1/supabase-cli/supabase-go" <<'STUB'
#!/bin/sh
echo "$*" >> "$STUB_LOG"
f=""; while [ $# -gt 0 ]; do [ "$1" = "-f" ] && f="$2"; shift; done
stem=$(basename "$f" .sql)
[ "${STUB_FAIL-}" = "$stem" ] && { echo "boom: stub failure" >&2; exit 1; }
[ "${STUB_DENY-}" = "$stem" ] && { echo "ERROR: permission denied for table x (42501)" >&2; exit 1; }
[ "${STUB_AUTH-}" = "$stem" ] && { echo "failed to connect: FATAL: password authentication failed for user postgres.xxxx (SQLSTATE 28P01) postgresql://postgres.xxxx:SECRETURLPW@host:5432/postgres" >&2; exit 1; }
[ "${STUB_LOGINROLE-}" = "$stem" ] && { echo "Initialising login role..." >&2; exit 1; }
if [ -f "$STUB_RESULTS/$stem.error" ]; then cat "$STUB_RESULTS/$stem.error" >&2; exit 1; fi
cat "$STUB_RESULTS/$stem.json"
STUB
  chmod +x "$F/hone-s1/supabase-cli/supabase-go"
  GOSHA=$(sha "$F/hone-s1/supabase-cli/supabase-go")
  sed "s/^SUPABASE_GO_SHA256=.*/SUPABASE_GO_SHA256=$GOSHA/" "$S1D/run-window-read-macos.sh" > "$F/hone-s1/window-reads-s1/run-window-read-macos.sh"
  RSHA=$(sha "$F/hone-s1/window-reads-s1/run-window-read-macos.sh")
  sed -e "s/^GO_SHA=.*/GO_SHA=$GOSHA/" -e "s/^RUNNER_SHA=.*/RUNNER_SHA=$RSHA/" "$REAL" > "$F/window-s1read.test.sh"
  if [ "${WS_DEV_LINUX:-}" = 1 ]; then sed -i 's/^\[ "\$(uname -s)" = Darwin \].*$/true/' "$F/window-s1read.test.sh"; fi
  if [ "$3" = syn ]; then node "$HERE/gen-s1-results.mjs" "$F/res" "$BASE" "$S1D/census-0213-0246.sql" "$2" || { echo "gen failed"; exit 1; }
  else cp "$S1_REAL_FIXTURES/$2"/* "$F/res/"; fi
  : > "$F/stub.log"
}
runit() { # runit [ENV=VAL ...]  -> OUT, RC
  printf 'Supabase access token\t%s\nDatabase password\t%s\n' "$TOKEN" "$PASSWORD" > "$F/answers.txt"
  RC=0
  python3 "$HERE/../window-script/driver.py" "$F/out.txt" "$F/answers.txt" -- env -i PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$(dirname "$(node -p process.execPath)") HOME="$F" TERM=dumb STUB_LOG="$F/stub.log" STUB_RESULTS="$F/res" "$@" /bin/bash "$F/window-s1read.test.sh" || RC=$?
  OUT="$F/out.txt"
}
calls() { grep -c . "$F/stub.log"; }
refuse() { [ "$RC" != 0 ] && has "$OUT" "$2" && ok "$1" || { bad "$1" "rc=$RC want text [$2]"; tail -8 "$OUT"; }; }
nosecret() { if grep -rqF --exclude-dir=supabase-cli -e "$TOKEN" -e "$PASSWORD" -e SECRETURLPW "$OUT" "$F/hone-s1" 2>/dev/null; then bad "$1: a secret or URL password appears in the output or on disk"; else ok "$1: no secret appears in the output or in any file"; fi; }

run_tier() { # run_tier TIER
  local TIER="$1" P="[$1]"
  mkfix "ok-$TIER" ok "$TIER"; runit
  [ "$RC" = 0 ] && has "$OUT" "OVERALL PASS" && ok "$P happy path at 0246: exit 0 and the comparator's OVERALL PASS line" || { bad "$P happy path" "rc=$RC"; tail -30 "$OUT"; }
  echo "--- $P happy path transcript (tail) ---"; tail -n 22 "$OUT" | cut -c1-200; echo "--- end ---"
  [ "$(calls)" = 6 ] && ok "$P exactly 6 runner calls, one per gate file" || bad "$P stub call count" "$(calls)"
  [ "$(awk '{print $NF}' "$F/stub.log" | xargs -n1 basename | tr '\n' ' ')" = "s1-history.sql census-0213-0246.sql s1-g10.sql s1-closures.sql s1-table-privileges.sql s1-body-md5.sql " ] && ok "$P the files ran in order, history first" || bad "$P order" "$(cat "$F/stub.log")"
  grep -q -- "--agent no db query --linked -o json -f" "$F/stub.log" && ok "$P the CLI call is db query --linked (no --db-url, no --local)" || bad "$P CLI call shape"
  for id in S1-1 S1-2 S1-2b S1-2c S1-3 S1-4; do has "$OUT" "PASS          $id " || bad "$P $id not PASS"; done; ok "$P S1-1, S1-2, S1-2b, S1-2c, S1-3 and S1-4 all PASS"
  nosecret "$P happy path"
  [ "$(ls "$F"/hone-s1/s1read.*/results | wc -l | tr -d ' ')" = 12 ] && ok "$P 12 files (6 results + 6 sidecars) in the 0700 results directory" || bad "$P results dir"
  [ "$(stat -c %a "$F"/hone-s1/s1read.* 2>/dev/null || stat -f %Lp "$F"/hone-s1/s1read.*)" = 700 ] && ok "$P the work directory is mode 0700" || bad "$P work dir mode"
  has "$OUT" "S1 read-back started" && has "$OUT" "finished" && ok "$P start and end times are printed to record" || bad "$P no times"
  [ ! -e "$F/hone-s1/s1-read/FAILED-LOGIN" ] && ok "$P no tombstone after a clean run" || bad "$P tombstone present"
  [ "$(node -e 'const j=require(process.argv[1]);console.log(Object.keys(j).sort().join())' "$(ls -d "$F"/hone-s1/s1read.*)/readback.json")" = "body_md5,closures,history,table_privileges" ] && ok "$P the assembled --readback has exactly history, closures, table_privileges, body_md5" || bad "$P readback keys"

  mkfix "at0212-$TIER" at0212 "$TIER"; runit
  refuse "$P history at 0212 (S1 not applied): stopped at the first file, do NOT promote" "s1-history: the history is not exactly 245 rows, max 0246"
  [ "$(calls)" = 1 ] && ok "$P ... only s1-history was read; nothing after it" || bad "$P ... call count" "$(calls)"
  nosecret "$P at0212"
  mkfix "closure-$TIER" closure_bad "$TIER"; runit
  refuse "$P one closure wrong (studio_named_stripe_accounts executable by authenticated): refused" "OVERALL FAIL"
  has "$OUT" "FAIL          S1-3 " && has "$OUT" "studio_named_stripe_accounts.authenticated must be false" && ok "$P ... S1-3 FAIL names the function and the role" || bad "$P ... S1-3 text"
  [ "$(calls)" = 6 ] && ok "$P ... all six were read; the comparator decided" || bad "$P ... call count" "$(calls)"
  nosecret "$P closure wrong"
  mkfix "body-$TIER" body_bad "$TIER"; runit
  refuse "$P one replaced body wrong (md5 differs): refused" "OVERALL FAIL"
  has "$OUT" "FAIL          S1-4 " && has "$OUT" "mismatch: claim_email_provider_events" && ok "$P ... S1-4 FAIL names the function" || bad "$P ... S1-4 text"
  nosecret "$P body wrong"
}

run_tier syn
if [ -n "${S1_REAL_FIXTURES:-}" ] && [ -d "${S1_REAL_FIXTURES}/ok" ]; then
  # the real database at 0212: history answers, the four guarded files refuse with a division by zero
  for g in s1-g10 s1-closures s1-table-privileges s1-body-md5; do grep -q "division by zero" "$S1_REAL_FIXTURES/at0212/$g.error" 2>/dev/null && [ ! -e "$S1_REAL_FIXTURES/at0212/$g.json" ] && ok "[real] at 0212 the real $g.sql refuses with division by zero" || bad "[real] at 0212 $g did not refuse"; done
  [ -s "$S1_REAL_FIXTURES/at0212/s1-history.json" ] && [ -s "$S1_REAL_FIXTURES/at0212/census-0213-0246.json" ] && ok "[real] at 0212 the history and census files answer (no guard), the comparator and script judge them" || bad "[real] at0212 history/census"
  run_tier real
else
  skipped=$((skipped+1)); echo "SKIP - the real-database tier (S1_REAL_FIXTURES is not set: local development)"
fi

# ---- tier-independent refusals (synthetic ok results)
mkfix badgate ok syn; printf -- '-- x\n' >> "$F/hone-s1/window-reads-s1/s1-closures.sql"; runit
refuse "bad sha: an edited gate file is refused before anything runs" "an S1 gate file does not match MANIFEST.sha256"
[ ! -s "$F/stub.log" ] && ok "  ... and nothing was read" || bad "  ... stub was called"
mkfix badrunner ok syn; printf '# x\n' >> "$F/hone-s1/window-reads-s1/run-window-read-macos.sh"; runit
refuse "bad sha: an edited runner copy is refused" "runner copy missing or sha256 mismatch"
mkfix badman ok syn; printf '%s  extra.sql\n' 0000000000000000000000000000000000000000000000000000000000000000 >> "$F/hone-s1/window-reads-s1/MANIFEST.sha256"; runit
refuse "bad sha: an edited manifest is refused" "S1 manifest missing or sha256 mismatch"
mkfix badlib ok syn; printf '\n// x\n' >> "$F/hone-s1/window-reads/compare-preflight-lib.mjs"; runit
refuse "bad sha: an edited comparator lib is refused" "comparator lib missing or sha256 mismatch"
mkfix badbase ok syn; printf ' ' >> "$F/hone-s1/window-reads/BASELINE-W1-MACOS-CANDIDATE-3.json"; runit
refuse "bad sha: an edited baseline is refused" "baseline BASELINE-W1-MACOS-CANDIDATE-3.json missing or sha256 mismatch"
mkfix badgo ok syn; printf '# x\n' >> "$F/hone-s1/supabase-cli/supabase-go"; runit
refuse "bad sha: an altered supabase-go is refused" "supabase-go missing or sha256 mismatch"
mkfix envvar ok syn; runit SUPABASE_DB_URL=postgres://user:SECRETVALUE@h/db PGHOSTADDR=1.2.3.4 E2E_SUPABASE_URL=http://x NODE_OPTIONS=--no-warnings
refuse "leftover env vars are refused (names only)" "unset these variables first (names only): E2E_SUPABASE_URL NODE_OPTIONS PGHOSTADDR SUPABASE_DB_URL"
has "$OUT" SECRETVALUE && bad "  ... a variable VALUE was printed" || ok "  ... no variable value is printed"
mkfix withargs ok syn; printf 'Supabase access token\tx\n' > "$F/answers.txt"; RC=0; env -i PATH=/usr/bin:/bin HOME="$F" /bin/bash "$F/window-s1read.test.sh" extra > "$F/out.txt" 2>&1 </dev/null || RC=$?; OUT="$F/out.txt"
refuse "an argument is refused" "this script takes no arguments"

mkfix auth ok syn; runit STUB_AUTH=s1-closures
refuse "a failed login stops and says so" "an authentication failure was recorded in"
[ -s "$F/hone-s1/s1-read/FAILED-LOGIN" ] && ok "  ... the tombstone was written" || bad "  ... no tombstone"
grep -qE '^failed login at [0-9TZ:-]+ on file s1-closures.sql$' "$F/hone-s1/s1-read/FAILED-LOGIN" && ! grep -rqF -e "$TOKEN" -e "$PASSWORD" -e SECRETURLPW "$F/hone-s1/s1-read" && ok "  ... it holds only the time and the file name, no secret" || bad "  ... tombstone content"
has "$OUT" "do not retry; do not reset the password; do not unban" && ok "  ... the output says do not retry, reset or unban" || bad "  ... no stop text"
has "$OUT" "<url>" && ok "  ... the connection URL in the CLI's error was masked" || bad "  ... URL not masked"
nosecret "failed login"
[ "$(calls)" = 4 ] && ok "  ... history, census, g10 ran; closures failed; nothing after it" || bad "  ... call count" "$(calls)"
n1=$(calls); : > "$F/stub.log"; rm -rf "$F"/hone-s1/s1read.*; runit STUB_AUTH=s1-closures
refuse "the next run refuses on the tombstone" "a previous run failed a login"
[ "$(calls)" = 0 ] && ok "  ... and the stub (the hosted project) was not called at all" || bad "  ... the second run called the CLI" "$(calls)"
mkfix loginrole ok syn; runit STUB_LOGINROLE=census-0213-0246
refuse "a login-role path is reported, recorded and stops" "the CLI reported a login-role / ban / password path"
[ -s "$F/hone-s1/s1-read/FAILED-LOGIN" ] && ok "  ... the tombstone was written for the login-role branch" || bad "  ... no tombstone"
mkfix denied ok syn; runit STUB_DENY=s1-g10
refuse "a permission denial stops the run" "a permission refusal was reported"
[ ! -e "$F/hone-s1/s1-read/FAILED-LOGIN" ] && ok "  ... a denial is not a failed login (no tombstone)" || bad "  ... tombstone on a denial"
mkfix failfile ok syn; runit STUB_FAIL=census-0213-0246
refuse "a failed file stops the run, no retry" "census-0213-0246.sql failed (exit"
[ "$(calls)" = 2 ] && ok "  ... history and census were called once each; nothing after" || bad "  ... call count" "$(calls)"
[ ! -e "$F/hone-s1/s1-read/FAILED-LOGIN" ] && ok "  ... an ordinary failure is not a failed login" || bad "  ... tombstone on ordinary failure"
mkfix guarderr ok syn; printf 'ERROR: division by zero (SQLSTATE 22012)\n' > "$F/res/s1-body-md5.error"; runit
refuse "a guard refusal (division by zero) mid-run stops with its explanation" "division by zero means the history max is not 0246"

# result-shape refusals: each edits the synthetic ok results and must stop before a verdict that could read as a go
edit() { # edit FILE 'node-expression over j'
  node -e 'const fs=require("fs");const p=process.argv[1];let j=JSON.parse(fs.readFileSync(p));'"$2"';fs.writeFileSync(p,JSON.stringify(j));' "$F/res/$1.json"
}
mkfix ambig ok syn; edit s1-body-md5 'j.push({...j.find(r=>r.fn==="start_session"),args:"p_x uuid, p_y uuid"})'; runit
refuse "two overloads of a replaced function: refused (the baseline names one body)" "start_session has 2 overloads"
mkfix nofn ok syn; edit s1-closures 'j=j.filter(r=>r.fn!=="save_client_card_on_file")'; runit
refuse "a baseline closure function missing from the result: refused" "the functions read are not exactly the baseline closures"
mkfix extrafn ok syn; edit s1-closures 'j.push({...j[0],fn:"some_other_function"})'; runit
refuse "an extra function in the result: refused" "the functions read are not exactly the baseline closures"
mkfix strbool ok syn; edit s1-closures 'j[0].anon="f"'; runit
refuse "a closure flag that is not a boolean: refused" "is not a boolean"
mkfix tpbad ok syn; edit s1-table-privileges 'j.find(r=>r.role_name==="authenticated").held=true'; runit
refuse "authenticated holds INSERT on audit_logs: refused by the comparator" "OVERALL FAIL"
has "$OUT" "authenticated:insert:audit_logs must be false" && ok "  ... naming the privilege" || bad "  ... text"
mkfix tplist ok syn; edit s1-table-privileges 'j=j.slice(0,1)'; runit
refuse "a missing table privilege row: refused" "not exactly the baseline list"
mkfix cenbad ok syn; edit census-0213-0246 'j[5].present_now=j[5].objects_checked-1'; runit
refuse "a census row with a missing object: refused" "FAIL          S1-2 "
mkfix g10bad ok syn; edit s1-g10 'j.forEach(r=>{r.present_total=6});j[3].present=false'; runit
refuse "G10 below 7: refused" "FAIL          S1-2c"
mkfix dup ok syn; edit s1-history 'j[0].applied_count=246;j[0].versions_ge_0213=35'; runit
refuse "a history with 246 rows (a duplicate): stopped at the first file" "s1-history: the history is not exactly 245 rows"
mkfix above ok syn; edit s1-history 'j[0].hosted_max="0247";j[0].versions_above_0246=1'; runit
refuse "a version above 0246: stopped at the first file" "s1-history: the history is not exactly 245 rows"
mkfix noguard ok syn; edit s1-closures 'j[0].at_hosted_0246=0'; runit
refuse "a closure result whose chain guard value is not 1: refused" "the chain guard value is not 1"
mkfix emptyres ok syn; printf '[]' > "$F/res/s1-g10.json"; runit
refuse "an empty result is refused" "the result is not a non-empty JSON array of objects"
mkfix errobj ok syn; printf '{"error":"x"}' > "$F/res/s1-g10.json"; runit
refuse "an error object instead of an array is refused (the runner refuses it)" "s1-g10.sql failed (exit"

echo "passed: $pass failed: $fail skipped: $skipped"
[ "$fail" = 0 ] || exit 1
