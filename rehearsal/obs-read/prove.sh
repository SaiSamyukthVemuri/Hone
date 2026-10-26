#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. OBS-READ-PREP proof, on a throwaway CI database at the 0212 chain.
set -euo pipefail
cd "$(dirname "$0")"
export PGPASSWORD=postgres
P="psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 54322 -U postgres -d postgres"
SQL=obs/obs-0214-live-named-accounts.sql
echo "== hosted-equivalent history max: $($P -At -c 'select max(version) from supabase_migrations.schema_migrations')"
[ "$($P -At -c 'select max(version) from supabase_migrations.schema_migrations')" = 0212 ]
[ "$($P -At -c 'select count(*) from public.studios')" = 0 ]

echo "== 1. runs at 0212 on an EMPTY studios table: 26 rows of zeros? (ordinals 1 and 7 absent => no rows)"
n=$($P --csv -f $SQL | tail -n +2 | wc -l); echo "rows with no studios: $n"; [ "$n" = 0 ]

echo "== 2. seed: ordinal 1 live attempt with no account id, ordinal 7 attempt naming another account"
$P -q -f seed.sql >/dev/null
$P --csv -f $SQL | python3 prove.py dirty

echo "== 3. clean: remove the offending rows; every without/unbound count is 0"
$P -q -f clean.sql
$P --csv -f $SQL | python3 prove.py clean

echo "== 4. refuses at another history (0213 present): chain guard raises"
$P -q -c "insert into supabase_migrations.schema_migrations (version) values ('0213')"
if out=$($P --csv -f $SQL 2>&1); then echo "NOT REFUSED"; echo "$out"; exit 1; fi
echo "$out" | grep -q "division by zero" && echo "refused: division by zero"
$P -q -c "delete from supabase_migrations.schema_migrations where version = '0213'"
$P --csv -f $SQL | python3 prove.py clean

echo "== 5. runner copy: byte-identical, accepts with this manifest, refuses with the main manifest"
sha() { sha256sum "$1" | cut -d' ' -f1; }
[ "$(sha obs/run-window-read-macos.sh)" = 471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357 ]
cmp obs/run-window-read-macos.sh main/run-window-read-macos.sh
[ "$(sha main/MANIFEST.sha256)" = 2b1608a9ec43caf97bd9ead3fe1d10895652a080a4b8ae0a891a17be3038cd94 ]
[ "$(wc -l < obs/MANIFEST.sha256)" = 2 ]
echo "obs manifest: $(sha obs/MANIFEST.sha256)"
W=$(mktemp -d); mkdir -p "$W/linked/supabase/.temp"; cd "$W/linked"
run() { env -i PATH="$PATH" bash "$1/run-window-read-macos.sh" obs-0214-live-named-accounts.sql 2>&1 || true; }
A=$(mktemp -d); cp "$OLDPWD"/obs/* "$A"/
out=$(run "$A"); echo "this manifest: $out"; echo "$out" | grep -q "HONE_WINDOW_PROJECT_REF is not set"   # past the manifest and the lexical gate
B=$(mktemp -d); cp "$OLDPWD"/obs/run-window-read-macos.sh "$OLDPWD"/obs/obs-0214-live-named-accounts.sql "$OLDPWD"/obs/obs-0214-observed-post-s3.sql "$B"/; cp "$OLDPWD"/main/MANIFEST.sha256 "$B"/
out=$(run "$B"); echo "main manifest: $out"; echo "$out" | grep -q "is not listed in MANIFEST.sha256"
C=$(mktemp -d); cp "$OLDPWD"/obs/* "$C"/; echo "-- edited" >> "$C/obs-0214-live-named-accounts.sql"
out=$(run "$C"); echo "edited sql: $out"; echo "$out" | grep -q "does not match MANIFEST.sha256"
D=$(mktemp -d); cp "$OLDPWD"/main/* "$D"/; cp "$OLDPWD"/obs/obs-0214-live-named-accounts.sql "$D"/
out=$(run "$D"); echo "main runner dir: $out"; echo "$out" | grep -q "is not listed in MANIFEST.sha256"
echo "== 6. the post-S3 file refuses at 0212 (its guard is 0246), and the runner accepts it with this manifest"
if out=$($P --csv -f obs/obs-0214-observed-post-s3.sql 2>&1); then echo "NOT REFUSED"; exit 1; fi
echo "$out" | grep -q "division by zero" && echo "post-S3 file refused at 0212: division by zero"
cd "$W/linked"
out=$(env -i PATH="$PATH" bash "$A/run-window-read-macos.sh" obs-0214-observed-post-s3.sql 2>&1 || true); echo "post file, this manifest: $out"
echo "$out" | grep -q "HONE_WINDOW_PROJECT_REF is not set"
out=$(env -i PATH="$PATH" bash "$B/run-window-read-macos.sh" obs-0214-observed-post-s3.sql 2>&1 || true); echo "post file, main manifest: $out"
echo "$out" | grep -q "is not listed in MANIFEST.sha256"
echo "OBS-READ-PREP PROOF (0212): ALL PASS"
