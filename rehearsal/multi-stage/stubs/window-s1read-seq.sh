#!/bin/bash
# TEST STUB of window-s1read-<stage>.sh (CI only). Like the pinned script it reads the access token and then the database password from the terminal itself,
# then writes what the real read-back writes: results/s1-history-<stage>.json + sidecar + verdict.txt, the history taken from $HOME/remote-history.
H=$HOME; CFG=$H/stubcfg; TTY=__TTY__
cfg() { sed -n "s/^$1=//p" "$CFG" 2>/dev/null | head -1; }
IFS= read -rs -p "Supabase access token (not shown): " TOK <"$TTY" || exit 1
IFS= read -rs -p "Database password (not shown; only its presence is used here): " PW <"$TTY" || exit 1
: > "$H/s1read-called"
[ "$(cfg S1READ)" = fail ] && { echo "STOP: the read-back failed" >&2; exit 1; }
sleep 2   # the sidecar times have one-second resolution and the real read-back runs minutes after the marker
S=$(cfg S_STAGE); VER=$(cfg S_VER); HIST=$H/remote-history
D=$(mktemp -d "$H/hone-s1/s1read.XXXXXX"); mkdir -p "$D/results"
md5() { if command -v md5sum >/dev/null 2>&1; then md5sum | cut -d' ' -f1; else md5 -q; fi; }
n=$(grep -c . "$HIST"); mx=$(LC_ALL=C sort "$HIST" | tail -1); md=$(LC_ALL=C sort "$HIST" | tr '\n' ',' | sed 's/,$//' | tr -d '\n' | md5); r=$(grep -c "^$VER\$" "$HIST")
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# rows_0257/rows_0247 are the extra columns the adopted reviewed package's history check reads (harmless to the generated ones)
printf '[{"applied_count":%s,"hosted_max":"%s","list_md5":"%s","rows_%s":%s,"rows_0257":%s,"rows_0247":%s}]\n' "$n" "$mx" "$md" "$VER" "$r" "$(grep -c '^0257$' "$HIST")" "$(grep -c '^0247$' "$HIST")" > "$D/results/s1-history-$S.json"
rs=$(shasum -a 256 "$D/results/s1-history-$S.json" | cut -d' ' -f1)
printf '{"file":"s1-history-%s.sql","sql_sha256":"%s","result_sha256":"%s","started_at_utc":"%s","captured_at_utc":"%s","exit_code":0}\n' "$S" "$(cfg S_S1H)" "$rs" "$now" "$now" > "$D/results/s1-history-$S.meta.json"
cfg S_OVERALL > "$D/verdict.txt"
exit 0
