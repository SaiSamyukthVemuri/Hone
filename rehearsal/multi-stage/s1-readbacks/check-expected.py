# S1 read-back expectations on the rehearsal stack (REHEARSAL, never merge). Input: the three result JSON files the
# s1-*.sql read-backs wrote after 0258, 0272 and 0266 were applied to a fresh stack. Checks: history 252 rows / max 0272 /
# the three versions once; every function body md5 equals the md5 of the text between the sealed file's dollar quotes;
# the grants rules; every row count 0. Prints every definition md5 so they can be copied into the request (hashes only).
import json, re, hashlib, sys
args = sys.argv[1:]
expect_file = None
if "--expect" in args:   # a recorded EXPECTED.txt from the rehearsal stack: every informational line (definitions, md5s, config) must be identical
    i = args.index("--expect"); expect_file = args[i + 1]; del args[i:i + 2]
d, sealed = args[0], args[1:]
def rows(n): return json.load(open("%s/%s.json" % (d, n)))
bad = []
LINES = []
_print = print
def print(*a, **k):
    LINES.append(" ".join(str(x) for x in a)); _print(*a, **k)
def need(c, m):
    print(("ok   - " if c else "FAIL - ") + m)
    if not c: bad.append(m)
hist = {r["item"]: r["value"] for r in rows("s1-1-history")}
need(hist["total rows"] == "252" and hist["highest version"] == "0272" and hist["present of 0258, 0266, 0272"] == "3" and hist["rows with a duplicate version"] == "0", "history: 252 rows, max 0272, the three present once, no duplicate (%s)" % json.dumps(hist, sort_keys=True))
want = {}
for f in sealed:
    s = open(f).read()
    for m in re.finditer(r"create (?:or replace )?function public\.(\w+)\s*\((.*?)\)(?:(?!\n\$).)*?\n\s*as\s+(\$\w*\$)(.*?)\3", s, re.S | re.I):
        want[m.group(1)] = hashlib.md5(m.group(4).encode()).hexdigest()   # later file wins (0272 over 0258)
fn = {r["sig"].split("(")[0].replace("public.", ""): r for r in rows("s1-3-functions")}
for name, r in sorted(fn.items()):
    if name in want:
        need(r["fn_exists"] and r["body_md5"] == want[name], "function %s body md5 %s equals the sealed text %s" % (name, r["body_md5"], want[name]))
    print("     %s definer=%s volatility=%s config=%s public=%s anon=%s authenticated=%s service_role=%s" % (name, r["security_definer"], r["volatility"], r["config"], r["public_can_execute"], r["anon_can_execute"], r["authenticated_can_execute"], r["service_role_can_execute"]))
auth_only = ["can_use_client_legal_identity", "can_read_client_legal_identity", "set_receptionist_legal_name_access", "receptionist_client_contacts_v2", "receptionist_calendar"]
nobody = ["client_legal_identities_guard", "client_legal_name_access_audit_immutable", "receptionist_client_contacts"]
for n in auth_only:
    r = fn[n]; need(r["authenticated_can_execute"] and not (r["public_can_execute"] or r["anon_can_execute"] or r["service_role_can_execute"]), "%s: authenticated only" % n)
for n in nobody:
    r = fn[n]; need(not (r["authenticated_can_execute"] or r["public_can_execute"] or r["anon_can_execute"] or r["service_role_can_execute"]), "%s: executable by nobody but the owner" % n)
objs = {r["item"]: r["value"] for r in rows("s1-2-post-objects")}
for k, v in sorted(objs.items()):
    if k.startswith(("policy ", "trigger ", "foreign key ", "index ", "constraint ")): print("     %s = %s" % (k, v))
for k, v in objs.items():
    if "(must be 0)" in k: need(v == "0", "%s = %s" % (k, v))
need(not any(k.startswith("sequence privilege") and ("anon" in k or "authenticated" in k or "service_role" in k or "PUBLIC" in k) for k in objs), "audit sequence: no privilege for PUBLIC, anon, authenticated or service_role")
need(objs.get("constraint clients_preferred_name_shape") == "validated=true", "clients_preferred_name_shape validated")
if expect_file:
    import io, contextlib
    want = [l.rstrip("\n") for l in open(expect_file) if l.startswith("     ")]
    got = [l for l in LINES if l.startswith("     ")]
    need(sorted(want) == sorted(got), "every definition line (policy/trigger/foreign key/index md5s, function definer/volatility/config/grants) is identical to the recorded rehearsal values (%d lines)" % len(want))
    for l in sorted(set(want) - set(got)): print("     MISSING " + l.strip())
    for l in sorted(set(got) - set(want)): print("     UNEXPECTED " + l.strip())
sys.exit(1 if bad else 0)
