#!/usr/bin/env python3
"""REHEARSAL - NEVER MERGE. A stand-in Management API on 127.0.0.1:8081 for the restore-point endpoints only.
usage: stub-rp-api.py <mode-file> <log-file>. The mode file holds one word, read on EVERY request:
  ok | failed | pending | post500 | othername | early
Every request is logged as "METHOD PATH auth=yes|no body=<body>" (never the Authorization value)."""
import http.server, json, sys, time, urllib.parse
modef, log = sys.argv[1], sys.argv[2]
gets = {}
def now_iso(off=0): return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() + off))
class H(http.server.BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def _rec(self, body=""):
        auth = self.headers.get("Authorization", "").startswith("Bearer sbp_")
        open(log, "a").write("%s %s auth=%s body=%s\n" % (self.command, self.path, "yes" if auth else "no", body)); return auth
    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0")); body = self.rfile.read(n).decode()
        auth = self._rec(body); mode = open(modef).read().strip()
        if not auth: return self._send(401, {"message": "Unauthorized"})
        try: name = json.loads(body)["name"]
        except Exception: return self._send(400, {"message": "bad body"})
        if len(name) > 20: return self._send(400, {"message": "name too long"})
        if self.path != "/v1/projects/alhhybgqdmcdyzpybykj/database/backups/restore-point": return self._send(404, {})
        if mode == "post500": return self._send(500, {"message": "boom"})
        gets[name] = 0
        self._send(201, {"name": "other" if mode == "othername" else name, "status": "PENDING", "completed_on": None})
    def do_GET(self):
        auth = self._rec(); mode = open(modef).read().strip()
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if not auth: return self._send(401, {"message": "Unauthorized"})
        if u.path != "/v1/projects/alhhybgqdmcdyzpybykj/database/backups/restore-point": return self._send(404, {})
        name = (q.get("name") or [""])[0]; gets[name] = gets.get(name, 0) + 1
        if mode == "pending": return self._send(200, {"name": name, "status": "PENDING", "completed_on": None})
        if mode == "failed": return self._send(200, {"name": name, "status": "FAILED", "completed_on": None})
        if gets[name] < 3: return self._send(200, {"name": name, "status": "PENDING", "completed_on": None})
        self._send(200, {"name": name, "status": "AVAILABLE", "completed_on": now_iso(-7200 if mode == "early" else -1)})
    def do_PUT(self): self._rec(); self._send(404, {})
    do_DELETE = do_PATCH = do_PUT
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", 8081), H).serve_forever()
