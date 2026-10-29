#!/bin/bash
# TEST STUB of window-s1read-0254.sh (CI only). Like the pinned script it reads the access token and then the database password from the terminal itself.
H=$HOME; CFG=$H/stubcfg; TTY=__TTY__
cfg() { sed -n "s/^$1=//p" "$CFG" 2>/dev/null | head -1; }
IFS= read -rs -p "Supabase access token (not shown): " TOK <"$TTY" || exit 1
IFS= read -rs -p "Database password (not shown; only its presence is used here): " PW <"$TTY" || exit 1
: > "$H/s1read-called"
m=$(cfg S1READ)
if [ "$m" = hang ]; then : > "$H/s1read-started"; i=0; while [ $i -lt 300 ]; do sleep 0.2; i=$((i+1)); done; exit 9; fi
[ "$m" = fail ] && { echo "STOP: the read-back failed" >&2; exit 1; }
sleep 2   # the real read-back runs minutes after the marker; the sidecar times have one-second resolution
D=$(mktemp -d "$H/hone-s1/s1read.XXXXXX"); mkdir -p "$D/results"
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ "$m" = history246 ]; then body='[{"applied_count":246,"hosted_max":"0248","rows_0254":0,"rows_0247":0}]'; else body='[{"applied_count":247,"hosted_max":"0254","rows_0254":1,"rows_0247":0}]'; fi
printf '%s\n' "$body" > "$D/results/s1-history-0254.json"
rs=$(shasum -a 256 "$D/results/s1-history-0254.json" | cut -d' ' -f1)
printf '{"file":"s1-history-0254.sql","sql_sha256":"412456d394829670f8cfe1c111dc29a62e56fd6b15c9cd4ccb2a470813f6d205","result_sha256":"%s","started_at_utc":"%s","captured_at_utc":"%s","exit_code":0}\n' "$rs" "$now" "$now" > "$D/results/s1-history-0254.meta.json"
echo 'OVERALL PASS (0254 read-back: history, 2 verify checks and the owner-only read-policy proof; read-only, not a promotion)' > "$D/verdict.txt"
exit 0
