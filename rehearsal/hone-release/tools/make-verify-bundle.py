#!/usr/bin/env python3
"""REHEARSAL - NEVER MERGE. Verify-bundle authoring tool (HON66-OPENS 2).
From the APPROVED migration files of one stage it derives the governed-object / ACL expectations that the `verify` action can check, and builds verify.tar
reproducibly (sorted names, mtime 0, uid/gid 0, mode 0644, ustar): the same files give the same verify_sha. OPS reviews review.md; nothing here talks to a database.

usage: make-verify-bundle.py --migrations DIR --first 0247 --last 0250 --out DIR [--capture FILE.json]
  --capture   JSON {"<check id>": [rows...]} read from a REFERENCE database that already holds the stage (a disposable CI database, never production). Checks whose
              expectation cannot be derived from the SQL text (function bodies, sequence of columns) are written to needs-reference/ and are added to the bundle only
              when a capture supplies their rows.
Derived from the text, per statement (dollar-quoted bodies are not parsed): CREATE FUNCTION / TABLE, ALTER TABLE ... ENABLE ROW LEVEL SECURITY, GRANT/REVOKE on a
function (EXECUTE) or a table. Everything else is LISTED in review.md as not covered. Final state per (object, role): the last GRANT/REVOKE wins.
"""
import argparse, hashlib, io, json, os, re, sys, tarfile

def strip_comments(t):
    t = re.sub(r"/\*.*?\*/", " ", t, flags=re.S)
    return re.sub(r"--[^\n]*", " ", t)

def split_statements(t):
    out, cur, i, n = [], [], 0, len(t)
    while i < n:
        c = t[i]
        m = re.match(r"\$([A-Za-z_]*)\$", t[i:]) if c == "$" else None
        if m:
            tag = m.group(0); j = t.find(tag, i + len(tag)); j = n if j < 0 else j + len(tag)
            cur.append(t[i:j]); i = j; continue
        if c == "'":
            j = i + 1
            while j < n:
                if t[j] == "'" and j + 1 < n and t[j + 1] == "'": j += 2; continue
                if t[j] == "'": break
                j += 1
            cur.append(t[i:j + 1]); i = j + 1; continue
        if c == ";":
            s = "".join(cur).strip()
            if s: out.append(s)
            cur = []; i += 1; continue
        cur.append(c); i += 1
    s = "".join(cur).strip()
    if s: out.append(s)
    return out

def split_top(s, sep=","):
    parts, depth, cur = [], 0, []
    for ch in s:
        if ch == "(": depth += 1
        if ch == ")": depth -= 1
        if ch == sep and depth == 0: parts.append("".join(cur).strip()); cur = []
        else: cur.append(ch)
    if "".join(cur).strip(): parts.append("".join(cur).strip())
    return parts

def qname(x, default="public"):
    x = x.strip().replace('"', "")
    return tuple(x.split(".", 1)) if "." in x else (default, x)

def arg_types(argstr):
    types = []
    for a in split_top(argstr):
        a = re.split(r"\s+default\s+|\s*=\s*", a, flags=re.I)[0].strip()
        toks = a.split()
        if toks and toks[0].lower() in ("in", "out", "inout", "variadic"): toks = toks[1:]
        if len(toks) >= 2 and not re.match(r"^(double|character|timestamp|time|bit|national)$", toks[0], re.I) and not toks[1].startswith(("(", "[")) and toks[1].lower() not in ("precision", "varying", "with", "without"): toks = toks[1:]
        types.append(" ".join(toks))
    return types

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--migrations", required=True); ap.add_argument("--first", required=True); ap.add_argument("--last", required=True); ap.add_argument("--out", required=True); ap.add_argument("--capture")
    a = ap.parse_args()
    names = sorted(f for f in os.listdir(a.migrations) if re.match(r"^\d{4}_.*\.sql$", f) and a.first <= f[:4] <= a.last)
    if not names: sys.exit("no migration files in range")
    funcs, tables, rls, acl, uncovered, files = {}, set(), set(), {}, {}, []
    for nme in names:
        raw = open(os.path.join(a.migrations, nme), encoding="utf-8").read(); files.append((nme, hashlib.sha256(raw.encode()).hexdigest()))
        for st in split_statements(strip_comments(raw)):
            low = " ".join(st.split()).lower()
            m = re.match(r"create (?:or replace )?function ([\w\".]+)\s*\((.*?)\)\s*(?:returns|language|as|security|set|stable|volatile|immutable)", " ".join(st.split()), re.I | re.S)
            if m: funcs[qname(m.group(1))] = arg_types(m.group(2)); continue
            m = re.match(r"create (?:unlogged )?table (?:if not exists )?([\w\".]+)", low)
            if m: tables.add(qname(m.group(1))); continue
            m = re.match(r"alter table (?:only )?(?:if exists )?([\w\".]+) (?:enable|force) row level security", low)
            if m: rls.add(qname(m.group(1))); continue
            m = re.match(r"(grant|revoke) ([\w, ]+?) on function ([\w\".]+)\s*\((.*?)\)\s*(?:to|from) ([\w\", ]+?)(?: with grant option)?$", " ".join(st.split()), re.I)
            if m:
                gr, fn, args, roles = m.group(1).lower() == "grant", qname(m.group(3)), arg_types(m.group(4)), [r.strip().strip('"').lower() for r in m.group(5).split(",")]
                for r in roles: acl[("function", fn, tuple(args), r)] = gr
                continue
            m = re.match(r"(grant|revoke) ([\w, ]+?) on (?:table )?([\w\".]+) (?:to|from) ([\w\", ]+?)$", " ".join(st.split()), re.I)
            if m and not re.match(r"(all functions|all tables|schema|sequence|all sequences)", m.group(3), re.I):
                gr = m.group(1).lower() == "grant"; privs = [p.strip().lower() for p in m.group(2).split(",")]
                for r in [r.strip().strip('"').lower() for r in m.group(4).split(",")]:
                    for p in privs:
                        if p == "all" or p == "all privileges": p = "select"   # coarse: ALL is checked through SELECT only; listed below
                        acl[("table", qname(m.group(3)), p, r)] = gr
                continue
            k = " ".join(low.split()[:3]); uncovered[k] = uncovered.get(k, 0) + 1
    checks, needs = [], []
    def lit(s): return "'" + s.replace("'", "''") + "'"
    if funcs:
        vals = ", ".join("(%s, %s)" % (lit(s), lit(f)) for (s, f) in sorted(funcs))
        checks.append(("functions-exist", "every function the stage creates exists", "select count(*)::int as n from (values %s) v(s, f) where exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = v.s and p.proname = v.f)" % vals, [{"n": len(funcs)}]))
        needs.append(("function-bodies", "md5 of each function's source (needs a reference database)", "select p.proname, md5(p.prosrc) as md5 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where (n.nspname, p.proname) in (%s) order by p.proname, md5(p.prosrc)" % ", ".join("(%s, %s)" % (lit(s), lit(f)) for (s, f) in sorted(funcs))))
    if tables:
        vals = ", ".join("(%s)" % lit("%s.%s" % t) for t in sorted(tables))
        checks.append(("tables-exist", "every table the stage creates exists", "select count(*)::int as n from (values %s) v(r) where to_regclass(v.r) is not null" % vals, [{"n": len(tables)}]))
    if rls:
        arr = ", ".join("to_regclass(%s)" % lit("%s.%s" % t) for t in sorted(rls))
        checks.append(("rls-enabled", "row level security is enabled on every table the stage enables it on", "select count(*)::int as n from pg_catalog.pg_class c where c.oid = any (array[%s]) and c.relrowsecurity" % arr, [{"n": len(rls)}]))
    fa = sorted((k for k in acl if k[0] == "function"), key=lambda k: (k[1], k[2], k[3]))
    if fa:
        vals = ", ".join("(%s, %s)" % (lit("%s.%s(%s)" % (k[1][0], k[1][1], ",".join(k[2]))), lit(k[3])) for k in fa)
        rows = sorted(({"fn": "%s.%s(%s)" % (k[1][0], k[1][1], ",".join(k[2])), "r": k[3], "ok": acl[k]} for k in fa), key=lambda r: (r["fn"], r["r"]))
        checks.append(("function-acl", "final EXECUTE privilege per (function, role): the last GRANT/REVOKE in the stage wins", "select v.fn, v.r, has_function_privilege(v.r, v.fn, 'EXECUTE') as ok from (values %s) v(fn, r) order by 1, 2" % vals, rows))
    ta = sorted((k for k in acl if k[0] == "table"), key=lambda k: (k[1], k[2], k[3]))
    if ta:
        vals = ", ".join("(%s, %s, %s)" % (lit("%s.%s" % k[1]), lit(k[3]), lit(k[2])) for k in ta)
        rows = sorted(({"t": "%s.%s" % k[1], "r": k[3], "p": k[2], "ok": acl[k]} for k in ta), key=lambda r: (r["t"], r["r"], r["p"]))
        checks.append(("table-acl", "final table privilege per (table, role, privilege)", "select v.t, v.r, v.p, has_table_privilege(v.r, v.t, v.p) as ok from (values %s) v(t, r, p) order by 1, 2, 3" % vals, rows))
    cap = json.load(open(a.capture)) if a.capture else {}
    for cid, what, sql in needs:
        if cid in cap: checks.append((cid, what + " (expectation CAPTURED from a reference database)", sql, cap[cid]))
    os.makedirs(a.out, exist_ok=True); os.makedirs(os.path.join(a.out, "needs-reference"), exist_ok=True); os.makedirs(os.path.join(a.out, "expected"), exist_ok=True)
    members, lst = {}, []
    for i, (cid, what, sql, rows) in enumerate(checks, 1):
        fn = "c%02d_%s.sql" % (i, cid); body = (sql + "\n").encode(); members[fn] = body
        exp = hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        lst.append("%s\t%s\t%s\t%s" % (cid, fn, hashlib.sha256(body).hexdigest(), exp)); open(os.path.join(a.out, "expected", fn + ".json"), "w").write(json.dumps(rows, sort_keys=True, indent=1) + "\n")
    for cid, what, sql in needs:
        if cid not in cap: open(os.path.join(a.out, "needs-reference", cid + ".sql"), "w").write(sql + "\n")
    members["checks.list"] = ("\n".join(lst) + "\n").encode()
    for fn, b in members.items(): open(os.path.join(a.out, fn), "wb").write(b)
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as t:
        for fn in sorted(members):
            ti = tarfile.TarInfo(fn); ti.size = len(members[fn]); ti.mtime = 0; ti.mode = 0o644; ti.uid = ti.gid = 0; ti.uname = ti.gname = ""; t.addfile(ti, io.BytesIO(members[fn]))
    open(os.path.join(a.out, "verify.tar"), "wb").write(buf.getvalue()); vs = hashlib.sha256(buf.getvalue()).hexdigest(); open(os.path.join(a.out, "verify_sha.txt"), "w").write(vs + "\n")
    rv = ["# Verify bundle for migrations %s-%s: derived expectations to REVIEW" % (a.first, a.last), "", "verify_sha (sha256 of verify.tar): `%s` (reproducible: the same files give the same sha)" % vs, "", "Source files (sha256):", ""]
    rv += ["- `%s` %s" % f for f in files]
    rv += ["", "## Checks in the bundle", "", "| id | what | expectation |", "|---|---|---|"]
    for cid, what, sql, rows in checks: rv.append("| %s | %s | %d row(s): `%s` |" % (cid, what, len(rows), json.dumps(rows, sort_keys=True)[:300].replace("|", "/")))
    rv += ["", "## Needs a reference database (NOT in the bundle unless --capture supplied them)", ""] + (["- `%s`: %s" % (c, w) for c, w, s in needs if c not in cap] or ["- none"])
    rv += ["", "## NOT covered (statement kinds the tool did not derive a check from; count)", ""] + (["- `%s`: %d" % (k, v) for k, v in sorted(uncovered.items())] or ["- none"])
    rv += ["", "OPS: confirm each expectation against the intent of the stage, and decide whether the not-covered kinds need a hand-written check before approving `verify_sha`."]
    open(os.path.join(a.out, "review.md"), "w").write("\n".join(rv) + "\n")
    print("verify_sha=%s checks=%d needs_reference=%d" % (vs, len(checks), len([1 for c, w, s in needs if c not in cap])))

main()
