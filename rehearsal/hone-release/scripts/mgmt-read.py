#!/usr/bin/env python3
# hone-release helper: mgmt-read.py. THE ONE pinned way any hone-release action reads the hosted project (Insurance FX1). Run only by the actions' `mgmt` function after it
# has checked this file's sha256 against the root-owned manifest. usage: mgmt-read.py <project-ref> <id> [args]   token in the environment variable HONE_READ_TOKEN only.
# It speaks to EXACTLY two Management API endpoints: GET /v1/projects/<ref>/database/backups and POST /v1/projects/<ref>/database/query/read-only (the provider's
# server-side read-only endpoint). The SQL is a FIXED catalogue below (parameters are validated digits); the only free SQL is a file of an APPROVED verify bundle
# (`file`), which must pass the lexical read-only gate here. It never uses the supabase CLI, never dials a database host, never needs a database password, and has no
# code path to the CLI login-role or network-ban endpoints or to any write endpoint. Exit: 0 ok, 1 provider/network failure, 2 usage, 3 lexical gate refusal.
import json, os, re, sys, urllib.request, urllib.error
BASE = "https://api.supabase.com"
CATALOGUE = {
    "history": "select count(*)::int as n, coalesce(max(version), '') as mx from supabase_migrations.schema_migrations",
    "busy": "select count(*)::int as busy from pg_catalog.pg_stat_activity where backend_type = 'client backend' and pid <> pg_catalog.pg_backend_pid() and state <> 'idle' and datname = pg_catalog.current_database()",
    "writes": "select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::text as writes from pg_catalog.pg_stat_user_tables",
}
RANGED = {
    "range": "select count(*)::int as c from supabase_migrations.schema_migrations where version >= '%s' and version <= '%s'",
    "versions": "select version from supabase_migrations.schema_migrations where version >= '%s' and version <= '%s' order by version",
}
PITR_SQL = "pitr-wal-status.sql"   # Machines/Insurance-approved file (PEER-PITR-WAL-END), byte-identical, sha256-pinned here and in the root manifest
PITR_SQL_SHA256 = "c91d7a497ce3b04b88aedd72c8b2729694b65c3c5cc2f051837e3f2365ad8cd5"
BAD = r"\b(insert|update|delete|alter|create|drop|grant|revoke|truncate|copy|call|do|set|lock|vacuum|analyze|comment|reindex|refresh|listen|notify|execute|prepare|reset|begin|commit|rollback|pg_sleep|pg_terminate_backend|pg_cancel_backend|set_config|lo_import|lo_export|dblink|pg_read_file|pg_ls_dir)\b"

def gate(text):
    body = re.sub(r"--[^\n]*", " ", text).strip().rstrip(";").strip()
    low = body.lower()
    scan = re.sub(r"'(?:[^']|'')*'", "''", low)   # string literals cannot run anything
    return bool(re.match(r"^(select|with)\b", low)) and ";" not in scan and not re.search(BAD, scan)

def main():
    a = sys.argv[1:]
    if len(a) < 2 or not re.fullmatch(r"[a-z0-9-]{10,20}", a[0]): sys.exit(2)
    ref, cid, rest = a[0], a[1], a[2:]
    h = {"Authorization": "Bearer " + os.environ.get("HONE_READ_TOKEN", ""), "User-Agent": "hone-release/1", "Accept": "application/json"}
    if cid == "backups" and not rest:
        req = urllib.request.Request("%s/v1/projects/%s/database/backups" % (BASE, ref), headers=h, method="GET")
    else:
        if cid in CATALOGUE and not rest: sql = CATALOGUE[cid]
        elif cid in RANGED and len(rest) == 2 and all(re.fullmatch(r"[0-9]{4}", x) for x in rest): sql = RANGED[cid] % tuple(rest)
        elif cid == "pitr-wal" and not rest:
            import hashlib
            raw = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), PITR_SQL), "rb").read()
            if hashlib.sha256(raw).hexdigest() != PITR_SQL_SHA256: sys.stderr.write("pitr-wal-status.sql is not the pinned bytes\n"); sys.exit(3)
            sql = raw.decode("utf-8")
        elif cid == "file" and len(rest) == 1:
            try: sql = open(rest[0], encoding="utf-8").read().strip()
            except OSError: sys.exit(2)
            if not gate(sql): sys.stderr.write("lexical read-only gate refused the SQL file\n"); sys.exit(3)
        else: sys.exit(2)
        h["Content-Type"] = "application/json"
        req = urllib.request.Request("%s/v1/projects/%s/database/query/read-only" % (BASE, ref), data=json.dumps({"query": sql}).encode(), headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            if r.status not in (200, 201): sys.exit(1)
            sys.stdout.write(r.read().decode())
    except urllib.error.HTTPError as e:
        sys.stderr.write("management API refused: HTTP %d\n" % e.code); sys.exit(1)
    except Exception as e:
        sys.stderr.write("management API unreachable: %s\n" % type(e).__name__); sys.exit(1)

main()
