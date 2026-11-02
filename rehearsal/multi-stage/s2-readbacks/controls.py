# S2 comparator controls on SYNTHETIC result files (no connection): one good set passes, each mutation must turn it red.
import json, re, hashlib, os, subprocess, sys, tempfile, copy
here = os.path.dirname(os.path.abspath(__file__)); spec = os.path.join(here, "..", "spec")
s1 = [os.path.join(spec, p) for p in ("sealed/0258_hon58_identity.sql", "sealed-v2/0266_legal_name_receptionist_access.sql", "sealed-v2/0272_hon58_legal_identity_hardening.sql")]
f74 = os.path.join(spec, "sealed-v3/0274_receptionist_desk_projection.sql")
want = {}
for f in s1 + [f74]:
    for m in re.finditer(r"create (?:or replace )?function public\.(\w+)\s*\((.*?)\)(?:(?!\n\$).)*?\n\s*as\s+(\$\w*\$)(.*?)\3", open(f).read(), re.S | re.I):
        want[m.group(1)] = hashlib.md5(m.group(4).encode()).hexdigest()
AUTH = ["receptionist_client_directory", "receptionist_calendar_v2", "receptionist_studio_timezone", "can_use_client_legal_identity", "can_read_client_legal_identity", "set_receptionist_legal_name_access", "receptionist_client_contacts_v2"]
NOB = ["receptionist_calendar", "client_legal_identities_guard", "client_legal_name_access_audit_immutable", "receptionist_client_contacts"]
def good():
    h = [{"item": "total rows", "value": "253"}, {"item": "highest version", "value": "0274"}, {"item": "present of 0274", "value": "1"}, {"item": "present of 0258, 0266, 0272", "value": "3"}, {"item": "rows with a duplicate version", "value": "0"}]
    g = [{"item": "table privilege client_legal_identities authenticated", "value": v} for v in ("INSERT", "SELECT", "UPDATE")]
    g += [{"item": "table privilege %s authenticated" % t, "value": "SELECT"} for t in ("studio_legal_name_access", "client_legal_name_access_audit")]
    g += [{"item": "rows in %s (must be 0)" % t, "value": "0"} for t in ("client_legal_identities", "studio_legal_name_access", "client_legal_name_access_audit")] + [{"item": "clients with a preferred name (must be 0)", "value": "0"}]
    f = []
    for n in AUTH + NOB:
        f.append({"sig": "public.%s(x)" % n, "fn_exists": True, "body_md5": want.get(n, "-"), "public_can_execute": False, "anon_can_execute": False, "authenticated_can_execute": n in AUTH, "service_role_can_execute": False})
    return {"s2-1-history": h, "s2-2-grants": g, "s2-3-functions": f}
def run(data):
    with tempfile.TemporaryDirectory() as t:
        for k, v in data.items(): json.dump(v, open(os.path.join(t, k + ".json"), "w"))
        return subprocess.run([sys.executable, "-I", os.path.join(here, "check-expected-s2.py"), t, f74] + s1, capture_output=True, text=True).returncode
fail = 0
def expect(label, data, rc):
    global fail
    got = run(data); ok = (got == rc); fail += 0 if ok else 1
    print(("ok   - " if ok else "FAIL - ") + label + " (exit %d)" % got)
expect("good result set passes", good(), 0)
def mut(label, fn):
    d = copy.deepcopy(good()); fn(d); expect("MUTATION " + label + " fails", d, 1)
mut("extra authenticated DELETE on identities", lambda d: d["s2-2-grants"].append({"item": "table privilege client_legal_identities authenticated", "value": "DELETE"}))
mut("expected UPDATE revoked on identities", lambda d: d["s2-2-grants"].remove({"item": "table privilege client_legal_identities authenticated", "value": "UPDATE"}))
mut("anon SELECT on the switch table", lambda d: d["s2-2-grants"].append({"item": "table privilege studio_legal_name_access anon", "value": "SELECT"}))
mut("service_role SELECT on the audit table", lambda d: d["s2-2-grants"].append({"item": "table privilege client_legal_name_access_audit service_role", "value": "SELECT"}))
mut("PUBLIC privilege on the audit table", lambda d: d["s2-2-grants"].append({"item": "table privilege client_legal_name_access_audit PUBLIC", "value": "SELECT"}))
mut("audit sequence granted to authenticated", lambda d: d["s2-2-grants"].append({"item": "sequence privilege client_legal_name_access_audit_id_seq authenticated", "value": "USAGE"}))
mut("a switch row exists", lambda d: d["s2-2-grants"].__setitem__(6, {"item": "rows in studio_legal_name_access (must be 0)", "value": "1"}))
mut("receptionist_calendar still executable by authenticated", lambda d: [r.__setitem__("authenticated_can_execute", True) for r in d["s2-3-functions"] if r["sig"].startswith("public.receptionist_calendar(")])
mut("new directory function executable by anon", lambda d: [r.__setitem__("anon_can_execute", True) for r in d["s2-3-functions"] if "directory" in r["sig"]])
mut("timezone function body differs", lambda d: [r.__setitem__("body_md5", "0" * 32) for r in d["s2-3-functions"] if "timezone" in r["sig"]])
mut("history 252 (0274 not applied)", lambda d: d["s2-1-history"][0].__setitem__("value", "252"))
mut("a function is missing from the list", lambda d: d["s2-3-functions"].pop())
sys.exit(1 if fail else 0)
