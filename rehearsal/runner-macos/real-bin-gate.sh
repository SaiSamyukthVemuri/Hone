#!/bin/bash
# The variant runner's sha256 gate against the REAL installed supabase-go (R5). The real binary is only HASHED here: it is
# never executed (no --version, no query), so no network or hosted call can occur. The variant's run_cli is replaced by a
# stub in a TEST COPY, which is the only difference from the real variant besides none.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REAL="${1:?path to the installed supabase-go}"
T="$(mktemp -d "${RUNNER_TEMP:-/tmp}/realgate.XXXXXX")"
VAR="$HERE/run-window-read-macos.sh"
const="$(grep '^SUPABASE_GO_SHA256=' "$VAR" | cut -d= -f2)"
real_sha="$(shasum -a 256 "$REAL" | cut -d' ' -f1)"
echo "variant constant : $const"; echo "installed binary : $real_sha"
[ "$const" = "$real_sha" ] && echo "constant == installed supabase-go: YES" || { echo "constant != installed binary"; exit 1; }
mkdir -p "$T/d" "$T/cwd/supabase/.temp"
# test copy: ONLY the run_cli line is replaced (a stub that prints an empty array; it never touches the binary)
sed 's#^run_cli() {.*#run_cli() { echo "STUB-CLI (binary not executed): $*" >> "'"$T"'/calls"; echo "[]"; }#' "$VAR" > "$T/d/run-window-read-macos.sh"
n="$(diff "$VAR" "$T/d/run-window-read-macos.sh" | grep -c '^>')"; echo "lines differing in the test copy: $n"; [ "$n" = 1 ] || exit 1
echo 'with t as (select 1 as n) select n from t;' > "$T/d/gate.sql"
printf '%s  gate.sql\n' "$(shasum -a 256 "$T/d/gate.sql" | cut -d' ' -f1)" > "$T/d/MANIFEST.sha256"
REF=abcdefghijklmnopqrst
echo "$REF" > "$T/cwd/supabase/.temp/project-ref"
echo "postgresql://postgres.$REF@aws-1-us-east-1.pooler.supabase.com:5432/postgres" > "$T/cwd/supabase/.temp/pooler-url"
echo "v2.102.0" > "$T/cwd/supabase/.temp/cli-latest"
runit() { ( cd "$T/cwd" && env -i PATH="/usr/bin:/bin" HOME="$T" HONE_WINDOW_PROJECT_REF="$REF" SUPABASE_DB_PASSWORD=synthetic-not-a-secret HONE_SUPABASE_BIN="$1" /bin/bash "$T/d/run-window-read-macos.sh" gate.sql ) > "$T/out" 2> "$T/err"; echo $?; }
rc="$(runit "$REAL")"
echo "variant with the real supabase-go: exit $rc"; sed 's/^/  /' "$T/err"; echo "  stdout: $(cat "$T/out")"; echo "  calls: $(cat "$T/calls" 2>/dev/null)"
[ "$rc" = 0 ] && grep -q '^STUB-CLI' "$T/calls" || { echo "FAIL: the real binary did not pass the sha gate"; exit 1; }
# controls: a copy with one extra byte, and a different file that prints the right version, are refused
cp "$REAL" "$T/tampered"; printf 'x' >> "$T/tampered"; chmod +x "$T/tampered"
rc2="$(runit "$T/tampered")"; echo "control (one byte appended): exit $rc2: $(grep REFUSED "$T/err")"; [ "$rc2" = 2 ] || { echo "FAIL: control not refused"; exit 1; }
printf '#!/bin/sh\necho 2.102.0\n' > "$T/liar"; chmod +x "$T/liar"
rc3="$(runit "$T/liar")"; echo "control (prints 2.102.0 but wrong hash): exit $rc3: $(grep REFUSED "$T/err")"; [ "$rc3" = 2 ] || { echo "FAIL: liar not refused"; exit 1; }
echo "REAL-BIN SHA GATE: PASS"
