#!/usr/bin/env python3
"""REHEARSAL - NEVER MERGE. A local FAKE Supabase Management API that RECORDS every request (Insurance H6). usage: fake-mgmt-api.py PORT STUBDIR LOGFILE
Answers only: GET /v1/projects/<ref>, GET /v1/projects/<ref>/database/backups, POST /v1/projects/<ref>/database/query/read-only (a non-SELECT is refused 400 like the
provider's read-only endpoint). EVERYTHING else is answered 404 and logged, so a test can assert that nothing else was ever asked. The log holds method, path, the JSON
body's key names and its query text, and whether the bearer token equalled the expected canary (never the token). Canned answers come from stub files in STUBDIR."""
import json, os, re, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
PORT, D, LOG = int(sys.argv[1]), sys.argv[2], sys.argv[3]
OLD = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 4000))   # fixed for the life of the server: postmaster start / archiver stats are stable across samples
def rd(n, default):
    try: return open(os.path.join(D, n)).read().strip()
    except OSError: return default
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _rec(self, body):
        exp = rd("canary-pat", "")
        auth = self.headers.get("Authorization", "")
        rec = {"method": self.command, "path": self.path, "auth": "match" if exp and auth == "Bearer " + exp else "NO-MATCH",
               "body_keys": sorted(body.keys()) if isinstance(body, dict) else None, "query": body.get("query") if isinstance(body, dict) else None,
               "ua": self.headers.get("User-Agent", ""), "t": time.strftime("%H:%M:%S")}
        with open(LOG, "a") as f: f.write(json.dumps(rec) + "\n")
    def _send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def _redir(self):
        self.send_response(302); self.send_header("Location", "http://127.0.0.1:%d/v1/projects/redirected/database/backups" % PORT); self.send_header("Content-Length", "0"); self.end_headers()
    def do_GET(self):
        self._rec(None)
        if rd("stub-mode", "ok") == "redirect": return self._redir()
        if re.fullmatch(r"/v1/projects/[a-z0-9-]+", self.path): return self._send(200, {"id": "x", "status": "ACTIVE_HEALTHY"})
        if re.fullmatch(r"/v1/projects/[a-z0-9-]+/database/backups", self.path):
            pitr = rd("stub-pitr", "true") == "true"; days = int(rd("stub-span-days", "7")); age = int(rd("stub-latest-age", "30")); now = int(time.time())
            return self._send(200, {"region": "stub", "walg_enabled": True, "pitr_enabled": pitr, "backups": [{"id": 1, "status": "COMPLETED", "is_physical_backup": True, "inserted_at": "x"}],
                                    "physical_backup_data": {"earliest_physical_backup_date_unix": now - days * 86400, "latest_physical_backup_date_unix": now - age}})
        self._send(404, {"message": "not found"})
    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0")); raw = self.rfile.read(n).decode() if n else ""
        try: body = json.loads(raw)
        except ValueError: body = {"_unparsed": True}
        self._rec(body)
        if rd("stub-mode", "ok") == "redirect": return self._redir()
        if not re.fullmatch(r"/v1/projects/[a-z0-9-]+/database/query/read-only", self.path): return self._send(404, {"message": "not found"})
        if rd("stub-mode", "ok") == "qfail": return self._send(500, {"message": "stub failure"})
        q = body.get("query", "") if isinstance(body, dict) else ""
        if not re.match(r"^\s*(select|with)\b", re.sub(r"--[^\n]*", " ", q), re.I): return self._send(400, {"message": "read-only endpoint refuses a non-SELECT"})
        import hashlib
        af = os.path.join(D, "stub-answers", hashlib.sha256(q.strip().encode()).hexdigest())
        if os.path.exists(af): return self._send(201, json.load(open(af)))
        if "as n, coalesce(max(version)" in q:
            h = rd("stub-hist", "211 0212").split(); return self._send(201, [{"n": int(h[0]), "mx": h[1]}])
        if "count(*)::int as c from supabase_migrations" in q: return self._send(201, [{"c": int(rd("stub-rangec", "34"))}])
        if "as busy from pg_catalog.pg_stat_activity" in q: return self._send(201, [{"busy": int(rd("stub-busy", "0"))}])
        if "select 'stage-check'" in q: return self._send(201, json.loads(rd("stub-check-json", '[{"x":1}]')))
        if "pg_walfile_name_offset" in q:   # the Insurance-approved pitr-wal-status.sql: ONE row, 24 columns
            now = time.gmtime(); iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", t); old = OLD
            cur = "000000010000000000000005"; last = "000000010000000000000003" if os.path.exists(os.path.join(D, "stub-wal-lag")) else cur
            lsn = "0/5000100"
            if os.path.exists(os.path.join(D, "stub-lsn-move")):   # simulate WAL activity: the position moves on every call
                n = int(rd("stub-lsn-n", "0")) + 1; open(os.path.join(D, "stub-lsn-n"), "w").write(str(n)); lsn = "0/5%06X" % (0x100 + n)
            return self._send(201, [{"db_now_utc": iso(now), "postmaster_start_utc": old, "in_recovery": False, "lsn_write": lsn, "lsn_insert": lsn, "lsn_flush": lsn, "cur_wal_file": cur, "cur_wal_offset": "256", "archived_count": 5, "last_archived_wal": last,
                                    "last_archived_utc": old, "failed_count": 0, "last_failed_wal": None, "last_failed_utc": None, "archiver_stats_reset_utc": old, "archive_mode": rd("stub-archive-mode", "on"), "archive_timeout_s": int(rd("stub-archive-timeout", "1")),
                                    "wal_level": "replica", "checkpoint_timeout": "5min", "wal_segment_size": "16MB", "wal_segment_size_bytes": 16777216, "next_xid": "1000", "xact_commit": 10, "xact_rollback": 0}])
        if "pg_stat_user_tables" in q:
            w = int(rd("stub-writes", "100"))
            if os.path.exists(os.path.join(D, "stub-active")):
                w += 1; open(os.path.join(D, "stub-writes"), "w").write(str(w))
            return self._send(201, [{"writes": str(w)}])
        if "schema_migrations" in q: return self._send(201, [{"version": v} for v in rd("stub-recon", "").split()])
        self._send(201, [])
    def do_PUT(self): self._rec(None); self._send(405, {})
    do_DELETE = do_PATCH = do_PUT
HTTPServer(("127.0.0.1", PORT), H).serve_forever()
