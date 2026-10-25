# REHEARSAL - NEVER MERGE. BOLD-FULL-COMPAT: statically list every database command (.rpc) the B-OLD
# application calls, with the argument names it sends and the client it calls through. Heuristic:
# a variable named `admin` is createAdminClient() (service_role); `supabase` and the other names that
# are assigned from createClient() are the cookie client (authenticated). A call through a helper
# parameter, or with a non-literal argument object, is reported as unknown for that part.
import json, re, sys, os

ROOTS = ["app", "lib"]
call = re.compile(r'(\w+)\s*\.rpc\(\s*"([a-z0-9_]+)"\s*(?:,\s*)?', re.S)
out = []
for root in ROOTS:
    for d, _, files in os.walk(root):
        for f in files:
            if not f.endswith((".ts", ".tsx")):
                continue
            p = os.path.join(d, f)
            s = open(p, encoding="utf-8").read()
            for m in call.finditer(s):
                var, name = m.group(1), m.group(2)
                rest = s[m.end():]
                keys, known = [], False
                if rest.startswith("{"):
                    depth, i = 0, 0
                    for i, ch in enumerate(rest):
                        depth += ch == "{"
                        depth -= ch == "}"
                        if depth == 0:
                            break
                    body = rest[1:i]
                    # top-level keys only
                    lvl, cur = 0, ""
                    parts = []
                    for ch in body:
                        if ch in "{[(":
                            lvl += 1
                        elif ch in "}])":
                            lvl -= 1
                        if ch == "," and lvl == 0:
                            parts.append(cur); cur = ""
                        else:
                            cur += ch
                    parts.append(cur)
                    spread = False
                    for part in parts:
                        if part.strip().startswith("..."):
                            spread = True
                            continue
                        k = re.match(r'\s*(?://[^\n]*\n\s*)*(?:/\*.*?\*/\s*)*["\']?([A-Za-z0-9_]+)["\']?\s*(?::|,|$)', part, re.S)
                        if k and k.group(1):
                            keys.append(k.group(1))
                    known = not spread
                elif rest.startswith(")") or rest == "":
                    keys, known = [], True
                defs = re.findall(r'(?:const|let)\s+%s\s*=\s*(?:await\s+)?(\w+)\(' % re.escape(var), s)
                kind = "unknown"
                if defs:
                    kind = {"createClient": "authenticated", "createAdminClient": "service_role"}.get(defs[0], "unknown")
                elif var in ("admin",):
                    kind = "service_role"
                out.append({"file": p, "rpc": name, "client_var": var, "client": kind,
                            "args": sorted(set(keys)), "args_known": known})
json.dump(out, open(sys.argv[1], "w"), indent=1)
print(f"{len(out)} rpc call sites, {len({o['rpc'] for o in out})} distinct commands")
