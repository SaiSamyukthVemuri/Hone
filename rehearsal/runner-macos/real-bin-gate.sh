#!/bin/bash
# INSTALLER-MACOS step 4: the variant runner's version gate against the REAL installed 2.102.0 binary, stub for everything else.
# No hosted call: the wrapper hands --version to the real binary and answers any other call (the query) itself.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REAL="${1:?path to the installed supabase binary}"
T="$(mktemp -d "${RUNNER_TEMP:-/tmp}/realgate.XXXXXX")"
echo "real binary: $REAL"; echo "real --version (exact, bracketed): [$("$REAL" --version)]"
# (a) the variant's own gate expression, verbatim, on the real binary
v="$("$REAL" --version 2>/dev/null || true)"; [ "$v" = "2.102.0" ] && echo "gate expression: PASS ($v)" || { echo "gate expression: FAIL ($v)"; exit 1; }
# (b) the variant itself, BIN = a wrapper that execs the real binary for --version only
mkdir -p "$T/d" "$T/cwd/supabase/.temp" "$T/w"
cp "$HERE/run-window-read-macos.sh" "$T/d/"
echo 'with t as (select 1 as n) select n from t;' > "$T/d/gate.sql"
printf '%s  gate.sql\n' "$(shasum -a 256 "$T/d/gate.sql" | cut -d' ' -f1)" > "$T/d/MANIFEST.sha256"
REF=abcdefghijklmnopqrst
echo "$REF" > "$T/cwd/supabase/.temp/project-ref"
echo "postgresql://postgres.$REF@aws-1-us-east-1.pooler.supabase.com:5432/postgres" > "$T/cwd/supabase/.temp/pooler-url"
cat > "$T/w/supabase" <<SH
#!/bin/sh
echo "\$*" >> "$T/calls"
case "\$1" in --version) exec "$REAL" --version ;; esac
echo '{"rows":[]}'
SH
chmod +x "$T/w/supabase"
( cd "$T/cwd" && env -i PATH="/usr/bin:/bin" HOME="$T" HONE_WINDOW_PROJECT_REF="$REF" SUPABASE_DB_PASSWORD=synthetic-not-a-secret HONE_SUPABASE_BIN="$T/w/supabase" /bin/bash "$T/d/run-window-read-macos.sh" gate.sql ) > "$T/out" 2> "$T/err"; rc=$?
echo "variant exit: $rc"; echo "variant stderr:"; sed 's/^/  /' "$T/err"; echo "variant stdout: $(cat "$T/out")"
echo "calls the wrapper saw:"; sed 's/^/  /' "$T/calls"
[ "$rc" = 0 ] && grep -q '^--version$' "$T/calls" && grep -q "^db query --linked -o json -f $T/d/gate.sql$" "$T/calls" || { echo "FAIL: variant did not pass with the real binary's version"; exit 1; }
# (c) the real binary refuses nothing here: and a wrapper reporting another version is refused (the gate bites)
cat > "$T/w/supabase" <<'SH'
#!/bin/sh
case "$1" in --version) echo 2.102.1 ;; *) echo '{"rows":[]}' ;; esac
SH
( cd "$T/cwd" && env -i PATH="/usr/bin:/bin" HOME="$T" HONE_WINDOW_PROJECT_REF="$REF" SUPABASE_DB_PASSWORD=synthetic-not-a-secret HONE_SUPABASE_BIN="$T/w/supabase" /bin/bash "$T/d/run-window-read-macos.sh" gate.sql ) >/dev/null 2>"$T/err2"; rc2=$?
echo "control (version 2.102.1): exit $rc2"; sed 's/^/  /' "$T/err2"
[ "$rc2" = 2 ] || { echo "FAIL: control not refused"; exit 1; }
echo "REAL-BIN GATE: PASS"
