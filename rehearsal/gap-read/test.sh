#!/bin/bash
# REHEARSAL - NEVER MERGE. GAP-READ-MAC on macOS arm64 (macos-14): window-gap-read.sh (the REAL script; the test copy differs only on the
# GO_SHA / RUNNER_SHA lines, diffed below) driven through a pty with the REAL runner (only its go-hash constant substituted, so its
# lexical read-only gate runs on the REAL SQL 5aa510c0) and a STUB supabase-go that returns a prepared result. No hosted call, no secret.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; SRC="$HERE/pkg"
T="$(mktemp -d "${TMPDIR:-/tmp}/gap.XXXXXX")"; T="$(cd "$T" && pwd -P)"
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
has() { grep -qF -- "$2" "$1"; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
TOKEN=TOKEN-SECRET-9f3a1b; PASSWORD=PW-SECRET-77c2de
SQL=obs-1035-gap-pending-payments-v2.sql

# ---- static pins
[ "$(sha "$SRC/$SQL")" = 5aa510c082e0484202d90503c5266a3c534250b90952e9b0a3a9d051e51e0086 ] && [ "$(sha "$SRC/run-window-read-macos.sh")" = 471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357 ] && ok "sql 5aa510c0 and runner 471ecb9d are the pinned files" || bad "pins"
awk -v s=5aa510c082e0484202d90503c5266a3c534250b90952e9b0a3a9d051e51e0086 '$2 == "obs-1035-gap-pending-payments-v2.sql" && $1 == s {n++} END {exit n==1?0:1}' "$SRC/MANIFEST.v2.sha256" && ok "MANIFEST.v2 lists the SQL once with 5aa510c0" || bad "manifest line"
st() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2; }
[ "$(st "$SRC/window-gap-read.sh" MANIFEST_SHA)" = "$(sha "$SRC/MANIFEST.v2.sha256")" ] && [ "$(st "$SRC/window-gap-read.sh" RUNNER_SHA)" = "$(sha "$SRC/run-window-read-macos.sh")" ] && [ "$(st "$SRC/window-gap-read.sh" SQL_SHA)" = "$(sha "$SRC/$SQL")" ] && ok "wrapper pins equal the real manifest, runner and SQL" || bad "wrapper pins"
bash -n "$SRC/window-gap-read.sh" && ok "bash -n" || bad "syntax"
n=$(grep -cE "select '[a-z_]+' as src, '[a-z_]+' as state," "$SRC/$SQL"); [ "$n" = 19 ] && ok "the SQL names exactly 19 (src, state) rows" || bad "sql row count" "$n"

# ---- the download line, under bash and zsh, with a fake scp
LINE=$(grep -F '( set -u;' "$SRC/DOWNLOAD-GAP.txt")
[ "$(printf '%s\n' "$LINE" | grep -c .)" = 1 ] && [ -z "$(printf '%s' "$LINE" | tr -d -c "'#<>")" ] && ok "download: one line, no apostrophe, hash or angle bracket" || bad "download line shape"
mkdir -p "$T/bin"
cat > "$T/bin/scp" <<'FAKE'
#!/bin/sh
n=$#; i=0; dest=""; for a in "$@"; do i=$((i+1)); [ "$i" = "$n" ] && dest="$a"; done
[ -n "${FAKE_SCP_FAIL-}" ] && exit 1
for a in "$@"; do case "$a" in -q|"$dest") ;; *:/*) cp "$FAKE_SRC/$(basename "$a")" "$dest" ;; esac; done
FAKE
chmod +x "$T/bin/scp"
for SH in bash zsh; do
  command -v $SH >/dev/null 2>&1 || continue
  DH="$T/dl-$SH"; mkdir -p "$DH/hone-s1"
  OUTD=$(env -i HOME="$DH" PATH="$T/bin:/usr/bin:/bin" TMPDIR="$T" FAKE_SRC="$SRC" $SH -c "$LINE" 2>&1)
  G="$DH/hone-s1/gap-read-2"
  [ "$(ls "$G" | wc -l | tr -d ' ')" = 4 ] && [ "$(sha "$G/MANIFEST.sha256")" = "$(sha "$SRC/MANIFEST.v2.sha256")" ] && [ -x "$G/window-gap-read.sh" ] && printf '%s' "$OUTD" | grep -q "sha256 OK, installed" && ok "$SH: download installs four files (manifest as MANIFEST.sha256), wrapper executable" || bad "$SH download" "$OUTD"
done
DH="$T/dl-bad"; mkdir -p "$DH/hone-s1" "$T/tamper"; cp "$SRC"/* "$T/tamper/"; printf '\n-- x\n' >> "$T/tamper/$SQL"
OUTD=$(env -i HOME="$DH" PATH="$T/bin:/usr/bin:/bin" TMPDIR="$T" FAKE_SRC="$T/tamper" bash -c "$LINE" 2>&1)
[ ! -e "$DH/hone-s1/gap-read-2" ] && printf '%s' "$OUTD" | grep -q "STOP: download or sha256 check failed" && ok "a tampered SQL on the server: STOP, nothing installed" || bad "tamper download" "$OUTD"

# ---- the wrapper
SRCSQL="$SRC/$SQL"
mkrows() { # mkrows FILE  -> the 19 expected rows, all zero except two
  python3 - "$SRCSQL" "$1" <<'PY'
import re,sys,json
pairs=re.findall(r"select '([a-z_]+)' as src, '([a-z_]+)' as state,",open(sys.argv[1]).read())
rows=[{"at_hosted_0246":1,"src":s,"state":t,"rows_in_lookback":(3 if i==0 else 0)} for i,(s,t) in enumerate(pairs)]
json.dump(rows,open(sys.argv[2],"w"))
PY
}
mkfix() { # mkfix NAME
  F="$T/$1"; H="$F/home"; ROOT="$H/hone-s1"; G="$ROOT/gap-read-2"; mkdir -p "$ROOT/supabase-cli" "$G"; chmod 700 "$ROOT"
  CALLS="$F/calls.log"; : > "$CALLS"; echo ok > "$F/mode"; mkrows "$F/result.json"
  printf '#!/bin/sh\necho "$*" >> "%s"\nif [ "$(cat "%s")" = authfail ]; then echo "failed SASL auth (FATAL: password authentication failed)" >&2; exit 1; fi\ncat "%s"\n' "$CALLS" "$F/mode" "$F/result.json" > "$ROOT/supabase-cli/supabase-go"; chmod 755 "$ROOT/supabase-cli/supabase-go"
  GOSHA=$(sha "$ROOT/supabase-cli/supabase-go")
  sed "s/^SUPABASE_GO_SHA256=.*/SUPABASE_GO_SHA256=$GOSHA/" "$SRC/run-window-read-macos.sh" > "$G/run-window-read-macos.sh"; chmod 755 "$G/run-window-read-macos.sh"
  RSHA=$(sha "$G/run-window-read-macos.sh")
  cp "$SRC/MANIFEST.v2.sha256" "$G/MANIFEST.sha256"; cp "$SRC/$SQL" "$G/"
  sed -e "s/^GO_SHA=.*/GO_SHA=$GOSHA/" -e "s/^RUNNER_SHA=.*/RUNNER_SHA=$RSHA/" "$SRC/window-gap-read.sh" > "$G/window-gap-read.sh"; chmod 755 "$G/window-gap-read.sh"
  RUNSCRIPT="$G/window-gap-read.sh"
  printf 'Supabase access token\t%s\nDatabase password\t%s\n' "$TOKEN" "$PASSWORD" > "$F/answers.txt"
}
run() { RC=0; python3 "$HERE/driver.py" "$F/out.txt" "$F/answers.txt" -- env -i PATH=${SHIM:+$SHIM:}/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v node)") HOME="$H" TERM=dumb /bin/bash "$RUNSCRIPT" || RC=$?; OUT="$F/out.txt"; }
ncalls() { grep -c . "$CALLS"; }
stop() { # stop LABEL MSG CALLS
  if [ "$RC" != 0 ] && has "$OUT" "$2" && [ "$(ncalls)" = "$3" ]; then ok "$1 (exit $RC, $3 supabase-go call(s))"; else bad "$1" "rc=$RC calls=$(ncalls)"; tail -6 "$OUT"; fi; }

mkfix pinsdiff; d=$(diff "$SRC/window-gap-read.sh" "$G/window-gap-read.sh" | grep '^[<>]' | grep -Ev '^[<>] (GO_SHA|RUNNER_SHA)=' | wc -l | tr -d ' ')
[ "$d" = 0 ] && ok "the test copy of the wrapper differs from the real one only on GO_SHA / RUNNER_SHA" || bad "test copy differs elsewhere"
grep -c 'SUPABASE_GO_SHA256' "$G/run-window-read-macos.sh" >/dev/null; d=$(diff "$SRC/run-window-read-macos.sh" "$G/run-window-read-macos.sh" | grep '^[<>]' | grep -v '^[<>] SUPABASE_GO_SHA256=' | wc -l | tr -d ' ')
[ "$d" = 0 ] && ok "the test runner differs from 471ecb9d only on its go-hash constant (its lexical gate is the real one)" || bad "test runner differs elsewhere"

mkfix happy; run; tail -n 28 "$OUT" | cut -c1-170
[ "$RC" = 0 ] && has "$OUT" "GAP READ: 19 rows, at_hosted_0246 = 1 on every row" && ok "happy path: the real runner accepted the real SQL, 19 rows validated and printed, exit 0" || bad "happy path" "rc=$RC"
[ "$(grep -c '^  [a-z_]' "$OUT")" -ge 19 ] && ok "  ... 19 count lines printed" || bad "  ... count lines"
has "$OUT" "NON-ZERO non-informational rows: 1" && ok "  ... one non-zero finding row is flagged for report to OPS (the stub sets exactly one)" || bad "  ... nonzero summary"
has "$OUT" "(informational)" && ok "  ... informational rows are marked" || bad "  ... informational mark"
[ "$(ncalls)" = 1 ] && grep -q -- '--linked' "$CALLS" && ok "  ... exactly one supabase-go call (one login)" || bad "  ... call count" "$(cat "$CALLS")"
grep -rqF -e "$TOKEN" -e "$PASSWORD" "$OUT" "$ROOT" "$F/home" 2>/dev/null && bad "  ... a secret appears in output or on disk" || ok "  ... neither the token nor the password appears in the output or on disk"
ls "$ROOT"/gapread.*/results | grep -qx "$SQL" 2>/dev/null; ls "$ROOT"/gapread.*/results/*.meta.json >/dev/null 2>&1 && ok "  ... the sidecar was written and bound" || bad "  ... no sidecar"

# result validation failures: the run stops, 1 call, no retry
mut() { # mut NAME PYEXPR MSG LABEL
  mkfix "$1"; python3 - "$F/result.json" "$2" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); exec(sys.argv[2]); json.dump(r,open(sys.argv[1],"w"))
PY
  run; stop "$4" "$3" 1; }
mut r18 'r.pop()' "read_first: 18 rows" "18 rows is refused"
mut r20 'r.append(dict(r[0],state="extra"))' "read_first: 20 rows" "20 rows is refused"
mut g0 'r[5]["at_hosted_0246"]=0' "at_hosted_0246 is not 1" "at_hosted_0246 = 0 on one row is refused"
mut gmiss 'del r[3]["at_hosted_0246"]' "unexpected columns" "a missing at_hosted_0246 is refused"
mut dup 'r[1]=dict(r[0])' "duplicate row" "a duplicated row (19 rows, one missing) is refused"
mut unk 'r[2]["state"]="made_up_state"' "is not one the pinned SQL names" "an unknown (src, state) is refused"
mut neg 'r[4]["rows_in_lookback"]=-1' "non-negative integer" "a negative count is refused"
mut frac 'r[4]["rows_in_lookback"]=1.5' "non-negative integer" "a fractional count is refused"
mut txt 'r[4]["rows_in_lookback"]="many"' "non-negative integer" "a text count is refused"
mut extra 'r[0]["id"]="x"' "unexpected columns" "an extra column (a possible identifier) is refused"
mkfix strnum; python3 - "$F/result.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
for x in r: x["at_hosted_0246"]="1"; x["rows_in_lookback"]=str(x["rows_in_lookback"])
json.dump(r,open(sys.argv[1],"w"))
PY
run; [ "$RC" = 0 ] && ok "numeric strings (as a bigint count may arrive) are accepted" || bad "numeric strings" "rc=$RC"

# guards before any call
mkfix badsql; printf '\n' >> "$G/$SQL"; run; stop "an edited SQL on the Mac is refused before any call" "sha256 mismatch" 0
mkfix badman; printf 'x\n' >> "$G/MANIFEST.sha256"; run; stop "an edited manifest is refused before any call" "manifest missing or sha256 mismatch" 0
mkfix badrun; printf '\n' >> "$G/run-window-read-macos.sh"; run; stop "an edited runner copy is refused before any call" "runner copy missing or sha256 mismatch" 0
mkfix tombs1; mkdir -p "$ROOT/s1-read"; echo x > "$ROOT/s1-read/FAILED-LOGIN"; run; stop "a FAILED-LOGIN left by s1-read refuses" "a previous run failed a login" 0
mkfix tombs1a; mkdir -p "$ROOT/s1-apply"; echo x > "$ROOT/s1-apply/FAILED-LOGIN"; run; stop "a FAILED-LOGIN left by s1-apply refuses" "a previous run failed a login" 0
mkfix tombown; mkdir -p "$ROOT/gap-read"; echo x > "$ROOT/gap-read/FAILED-LOGIN"; run; stop "its own FAILED-LOGIN refuses" "a previous run failed a login" 0
mkfix emptypw; printf 'Supabase access token\t%s\nDatabase password\t\n' "$TOKEN" > "$F/answers.txt"; run; stop "an empty password is refused before any call" "empty password" 0
mkfix envbad; RC=0; python3 "$HERE/driver.py" "$F/out.txt" "$F/answers.txt" -- env -i PATH=${SHIM:+$SHIM:}/usr/bin:/bin:$(dirname "$(command -v node)") HOME="$H" TERM=dumb PGPASSWORD=x /bin/bash "$RUNSCRIPT" || RC=$?; OUT="$F/out.txt"; stop "PGPASSWORD in the environment is refused before any call" "unset these variables first" 0
mkfix authf; echo authfail > "$F/mode"; run
[ "$RC" != 0 ] && [ -e "$ROOT/gap-read/FAILED-LOGIN" ] && [ "$(ncalls)" = 1 ] && ! grep -qF -e "$PASSWORD" -e "$TOKEN" "$ROOT/gap-read/FAILED-LOGIN" && ok "an authentication failure writes the tombstone (no secret), 1 call, no retry" || bad "auth failure" "rc=$RC calls=$(ncalls)"
mkfix badlex; printf '%s\n' "$(cat "$G/$SQL")" > "$G/$SQL.tmp"; echo "update public.stripe_events set error = null;" >> "$G/$SQL.tmp"; mv "$G/$SQL.tmp" "$G/$SQL"; awk -v f="$SQL" -v s="$(sha "$G/$SQL")" '{ if ($2==f) $1=s; print $1"  "$2 }' "$G/MANIFEST.sha256" > "$G/M.new"; mv "$G/M.new" "$G/MANIFEST.sha256"; run
[ "$RC" != 0 ] && [ "$(ncalls)" = 0 ] && ok "control: even with a re-pinned manifest, an edited SQL fails the wrapper's own pins before any call" || bad "control edited SQL" "rc=$RC calls=$(ncalls)"

echo; echo "passed: $pass failed: $fail"
[ "$fail" = 0 ]
