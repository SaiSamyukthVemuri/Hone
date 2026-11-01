# S2 (0274) read-back comparator. Input: the three result JSON files s2-1-history, s2-2-grants and s2-3-functions wrote AFTER 0274
# was applied, then the sealed 0274 file and the sealed S1 files. No connection. Exact SET EQUALITY on grants (Insurance F-1(a)):
# a missing expected privilege row and an unexpected extra one both fail. Hashes and flags only.
import json, re, hashlib, sys
d, s0274, s1files = sys.argv[1], sys.argv[2], sys.argv[3:]
def rows(n): return json.load(open("%s/%s.json" % (d, n)))
bad = []
def need(c, m):
    print(("ok   - " if c else "FAIL - ") + m)
    if not c: bad.append(m)
hist = {r["item"]: r["value"] for r in rows("s2-1-history")}
need(hist.get("total rows") == "253" and hist.get("highest version") == "0274" and hist.get("present of 0274") == "1" and hist.get("present of 0258, 0266, 0272") == "3" and hist.get("rows with a duplicate version") == "0",
     "history: 253 rows, max 0274, 0274 once, 0258/0266/0272 still present once each, no duplicate (%s)" % json.dumps(hist, sort_keys=True))
# table and sequence grants: EXACT sets
EXPECT_GRANTS = {
    "table privilege client_legal_identities authenticated": {"INSERT", "SELECT", "UPDATE"},
    "table privilege studio_legal_name_access authenticated": {"SELECT"},
    "table privilege client_legal_name_access_audit authenticated": {"SELECT"},
}
got = {}
objs = {}
for r in rows("s2-2-grants"):
    if r["item"].startswith(("table privilege ", "sequence privilege ")): got.setdefault(r["item"], set()).add(r["value"])
    else: objs[r["item"]] = r["value"]
for k in sorted(set(EXPECT_GRANTS) | set(got)):
    need(got.get(k, set()) == EXPECT_GRANTS.get(k, set()), "%s = %s (expected %s)" % (k, sorted(got.get(k, set())), sorted(EXPECT_GRANTS.get(k, set()))))
need(len(got) == len(EXPECT_GRANTS) and not any(("PUBLIC" in k or " anon" in k or "service_role" in k or k.startswith("sequence")) for k in got), "no privilege row for PUBLIC, anon or service_role on any table, and none on the audit sequence")
for k, v in objs.items():
    if "(must be 0)" in k: need(v == "0", "%s = %s" % (k, v))
# function bodies and grants
want = {}
for f in list(s1files) + [s0274]:
    s = open(f).read()
    for m in re.finditer(r"create (?:or replace )?function public\.(\w+)\s*\((.*?)\)(?:(?!\n\$).)*?\n\s*as\s+(\$\w*\$)(.*?)\3", s, re.S | re.I):
        want[m.group(1)] = hashlib.md5(m.group(4).encode()).hexdigest()
fn = {r["sig"].split("(")[0].replace("public.", ""): r for r in rows("s2-3-functions")}
auth_only = ["receptionist_client_directory", "receptionist_calendar_v2", "receptionist_studio_timezone", "can_use_client_legal_identity", "can_read_client_legal_identity", "set_receptionist_legal_name_access", "receptionist_client_contacts_v2"]
nobody = ["receptionist_calendar", "client_legal_identities_guard", "client_legal_name_access_audit_immutable", "receptionist_client_contacts"]
need(set(fn) == set(auth_only) | set(nobody), "the function list is exactly the expected eleven (%s)" % sorted(fn))
for n in sorted(fn):
    r = fn[n]
    if n in want:
        need(r["fn_exists"] and r["body_md5"] == want[n], "function %s body md5 %s equals the sealed text %s" % (n, r["body_md5"], want[n]))
    ex = r["authenticated_can_execute"]; others = r["public_can_execute"] or r["anon_can_execute"] or r["service_role_can_execute"]
    if n in auth_only: need(r["fn_exists"] and ex and not others, "%s: executable by authenticated only" % n)
    else: need(r["fn_exists"] and not ex and not others, "%s: executable by nobody but the owner" % n)
sys.exit(1 if bad else 0)
