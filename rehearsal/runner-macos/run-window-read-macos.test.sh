#!/usr/bin/env bash
# Tests for run-window-read-macos.sh. Synthetic only: a stub CLI and a fake npx, no hosted call, no database.
# Written for bash 3.2 (macOS /bin/bash) and GNU bash. Run: bash run-window-read-macos.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VARIANT="$HERE/run-window-read-macos.sh"
ORIG="$HERE/run-window-read.sh"
T="$(mktemp -d "${TMPDIR:-/tmp}/rwr-macos.XXXXXX")"
T="$(cd "$T" && pwd -P)"
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "want [$3] got [$2]"; fi; }
sha_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }

REF="abcdefghijklmnopqrst"
POOLER="postgresql://postgres.$REF@aws-1-us-east-1.pooler.supabase.com:5432/postgres"
mkdir -p "$T/bin"
cat > "$T/bin/supabase" <<'STUB'
#!/bin/sh
echo "$*" >> "$STUB_LOG"
case "$1" in --version) printf '%s\n' "${STUB_VERSION-2.102.0}"; exit 0 ;; esac
echo '{"rows":[]}'
STUB
cat > "$T/bin/npx" <<'STUB'
#!/bin/sh
echo "npx $*" >> "$STUB_LOG"
echo '{"rows":[]}'
STUB
chmod +x "$T/bin/supabase" "$T/bin/npx"
# A sha256sum shim for the PINNED runner only (it needs one; stock macOS has none). Last on PATH, so GNU's wins where it exists.
mkdir -p "$T/shim"; printf '#!/bin/sh\nexec shasum -a 256 "$@"\n' > "$T/shim/sha256sum"; chmod +x "$T/shim/sha256sum"

# A working directory shaped like the linked checkout.
mkcwd() { # name [pooler-url-text]
  d="$T/cwd-$1"; mkdir -p "$d/supabase/.temp"
  printf '%s\n' "$REF" > "$d/supabase/.temp/project-ref"
  printf '%s\n' "${2-$POOLER}" > "$d/supabase/.temp/pooler-url"
  echo "$d"
}
# A script directory: a copy of the script, one synthetic gate file, its manifest.
mkdirs() { # name script gate-sql
  d="$T/dir-$1"; mkdir -p "$d"; cp "$2" "$d/$(basename "$2")"
  printf '%s\n' "$3" > "$d/gate.sql"
  printf '%s  gate.sql\n' "$(sha_of "$d/gate.sql")" > "$d/MANIFEST.sha256"
  echo "$d"
}
GOOD='with t as (select 1 as n) select n from t;'
LOG="$T/log"; : > "$LOG"; export STUB_LOG="$LOG"
# run <script> <cwd> [args...] with the standard good environment; extra env via ENVX (space separated KEY=VAL)
run() {
  script="$1"; cwd="$2"; shift 2
  ( cd "$cwd" && env -i PATH="${RUN_PATH:-$PATH}" HOME="$T" STUB_LOG="$LOG" HONE_WINDOW_PROJECT_REF="${PREF-$REF}" \
      ${PW-SUPABASE_DB_PASSWORD=synthetic-not-a-secret} ${BIN-HONE_SUPABASE_BIN=$T/bin/supabase} ${ENVX:-} \
      "${BASH_BIN:-bash}" "$script" "$@" ) 2>"$T/err" >"$T/out"
  echo $?
}
errtxt() { cat "$T/err"; }

# ---- 1. happy path, GNU hash path ----
D="$(mkdirs happy "$VARIANT" "$GOOD")"; C="$(mkcwd happy)"; : > "$LOG"
check "BIN: a good gate file runs (exit 0)" "$(run "$D/run-window-read-macos.sh" "$C" gate.sql)" 0
check "BIN: stdout is the CLI's JSON" "$(cat "$T/out")" '{"rows":[]}'
check "BIN: the CLI call is exactly db query --linked -o json -f <file>" "$(grep -v '^--version' "$LOG")" "db query --linked -o json -f $D/gate.sql"
check "BIN: npx was not called" "$(grep -c '^npx' "$LOG")" 0
if grep -E -q -- '--local|--db-url|psql' "$LOG"; then bad "BIN: no --local/--db-url/psql in any call"; else ok "BIN: no --local/--db-url/psql in any call"; fi

# ---- 2. capture sidecar, and the runner sha is the variant's own ----
RD="$T/res1"; mkdir -p "$RD"; : > "$LOG"
ENVX="HONE_WINDOW_RESULT_DIR=$RD" check "capture: exit 0" "$(ENVX="HONE_WINDOW_RESULT_DIR=$RD" run "$D/run-window-read-macos.sh" "$C" gate.sql)" 0
meta="$RD/gate.meta.json"
check "capture: result file written" "$(cat "$RD/gate.json")" '{"rows":[]}'
want_runner="$(sha_of "$D/run-window-read-macos.sh")"
grep -q "\"runner_sha256\":\"$want_runner\"" "$meta" && ok "capture: runner_sha256 is the variant file's own hash" || bad "capture: runner_sha256" "$(cat "$meta")"
grep -q "\"manifest_sha256\":\"$(sha_of "$D/MANIFEST.sha256")\"" "$meta" && ok "capture: manifest_sha256 correct" || bad "capture: manifest_sha256"
grep -q "\"result_sha256\":\"$(sha_of "$RD/gate.json")\"" "$meta" && ok "capture: result_sha256 correct" || bad "capture: result_sha256"
grep -q '"exit_code":0' "$meta" && ok "capture: exit_code 0" || bad "capture: exit_code"
check "capture: a second run never overwrites" "$(ENVX="HONE_WINDOW_RESULT_DIR=$RD" run "$D/run-window-read-macos.sh" "$C" gate.sql)" 2
GNU_META="$(sed -e 's/"started_at_utc":"[^"]*"//' -e 's/"captured_at_utc":"[^"]*"//' "$meta")"

# ---- 3. the shasum path: a PATH with no sha256sum ----
MP="$T/minpath"; mkdir -p "$MP"
for t in awk sed tr grep cut wc mktemp date mv printenv basename dirname cat shasum perl env head rm sh bash; do
  p="$(command -v "$t" 2>/dev/null || true)"; [ -n "$p" ] && [ -x "$p" ] && ln -sf "$p" "$MP/$t"
done
if PATH="$MP" command -v sha256sum >/dev/null 2>&1; then bad "shasum path setup: sha256sum is absent from the test PATH"; else ok "shasum path setup: sha256sum is absent from the test PATH"; fi
RD2="$T/res2"; mkdir -p "$RD2"; : > "$LOG"
check "shasum: a good gate file runs with no sha256sum on PATH" "$(RUN_PATH="$MP" ENVX="HONE_WINDOW_RESULT_DIR=$RD2" run "$D/run-window-read-macos.sh" "$C" gate.sql)" 0
SH_META="$(sed -e 's/"started_at_utc":"[^"]*"//' -e 's/"captured_at_utc":"[^"]*"//' "$RD2/gate.meta.json")"
check "shasum: the sidecar is identical to the sha256sum one (apart from times)" "$SH_META" "$GNU_META"
# a tampered gate file is refused on the shasum path too
D2="$(mkdirs tamper "$VARIANT" "$GOOD")"; echo '-- edited' >> "$D2/gate.sql"
check "shasum: an edited gate file is refused" "$(RUN_PATH="$MP" run "$D2/run-window-read-macos.sh" "$C" gate.sql)" 2
echo "$(errtxt)" | grep -q "does not match MANIFEST" && ok "shasum: refusal text is the manifest mismatch" || bad "shasum: refusal text" "$(errtxt)"
# neither tool
rm -f "$MP/shasum"
check "no hash tool: refused" "$(RUN_PATH="$MP" run "$D/run-window-read-macos.sh" "$C" gate.sql)" 2
errtxt | grep -q "neither sha256sum nor shasum" && ok "no hash tool: names the reason" || bad "no hash tool: names the reason" "$(errtxt)"

# the problem the variant fixes: the pinned runner cannot run where there is no sha256sum
MP2="$T/minpath2"; mkdir -p "$MP2"; for t in awk sed tr grep cut wc mktemp date mv printenv basename dirname cat shasum perl env head rm sh bash; do p="$(command -v "$t" 2>/dev/null || true)"; [ -n "$p" ] && ln -sf "$p" "$MP2/$t"; done
Dp="$(mkdirs pinned "$ORIG" "$GOOD")"
check "pinned runner with no sha256sum on PATH: fails (127), which is why the variant exists" "$(BIN="" RUN_PATH="$MP2:$T/bin" run "$Dp/run-window-read.sh" "$C" gate.sql)" 127

# ---- 4. HONE_SUPABASE_BIN refusals ----
refuse_case() { # label expected-substring [ENVX]
  : > "$LOG"; rc="$(ENVX="${3:-}" run "$D/run-window-read-macos.sh" "$C" gate.sql)"
  check "$1: exit 2" "$rc" 2
  errtxt | grep -q -- "$2" && ok "$1: says why" || bad "$1: says why" "$(errtxt)"
  if grep -q '^db query' "$LOG"; then bad "$1: the CLI never ran a query"; else ok "$1: the CLI never ran a query"; fi
}
refuse_case "BIN version 2.102.1" "exactly 2.102.0" "STUB_VERSION=2.102.1"
refuse_case "BIN version with a suffix" "exactly 2.102.0" "STUB_VERSION=2.102.0-beta"
refuse_case "BIN version with a prefix" "exactly 2.102.0" "STUB_VERSION=v2.102.0"
refuse_case "BIN version empty" "exactly 2.102.0" "STUB_VERSION="
cp "$T/bin/supabase" "$T/notexec"; chmod -x "$T/notexec"
: > "$LOG"; check "BIN not executable: exit 2" "$(BIN="HONE_SUPABASE_BIN=$T/notexec" run "$D/run-window-read-macos.sh" "$C" gate.sql)" 2
errtxt | grep -q "not an executable file" && ok "BIN not executable: says why" || bad "BIN not executable: says why"
check "BIN missing path: exit 2" "$(BIN="HONE_SUPABASE_BIN=$T/nope" run "$D/run-window-read-macos.sh" "$C" gate.sql)" 2
check "BIN is a directory: exit 2" "$(BIN="HONE_SUPABASE_BIN=$T/bin" run "$D/run-window-read-macos.sh" "$C" gate.sql)" 2
# BIN is mandatory: unset or empty is refused, with no CLI call of any kind
for mode in unset empty; do
  : > "$LOG"
  if [ "$mode" = unset ]; then rc="$(BIN="" run "$D/run-window-read-macos.sh" "$C" gate.sql)"; else rc="$(BIN="HONE_SUPABASE_BIN=" run "$D/run-window-read-macos.sh" "$C" gate.sql)"; fi
  check "BIN $mode: refused (exit 2)" "$rc" 2
  errtxt | grep -q "HONE_SUPABASE_BIN is not set (it is mandatory; there is no npx fallback)" && ok "BIN $mode: says why" || bad "BIN $mode: says why" "$(errtxt)"
  check "BIN $mode: no CLI call and no npx" "$(wc -c < "$LOG" | tr -d '[:space:]')" 0
done

# ---- 5. addendum guards: password presence and the pooler URL ----
check "password unset: exit 2" "$(PW="" run "$D/run-window-read-macos.sh" "$C" gate.sql)" 2
errtxt | grep -q "SUPABASE_DB_PASSWORD is not set or is empty" && ok "password unset: says why" || bad "password unset: says why" "$(errtxt)"
check "password empty: exit 2" "$(PW="SUPABASE_DB_PASSWORD=" run "$D/run-window-read-macos.sh" "$C" gate.sql)" 2
errtxt | grep -q "SUPABASE_DB_PASSWORD is not set or is empty" && ok "password empty: says why" || bad "password empty: says why"
: > "$LOG"; PW="" run "$D/run-window-read-macos.sh" "$C" gate.sql >/dev/null
grep -q '^db query' "$LOG" && bad "password unset: the CLI never ran" || ok "password unset: the CLI never ran"
SECRET="synthetic-secret-zzz-$$"; run "$D/run-window-read-macos.sh" "$C" gate.sql >/dev/null; PW="SUPABASE_DB_PASSWORD=$SECRET" run "$D/run-window-read-macos.sh" "$C" gate.sql >/dev/null
if grep -q "$SECRET" "$T/err" "$T/out"; then bad "password value is never printed"; else ok "password value is never printed"; fi
PW="SUPABASE_DB_PASSWORD=$SECRET" ENVX="SUPABASE_DB_URL=x" run "$D/run-window-read-macos.sh" "$C" gate.sql >/dev/null
if grep -q "$SECRET" "$T/err" "$T/out"; then bad "password value is not printed on a refusal either"; else ok "password value is not printed on a refusal either"; fi

pooler_case() { # label url-text
  c="$(mkcwd "p$RANDOM" "$2")"; : > "$LOG"
  check "$1: exit 2" "$(run "$D/run-window-read-macos.sh" "$c" gate.sql)" 2
  errtxt | grep -q "pooler-url is not exactly the aws-1-us-east-1 session pooler" && ok "$1: says why" || bad "$1: says why" "$(errtxt)"
  if grep -q '^db query' "$LOG"; then bad "$1: the CLI never ran"; else ok "$1: the CLI never ran"; fi
  if grep -q "$REF\|pooler.supabase" "$T/err"; then bad "$1: the URL is not echoed"; else ok "$1: the URL is not echoed"; fi
}
pooler_case "pooler port 6543 (transaction pooler)" "postgresql://postgres.$REF@aws-1-us-east-1.pooler.supabase.com:6543/postgres"
pooler_case "pooler with a password embedded" "postgresql://postgres.$REF:hunter2@aws-1-us-east-1.pooler.supabase.com:5432/postgres"
pooler_case "pooler wrong region host" "postgresql://postgres.$REF@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
pooler_case "pooler host aws-1-eu-west-1" "postgresql://postgres.$REF@aws-1-eu-west-1.pooler.supabase.com:5432/postgres"
pooler_case "pooler wrong project in the user" "postgresql://postgres.zzzzzzzzzzzzzzzzzzzz@aws-1-us-east-1.pooler.supabase.com:5432/postgres"
pooler_case "pooler plain postgres user (no ref)" "postgresql://postgres@aws-1-us-east-1.pooler.supabase.com:5432/postgres"
pooler_case "pooler direct host db.<ref>.supabase.co" "postgresql://postgres:x@db.$REF.supabase.co:5432/postgres"
pooler_case "pooler with a query string" "postgresql://postgres.$REF@aws-1-us-east-1.pooler.supabase.com:5432/postgres?sslmode=disable"
pooler_case "pooler with a trailing path" "postgresql://postgres.$REF@aws-1-us-east-1.pooler.supabase.com:5432/postgres/x"
pooler_case "pooler with a lookalike host suffix" "postgresql://postgres.$REF@aws-1-us-east-1.pooler.supabase.com.evil.test:5432/postgres"
pooler_case "pooler empty file" ""
c="$(mkcwd nopooler)"; rm "$c/supabase/.temp/pooler-url"
check "pooler-url file missing: exit 2" "$(run "$D/run-window-read-macos.sh" "$c" gate.sql)" 2
errtxt | grep -q "pooler-url is missing" && ok "pooler-url missing: says why" || bad "pooler-url missing: says why"
c="$(mkcwd scheme2 "postgres://postgres.$REF@aws-1-us-east-1.pooler.supabase.com:5432/postgres")"
check "pooler with the postgres:// scheme is accepted" "$(run "$D/run-window-read-macos.sh" "$c" gate.sql)" 0
c="$(mkcwd ws "  $POOLER  ")"
check "pooler with surrounding whitespace is accepted (trimmed)" "$(run "$D/run-window-read-macos.sh" "$c" gate.sql)" 0
# ---- 6. every existing refusal is kept (with BIN set) ----
check "ref mismatch: refused" "$(PREF=zzzzzzzzzzzzzzzzzzzz run "$D/run-window-read-macos.sh" "$C" gate.sql)" 2
errtxt | grep -q "does not match HONE_WINDOW_PROJECT_REF" && ok "ref mismatch: says why" || bad "ref mismatch: says why" "$(errtxt)"
check "ref unset: refused" "$(PREF="" run "$D/run-window-read-macos.sh" "$C" gate.sql)" 2
for v in SUPABASE_DB_URL DATABASE_URL PGHOST PGHOSTADDR PGDATABASE PGSERVICE E2E_SUPABASE_URL HONE_LOCAL_DB_URL; do
  check "$v set: refused" "$(ENVX="$v=x" run "$D/run-window-read-macos.sh" "$C" gate.sql)" 2
  errtxt | grep -q "$v is set" && ok "$v set: names it" || bad "$v set: names it" "$(errtxt)"
done
check "two arguments: refused" "$(run "$D/run-window-read-macos.sh" "$C" gate.sql other.sql)" 2
check "no argument: refused" "$(run "$D/run-window-read-macos.sh" "$C")" 2
check "unlisted file: refused" "$(run "$D/run-window-read-macos.sh" "$C" nothere.sql)" 2
cp "$D/gate.sql" "$D/other.sql"; check "a file not in the manifest: refused" "$(run "$D/run-window-read-macos.sh" "$C" other.sql)" 2
errtxt | grep -q "not listed in MANIFEST" && ok "unlisted: says why" || bad "unlisted: says why"
# lexical read-only check: the variant and the pinned runner must agree on every case
lex() { # label sql expected-exit
  dv="$(mkdirs "lv$RANDOM" "$VARIANT" "$2")"; do_="$(mkdirs "lo$RANDOM" "$ORIG" "$2")"; cc="$(mkcwd "l$RANDOM")"
  rv="$(run "$dv/run-window-read-macos.sh" "$cc" gate.sql)"; ev="$(errtxt | sed 's/ .*//' | head -1)"; evt="$(errtxt | grep REFUSED | head -1)"
  # the pinned runner needs npx (fake on PATH) and no pooler/password: it does not have those guards, so give it the same good env
  ro="$(BIN="" RUN_PATH="$T/bin:$PATH:$T/shim" run "$do_/run-window-read.sh" "$cc" gate.sql)"; eot="$(errtxt | grep REFUSED | head -1)"
  check "lexical [$1]: variant exit" "$rv" "$3"
  check "lexical [$1]: pinned runner exit (same verdict)" "$ro" "$3"
  [ "$3" = 2 ] && check "lexical [$1]: same refusal text" "$evt" "$eot"
}
lex "good with" "with t as (select 1) select * from t;" 0
lex "good select" "select 1;" 0
lex "insert" "select 1; insert into t values (1);" 2
lex "update inside" "with a as (update t set x=1 returning 1) select * from a;" 2
lex "delete" "with a as (delete from t returning 1) select * from a" 2
lex "into" "select 1 into t" 2
lex "set_config" "select set_config('a','b',false)" 2
lex "pg_sleep" "select pg_sleep(1)" 2
lex "nextval" "select nextval('s')" 2
lex "two statements" "select 1; select 2;" 2
lex "block comment" "select 1 /* x */" 2
lex "not select" "show all" 2
lex "begin" "begin; select 1" 2
lex "word with underscore is not a keyword" "select 1 as set_x, 2 as update_count, 3 as copy_ok" 0
lex "keyword in a string is data" "select 'insert delete update' as s" 0
lex "keyword adjacent to punctuation" "select (1)as x,count(*)from(select 1)q where(1=1)and(update_at is null)" 0
lex "keyword after a comma" "select 1,delete from t" 2
lex "keyword before a paren" "select grant(1)" 2
lex "line comment hides a keyword" "select 1 -- insert into x
" 0
lex "keyword upper case" "SELECT 1; DROP TABLE x" 2

# ---- 7. the REAL gate files: the variant admits exactly what the pinned runner admits ----
cc="$(mkcwd real)"; n=0; same=0
for f in $(awk '{print $2}' "$HERE/MANIFEST.sha256"); do
  n=$((n+1))
  rv="$(run "$HERE/run-window-read-macos.sh" "$cc" "$f")"
  ro="$(BIN="" RUN_PATH="$T/bin:$PATH:$T/shim" run "$HERE/run-window-read.sh" "$cc" "$f")"
  [ "$rv" = 0 ] && [ "$ro" = 0 ] && same=$((same+1)) || bad "real gate file $f: variant $rv, pinned $ro" "$(errtxt)"
done
check "real manifest: every listed file is admitted by both runners" "$same/$n" "$n/$n"
check "real manifest has 14 files" "$n" 14

# ---- 8. portability audit of the variant (static) ----
audit() { # label ere
  if grep -v '^[[:space:]]*#' "$VARIANT" | grep -E -q -- "$2"; then bad "audit: $1"; grep -v '^[[:space:]]*#' "$VARIANT" | grep -E -n -- "$2" | head -3; else ok "audit: $1"; fi
}
audit "no date -d" 'date +-d'
audit "no readlink -f" 'readlink +-f'
audit "no sed -i" 'sed +(-[a-zA-Z]+ +)*-i'
audit "no grep -P" 'grep +(-[a-zA-Z]+ +)*-[a-zA-Z]*P'
audit "no \\b or \\< \\> word anchors" '\\[bB<>]'
audit "no indirect expansion \${!" '\$\{!'
audit "no mapfile/readarray" '(mapfile|readarray)'
audit "no associative arrays" 'declare +-A'
audit "no case-conversion expansions" '\$\{[a-zA-Z_]+(,,|\^\^)'
audit "no &>> or |&" '(&>>|\|&)'
audit "no namerefs" 'local +-n|declare +-n'
audit "no npx invocation in the variant's code" 'npx +(--|supabase)'
audit "no stat -c / cp --" '(stat +-c|cp +--|mv +--)'
audit "no md5sum/realpath/timeout/seq/xargs -r" '(md5sum|realpath|timeout |seq |xargs +-r)'
if grep -v '^[[:space:]]*#' "$VARIANT" | grep 'sha256sum' | grep -v -e 'command -v sha256sum' -e 'neither sha256sum nor shasum' -e 'then sha256sum "\$1"' | grep -q .; then bad "audit: sha256sum only inside the helper"; else ok "audit: sha256sum only inside the helper"; fi
echo
echo "passed: $pass failed: $fail  (bash ${BASH_VERSION})"
[ "$fail" -eq 0 ]
