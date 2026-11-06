#!/usr/bin/env python3
"""REHEARSAL - NEVER MERGE. A stand-in Management API on 127.0.0.1:8080 (the CLI's built-in supabase-local profile points there).
Serves GET /v1/projects/<ref>/database/backups from a JSON file and logs "METHOD PATH" (and whether an Authorization header was present,
never its value) for EVERY request. usage: stub-api.py <json-file> <log-file>"""
import http.server, sys
body = open(sys.argv[1], "rb").read(); log = sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def _rec(self):
        with open(log, "a") as f:
            f.write("%s %s auth=%s\n" % (self.command, self.path, "yes" if self.headers.get("Authorization", "").startswith("Bearer ") else "no"))
    def do_GET(self):
        self._rec()
        if self.path.endswith("/database/backups"):
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        else:
            self.send_response(404); self.end_headers()
    def do_POST(self): self._rec(); self.send_response(404); self.end_headers()
    do_PUT = do_PATCH = do_DELETE = do_POST
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", 8080), H).serve_forever()
