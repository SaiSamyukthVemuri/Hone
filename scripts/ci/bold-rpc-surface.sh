#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. BOLD-FULL-COMPAT: the database-command surface B-OLD (production 7610fd70) calls,
# compared between a SYNTHETIC database at production's prefix 0212 and the same database at 0246. For every
# `.rpc(<name>, {args})` call site: does a function of that name exist whose parameters accept exactly those
# argument names (PostgREST named-argument resolution), and may the role the call goes through (service_role
# for createAdminClient, authenticated for the cookie client) EXECUTE it? NOT a copy of production data.
set -u
OUT="${REHEARSAL_OUT:?}"
DB="${DB:?}"
mkdir -p "$OUT"
RES="$OUT/results.txt"; : > "$RES"
say() { echo "$*" | tee -a "$RES"; }
CLI="npx --yes supabase@2.102.0"
python3 scripts/ci/bold-rpc-extract.py "$OUT/sites.json" | tee -a "$RES"
NAMES="$(python3 -c "import json;print(','.join(sorted({s['rpc'] for s in json.load(open('$OUT/sites.json'))})))")"
snap() { # snap <label>
  python3 - "$NAMES" > "$OUT/names.sql" <<'PY'
import sys
print(",".join("'%s'" % n for n in sys.argv[1].split(",")))
PY
  docker exec -i "$DB" psql -U supabase_admin -d postgres -X -q -A -t -v ON_ERROR_STOP=1 -c "
select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
  select p.proname, pg_get_function_identity_arguments(p.oid) as identity_args,
         p.proargnames, p.proargmodes, p.pronargs, p.pronargdefaults,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
         has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ($(cat "$OUT/names.sql"))
) t" > "$OUT/functions-$1.json"
  say "snapshot $1: $(python3 -c "import json;print(len(json.load(open('$OUT/functions-$1.json'))))") function rows; max migration $(docker exec -i "$DB" psql -U postgres -X -q -A -t -c 'select max(version) from supabase_migrations.schema_migrations')"
}
say "== database at production's prefix 0212"
$CLI db reset --local --version 0212 --yes > "$OUT/reset-0212.log" 2>&1 || { tail -n 5 "$OUT/reset-0212.log"; say "WARN reset 0212 reported failure"; }
for _ in $(seq 1 30); do docker exec -i "$DB" psql -U postgres -X -q -c "select 1" > /dev/null 2>&1 && break; sleep 2; done
snap 0212
say "== database at 0246 (the full chain)"
$CLI db reset --local --yes > "$OUT/reset-0246.log" 2>&1 || { tail -n 5 "$OUT/reset-0246.log"; say "WARN reset 0246 reported failure"; }
for _ in $(seq 1 30); do docker exec -i "$DB" psql -U postgres -X -q -c "select 1" > /dev/null 2>&1 && break; sleep 2; done
snap 0246
python3 - "$OUT" <<'PY' | tee -a "$RES"
import json, sys, collections
out = sys.argv[1]
sites = json.load(open(f"{out}/sites.json"))
fn = {l: json.load(open(f"{out}/functions-{l}.json")) for l in ("0212", "0246")}

def inputs(f):
    names, modes = f["proargnames"], f["proargmodes"]
    if names is None:
        return [], []
    idx = [i for i in range(len(names)) if modes is None or modes[i] in ("i", "b", "v")]
    ins = [names[i] for i in idx]
    ndef = f["pronargdefaults"] or 0
    req = ins[: len(ins) - ndef] if ndef else ins
    return ins, req

def check(site, funcs):
    role = site["client"]
    cands = [f for f in funcs if f["proname"] == site["rpc"]]
    if not cands:
        return "missing"
    keys = set(site["args"])
    best = "args"
    for f in cands:
        ins, req = inputs(f)
        if not keys <= set(ins):
            continue
        if site["args_known"] and not set(req) <= keys:
            continue
        best = "ok"
        roles = [role] if role in ("authenticated", "service_role") else ["authenticated", "service_role"]
        if all(f[r] for r in roles) or (role == "unknown" and any(f[r] for r in roles)):
            return "ok"
        best = "privilege"
    return best

rows = []
for s in sites:
    a, b = check(s, fn["0212"]), check(s, fn["0246"])
    rows.append((s, a, b))
c = collections.Counter((a, b) for _, a, b in rows)
print(f"== RESULT: {len(rows)} call sites; (state at 0212, state at 0246): {dict(c)}")
broke = [(s, a, b) for s, a, b in rows if b != "ok"]
by = collections.OrderedDict()
for s, a, b in broke:
    by.setdefault((s["rpc"], s["client"], a, b), []).append(s["file"])
print(f"== call sites whose command does not work on 0246: {len(broke)} ({len(by)} distinct command/client)")
for (rpc, cl, a, b), files in by.items():
    print(f"BROKEN-ON-0246 {rpc} via {cl}: at0212={a} at0246={b} files={sorted(set(files))}")
PY
say "# done"
