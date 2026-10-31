#!/usr/bin/env python3
"""REHEARSAL - NEVER MERGE. PREPARATION ONLY / HELD.

MULTI-STAGE-BUILDER: turn an ORDERED list of migration files into one reviewed online stage package per step.

Step k applies exactly ONE migration. Its bundle is the hosted set plus steps 1..k (the bundle is the control). Every
per-step script is derived from the REVIEWED 0254-after-0257 online package (templates/, pinned below by sha256) by
declared exact-literal substitutions: each one is asserted to match the expected number of times, so a template that
drifted fails the build instead of producing a script nobody reviewed. No hosted call, no token, no database.

usage: build.py SPEC.json OUTDIR
"""
import hashlib, io, json, os, re, shutil, sys, tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(HERE, "templates")
# the reviewed package files the templates are copies of (sha256 of the file in the reviewed 0254-after-0257 package)
TEMPLATE_SHA = {
    "s1-apply-0254a-online.sh": "3255594171f79fc28050492f8f175a8ccf64ff5ce714e098ee39385ebd739f4b",
    "s1-reconcile-0254a-online.sh": "ecfb2d3b6811a8fd390449104f2952b4b4c877abed2fdce361bf69e7d0fa69c9",
    "g02-read-0254a-online.sh": "d5fe9726e46bca1bfd326b6afd08dfb655a30bda3f11da62c30d66aab6812262",
    "window-s1read-0254a.sh": "e2313ac8d927771606ae6004f3a8bd6be1e601277f9cda004ff037b49a583515",
    "run-window-read-macos.sh": "471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357",
    "install-0254a-online.sh": None,  # pinned by its own rebuild below (the reviewed installer embeds file shas)
    "hone-stage-run.sh": "c2e92c9570ca0fd3204b4ca55428394b5bbf2eb5ba62ffcf9c6e1cc5c3e3c418",
    "run.exp": "5b453f6f6d33f8fa50248d5693c0c94a2d3b0373c25f8e3f1e940868abf0e69d",
    "0254a.conf": "82573fa9b0441f7e0d00cc2406d39642d272164d06f0c1c3e992bed7bfb3fd30",
}


class Refused(Exception):
    pass


def die(msg):
    raise Refused(msg)


def shab(b):
    return hashlib.sha256(b).hexdigest()


def shaf(p):
    return shab(open(p, "rb").read())


def sub(text, old, new, n=1, label=""):
    got = text.count(old)
    if got != n:
        die("template drift: %s expected %d occurrence(s) of %r, found %d" % (label or "literal", n, old[:90], got))
    return text.replace(old, new)


def rsub(text, pat, new, n=1, label="", flags=re.S):
    out, got = re.subn(pat, lambda m: new, text, flags=flags)
    if got != n:
        die("template drift: %s expected %d match(es) of /%s/, found %d" % (label or "pattern", n, pat[:90], got))
    return out


def v4(n):
    return "%04d" % n


def ranges(nums):
    """0247, 0249..0253, 0255 and 0256 -> text, as the reviewed scripts word it"""
    nums = sorted(nums)
    parts, i = [], 0
    while i < len(nums):
        j = i
        while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1:
            j += 1
        if j - i >= 2:
            parts.append("%s..%s" % (v4(nums[i]), v4(nums[j])))
        else:
            parts.extend(v4(x) for x in nums[i:j + 1])
        i = j + 1
    if not parts:
        return "none"
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]


def md5list(vs):
    return hashlib.md5(",".join(v4(x) for x in sorted(vs)).encode()).hexdigest()


def ustar(files):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.GNU_FORMAT) as tf:
        for d in ("supabase", "supabase/migrations"):
            ti = tarfile.TarInfo(d + "/"); ti.type = tarfile.DIRTYPE; ti.mode = 0o755; tf.addfile(ti)
        for n in sorted(files):
            ti = tarfile.TarInfo("supabase/migrations/" + n); ti.size = len(files[n]); ti.mode = 0o644
            tf.addfile(ti, io.BytesIO(files[n]))
    return buf.getvalue()


def write(path, data, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "wb").write(data if isinstance(data, bytes) else data.encode())
    os.chmod(path, mode)


def tpl(name):
    p = os.path.join(TPL, name)
    want = TEMPLATE_SHA.get(name)
    if want and shaf(p) != want:
        die("template %s is not the reviewed file (sha256 %s)" % (name, shaf(p)))
    return open(p).read()


# ----------------------------------------------------------------------------------------------------------
# the plan: which versions are present before and after each step
# ----------------------------------------------------------------------------------------------------------
def plan(spec, include=None):
    hdir = spec["hosted"]["dir"]
    skipped = set(spec["hosted"].get("skipped", [158]))
    hosted = {}
    for f in sorted(os.listdir(hdir)):
        m = re.match(r"^(\d{4})_[A-Za-z0-9_]+\.sql$", f)
        if m:
            hosted[int(m.group(1))] = f
    if not hosted:
        die("no hosted migration files in %s" % hdir)
    ex = spec["hosted"]
    if "expect_rows" in ex and len(hosted) != ex["expect_rows"]:
        die("the hosted directory holds %d files, the spec expects %d (the directory is not the hosted set)" % (len(hosted), ex["expect_rows"]))
    if "expect_max" in ex and v4(max(hosted)) != ex["expect_max"]:
        die("the hosted directory max is %s, the spec expects %s" % (v4(max(hosted)), ex["expect_max"]))
    steps, seen = [], set(hosted)
    cur_files = {v: open(os.path.join(hdir, f), "rb").read() for v, f in hosted.items()}
    names = dict(hosted)
    cur = set(hosted)
    pins_hosted = []
    for pv in spec["hosted"].get("pin", ["0257"]):
        pf = [f for x, f in hosted.items() if x == int(pv)]
        if not pf:
            die("the hosted set has no file %s to pin by sha" % pv)
        pins_hosted.append((pf[0], shab(cur_files[int(pv)])))
    earlier = []
    chosen = [x for i, x in enumerate(spec["steps"]) if include is None or i in include]
    for k, s in enumerate(chosen, 1):
        fn0 = os.path.basename(s["file"])
        m = re.match(r"^(\d{4})_[A-Za-z0-9_]+\.sql$", fn0)
        if not m:
            die("step %d: %r is not NNNN_name.sql" % (k, fn0))
        body = open(s["file"], "rb").read()
        if s.get("sha256") and shab(body) != s["sha256"]:
            die("step %d (%s): the file is not the sealed one (sha256 %s, the spec says %s)" % (k, fn0, shab(body), s["sha256"]))
        fn = fn0
        v = int(fn[:4])
        for r in s.get("requires", []):
            if int(r) not in cur:
                die("step %d (%s) requires %s, which is neither hosted nor an earlier step" % (k, fn0, r))
        if v in cur:
            die("step %d: version %s is already in the hosted set or an earlier step" % (k, v4(v)))
        before, after = set(cur), set(cur) | {v}
        bmax, amax = max(before), max(after)
        include_all = v < bmax
        absent = [i for i in range(1, amax + 1) if i not in after and i not in skipped]
        files = dict(cur_files)
        files[v] = body
        nm = dict(names)
        nm[v] = fn
        st = {
            "k": k, "ver": v4(v), "vn": v, "file": fn, "sealed": shab(body), "head": s.get("head_sha", "0" * 40),
            "stage": "%s-after-%s" % (v4(v), "-".join(e[0][:4] for e in earlier) or "hosted"), "before": before, "after": after,
            "n_before": len(before), "n_after": len(after), "before_max": v4(bmax), "after_max": v4(amax),
            "include_all": include_all, "absent": absent, "md5_before": md5list(before), "md5_after": md5list(after),
            "bundle": {nm[x]: files[x] for x in after}, "pack": s.get("gate_pack"),
            "orig_file": fn0, "droppable": bool(s.get("droppable", True)), "ready": s.get("ready", {}),
            "pins": list(pins_hosted) + list(earlier), "adopt": s.get("adopt"),
        }
        if st["adopt"]:
            if k != 1 or before != set(hosted):
                die("step %d (%s): an ADOPTED package is valid only as step 1 on the hosted set" % (k, fn0))
            st["stage"] = st["adopt"]["stage"]
        steps.append(st)
        earlier.append((fn, shab(body)))
        cur, cur_files, names = after, files, nm
    return hosted, steps


# ----------------------------------------------------------------------------------------------------------
# gate pack (migration-specific content gates; supplied by the migration's own review)
# ----------------------------------------------------------------------------------------------------------
def load_pack(st, specdir):
    if not st["pack"]:
        return None
    pdir = os.path.normpath(os.path.join(specdir, st["pack"]))
    p = json.load(open(os.path.join(pdir, "pack.json")))
    req = p.get("requires_before_max")
    if req and req != st["before_max"]:
        die("step %d (%s): its gate pack was reviewed for a hosted max of %s but this order gives %s; the pack must be re-reviewed for the new position"
            % (st["k"], st["ver"], req, st["before_max"]))
    p["_dir"] = pdir
    return p


def gen_sql(st, pack, S):
    """returns {name: text} of the read-only gate files generated for this step"""
    out = {}
    bm, V = st["before_max"], st["ver"]
    out["g02-history-%s.sql" % S] = (
        "-- GATE G2 (%s, MULTI-STAGE, PREPARATION ONLY / HELD): the hosted migration history before step %d (%s). Generated by build.py.\n"
        "-- One SELECT over supabase_migrations.schema_migrations; counts, one md5 and version strings only. No writes.\n"
        "-- EXPECTED PASS: applied_count = %d, hosted_max = '%s', list_md5 = '%s' (md5 of the sorted version list, comma-joined: pins EXACTLY which versions are present), rows_%s = 0.\n"
        "-- STOP CONDITION: any column differs. Do not apply, do not repair history.\n"
        "select\n"
        "  (select count(*) from supabase_migrations.schema_migrations)                                    as applied_count,\n"
        "  (select max(version) from supabase_migrations.schema_migrations)                                as hosted_max,\n"
        "  (select md5(string_agg(version, ',' order by version)) from supabase_migrations.schema_migrations) as list_md5,\n"
        "  (select count(*) from supabase_migrations.schema_migrations where version = '%s')              as rows_%s;\n"
        % (S, st["k"], V, st["n_before"], bm, st["md5_before"], V, V, V))
    out["s1-history-%s.sql" % S] = (
        "-- S1 read-back history (%s, MULTI-STAGE, PREPARATION ONLY / HELD). Generated by build.py. Read-only.\n"
        "-- EXPECTED after step %d: applied_count = %d, hosted_max = '%s', list_md5 = '%s', rows_%s = 1.\n"
        "select\n"
        "  (select count(*) from supabase_migrations.schema_migrations)                                    as applied_count,\n"
        "  (select max(version) from supabase_migrations.schema_migrations)                                as hosted_max,\n"
        "  (select md5(string_agg(version, ',' order by version)) from supabase_migrations.schema_migrations) as list_md5,\n"
        "  (select count(*) from supabase_migrations.schema_migrations where version = '%s')              as rows_%s;\n"
        % (S, st["k"], st["n_after"], st["after_max"], st["md5_after"], V, V, V))
    if pack:
        tables = pack.get("tables") or []
        if tables:
            ref_open = open(os.path.join(pack["_dir"], "open.sql.ref")).read()
            ref_w03 = open(os.path.join(pack["_dir"], "w03.sql.ref")).read()
            out["s1-open-transactions-%s.sql" % S] = derive_table_sql(ref_open, tables, bm, "scanned")
            out["w03-table-sizes-%s.sql" % S] = derive_table_sql(ref_w03, tables, bm, "named")
        if pack.get("preflight"):
            out["g12-%s-preflight-%s.sql" % (S, S)] = open(os.path.join(pack["_dir"], pack["preflight"]["sql"])).read().replace("__BEFORE_MAX__", bm)
    return out


def derive_table_sql(ref, tables, bm, cte):
    """the reviewed 0254 open-transactions / sizes query with the table set and the chain guard replaced"""
    ref = sub(ref, "'0257'", "'%s'" % bm, label="chain guard version")
    ref = ref.replace("at_hosted_0257", "at_hosted_%s" % bm)
    if cte == "scanned":
        vals = ",\n".join("    ('%s')" % t for t in tables)
        ref = rsub(ref, r"scanned\(table_name\) as \(\n  values\n.*?\n\),", "scanned(table_name) as (\n  values\n%s\n)," % vals, label="scanned table list")
    else:
        vals = ", ".join("('%s')" % t for t in tables)
        ref = rsub(ref, r"named\(table_name\) as \(\n  values.*?\n\)", "named(table_name) as (\n  values %s\n)" % vals, label="named table list")
    return ref


# ----------------------------------------------------------------------------------------------------------
# the per-step scripts
# ----------------------------------------------------------------------------------------------------------
def hist_chain(var, st, after):
    """the field checks every script makes on a history row (grep chain)"""
    n = st["n_after"] if after else st["n_before"]
    mx = st["after_max"] if after else st["before_max"]
    md = st["md5_after"] if after else st["md5_before"]
    rows = 1 if after else 0
    return ("printf '%%s' \"$%s\" | grep -Eq '\"applied_count\":\"?%d\"?[,}]' && printf '%%s' \"$%s\" | grep -q '\"hosted_max\":\"%s\"' "
            "&& printf '%%s' \"$%s\" | grep -q '\"list_md5\":\"%s\"' && printf '%%s' \"$%s\" | grep -Eq '\"rows_%s\":\"?%d\"?[,}]'"
            % (var, n, var, mx, var, md, var, st["ver"], rows))


def gen_scripts(st, pack, S, shas, rt):
    V, F = st["ver"], st["file"]
    ia = "--include-all " if st["include_all"] else ""
    absent = ranges(st["absent"])
    absent_pat = "|".join(v4(x) for x in st["absent"])
    tables = (pack or {}).get("tables") or []
    ntab = len(tables)
    reads = ["g02"] + (["g12"] if pack and pack.get("preflight") else []) + (["open", "w03"] if tables else [])
    verify = (pack or {}).get("verify_label") or "history only (no content verification was supplied for this migration)"
    overall = "OVERALL PASS (%s read-back: %s; read-only, not a promotion)" % (V, verify)
    mode = "BELOW the hosted max %s, so a plain push would refuse it: this step uses db push --include-all" % st["before_max"] if st["include_all"] else \
        "ABOVE the hosted max %s: a plain push applies it, with NO --include-all" % st["before_max"]
    sealed_line = "%s  %s" % (st["sealed"], F)

    # ---------------------------------------------------------------- apply
    a = tpl("s1-apply-0254a-online.sh")
    # constants block and the pending-file line, rewritten wholesale (the same blocks the test harness replaces)
    const = ["PLAT_OS=Darwin", "PLAT_ARCH=arm64", "TTY=/dev/tty", "GO_SHA=%s" % shas["go"],
             "BUNDLE=migrations-stage%s.tar" % S, "BUNDLE_SHA=%s" % shas["bundle"], "LIST=MIGRATIONS-stage%s.sha256" % S, "LIST_SHA=%s" % shas["list"],
             "SEALED_SHA=%s" % st["sealed"], "RUNNER_SHA=%s" % shas["runner"], "RMANIFEST_SHA=%s" % shas["wr_manifest"],
             "S1READ_SHA=%s" % shas["s1read"], "S1RUNNER_SHA=%s" % shas["runner"], "S1MANIFEST_SHA=%s" % shas["s1_manifest"],
             "SQL_S1H=%s" % shas["sql"]["s1-history"], "SQL_G02=%s" % shas["sql"]["g02-history"]]
    for r_, key in (("g12", "g12"), ("open", "s1-open-transactions"), ("w03", "w03-table-sizes")):
        if r_ in reads:
            const.append("SQL_%s=%s" % ({"g12": "G12", "open": "OPEN", "w03": "W03"}[r_], shas["sql"][key]))
    a = rsub(a, r"#CONST-BEGIN\n.*?#CONST-END", "#CONST-BEGIN\n" + "\n".join(const) + "\n#CONST-END", label="apply const block")
    a = rsub(a, r"#GOPEND-BEGIN\n.*?#GOPEND-END", "#GOPEND-BEGIN\nGOPEND='%s'\n#GOPEND-END" % sealed_line, label="apply gopend block")
    a = rsub(a, r"HEAD_SHA=[0-9a-f]{40}  # [^\n]*\n", "HEAD_SHA=%s  # the sealed %s head (step %d of the ordered list; the hosted files plus steps 1..%d)\n" % (st["head"], V, st["k"], st["k"]), label="HEAD_SHA")
    a = sub(a, "NFILES=248\nMAXV=257\n", "NFILES=%d\nMAXV=%d\n" % (st["n_after"], int(st["after_max"])), label="NFILES/MAXV")
    # header: the reviewed header block is replaced by a generated one
    hdr_end = a.index("set -u\numask 077")
    header = (
        "#!/bin/bash\n"
        "# Hone STAGE %s ONLINE, step %d of an ordered multi-stage plan (PREPARATION ONLY / HELD). GENERATED by multi-stage/build.py from the reviewed 0254-after-0257 online script (cecb27bd):\n"
        "# the logic is that script's; only the constants, the history gate, the file checks, the wording and the --include-all flag are generated. Do NOT edit by hand.\n"
        "# Apply migration %s (1 file) through the SESSION POOLER with the vendor supabase-go and ONLY the stage bundle: the hosted files plus steps 1..%d (%d files; %s absent). ONE dry run, ONE push, the read-back.\n"
        "# %s is %s.\n"
        "# Expected hosted history before: %d rows, max %s, md5 of the version list %s, %s absent. After: %d rows, max %s, md5 %s, %s once.\n"
        "# KEPT: bundle/list/binary pins, the pinned REF and session-pooler URL, the FAILED-LOGIN tombstone, the APPLY-STATE single-flight marker (any marker refuses a start; only the reconcile script clears it),\n"
        "#   a dry run that must list exactly %s, exactly one push, UNKNOWN handling (marker stays, no retry), credentials read once, hidden and cleared. ONE migration per run: a push of several files cannot be rolled back file by file.\n"
        "# Exit 0 ONLY after the push log shows exactly 1 \"Applying migration\" line (%s), then \"Finished supabase db push.\", and the CLI exited 0. That does NOT replace the read-back.\n"
        % (V, st["k"], V, st["k"], st["n_after"], absent, V, mode, st["n_before"], st["before_max"], st["md5_before"], V, st["n_after"], st["after_max"], st["md5_after"], V, V, V))
    a = header + a[hdr_end:]
    # receipt
    a = rsub(a, r'detail="The push applied exactly 0254 and the read-back shows 248 rows[^"]*"\n  elif',
             'detail="The push applied exactly %s and the read-back shows %d rows, max %s, %s once, %s absent. The APPLY-STATE marker stays (APPLIED-UNVERIFIED) until s1-reconcile-%s-online.sh archives it; that script makes no connection."\n  elif' % (V, st["n_after"], st["after_max"], V, absent, S),
             label="receipt detail")
    # bundle checks
    a = sub(a, "awk '{v=substr($2,1,4)+0; if (v>=249 && v<=256) print}' \"$SELF/$LIST\" > \"$WORK/pending-from-list.txt\"",
            "awk '{v=substr($2,1,4)+0; if (v==%d) print}' \"$SELF/$LIST\" > \"$WORK/pending-from-list.txt\"" % st["vn"], label="pending-from-list")
    # absent-version checks and the 'hosted 0257 as applied' check
    a = rsub(a, r"grep -Eq '\^\[0-9a-f\]\{64\}  \(0247\|0249[^\n]*\n"
                r"grep -Fxq \"\$SEALED257_SHA[^\n]*\n"
                r"tar -tf [^\n]*0247\|0249[^\n]*\n"
                r"grep -Eq '\^\[0-9a-f\]\{64\}  0254_' [^\n]*\n",
             ("grep -Eq '^[0-9a-f]{64}  (%s)_' \"$SELF/$LIST\" && die \"$LIST names %s: they are not part of this stage\"\n"
              "tar -tf \"$SELF/$BUNDLE\" 2>/dev/null | grep -Eq 'supabase/migrations/(%s)_' && die \"$BUNDLE holds %s: they are not part of this stage\"\n"
              "grep -Eq '^[0-9a-f]{64}  %s_' \"$SELF/$LIST\" || die \"$LIST does not name %s\"\n"
              % (absent_pat, absent, absent_pat, absent, V, V)) if st["absent"] else
             ("grep -Eq '^[0-9a-f]{64}  %s_' \"$SELF/$LIST\" || die \"$LIST does not name %s\"\n" % (V, V)),
             label="absent-version checks")
    mk = lambda n: n.replace("0254_perm_hon44", "0254\x01perm_hon44")  # masked: the template-name rename at the end must not touch generated names
    allow = "".join("%s  %s\n" % (shab(b), mk(n)) for n, b in sorted(st["bundle"].items()))
    allowblock = ("ALLOW='%s'\n" % allow.rstrip("\n") +
                  '[ "$(LC_ALL=C sort "$SELF/$LIST")" = "$(printf \'%s\\n\' "$ALLOW" | LC_ALL=C sort)" ] || die "$LIST is not exactly the reviewed allowlist embedded in this script (an extra, missing or changed migration of ANY number)"\n')
    pinlines = allowblock + "".join('grep -Fxq "%s  %s" "$SELF/$LIST" || die "$LIST does not carry %s at the pinned sha256 %s (a hosted or earlier-step file differs)"\n' % (h, mk(n), mk(n), h[:12]) for n, h in st["pins"])
    a = sub(a, 'grep -Eq \'^[0-9a-f]{64}  %s_\' "$SELF/$LIST" || die "$LIST does not name %s"\n' % (V, V), 'grep -Eq \'^[0-9a-f]{64}  %s_\' "$SELF/$LIST" || die "$LIST does not name %s"\n' % (V, V) + pinlines, label="pin lines")
    a = sub(a, 'echo "head $HEAD_SHA; files $NFILES; pending 1 (0254; 0247, 0249..0253, 0255 and 0256 absent; 0257 hosted)"',
            'echo "head $HEAD_SHA; files $NFILES; pending 1 (%s; %s absent; max before %s)"' % (V, absent, st["before_max"]), label="run record")
    a = sub(a, "the pending file equals the sealed 0254, the hosted 0257 is as applied, 0247, 0249..0253, 0255 and 0256 absent. Working directory",
            "the pending file equals the sealed %s, %s absent. Working directory" % (V, absent), label="bundle verified echo")
    a = sub(a, "the pending file in $LIST differs from the sealed 0254", "the pending file in $LIST differs from the sealed %s" % V, label="pending die")
    a = sub(a, "0247, 0249..0253, 0255 and 0256 absent; 0257 hosted; verified just now)", "%s absent; verified just now)" % absent, label="summary bundle line")
    # the summary block
    sa = a.index('  echo "Runs, in this order, with no retry:"')
    sb = a.index('  echo "NO settings write:')
    n_reads = len(reads)
    rd1 = "history is %d rows with max %s, md5 of the version list %s, %s absent" % (st["n_before"], st["before_max"], st["md5_before"][:8] + "...", V)
    if "g12" in reads:
        rd1 += "; the sealed %s preflight passes" % V
    summ = (
        '  echo "Runs, in this order, with no retry:"\n'
        '  echo "  1. %d READ-ONLY queries (pinned): %s"\n' % (n_reads, rd1)
        + ('  echo "     no transaction older than 60 s on the %d scanned table(s); their sizes and the statement_timeout"\n' % ntab if tables else '')
        + '  echo "  2. one dry run (db push %s--dry-run; %s) that must list exactly %s; the listing is then SHOWN TO YOU"\n' % (ia, ("%s is BELOW the hosted max %s" % (V, st["before_max"]) if st["include_all"] else "%s is above the hosted max %s" % (V, st["before_max"])), V)
        + '  echo "  3. a SECOND, separate APPLY from you, typed after you have read that listing: only then ONE push of %s (db push %s--yes; a write to the production database)"\n' % (V, ia)
        + '  echo "  4. the read-back (window-s1read-%s.sh): history %d rows, max %s, %s once, md5 %s"\n' % (S, st["n_after"], st["after_max"], V, st["md5_after"][:8] + "...")
        + '  echo "STOP (nothing is pushed) if: any pinned file or sha differs; history is not exactly the expected %d rows, max %s, md5 %s; a preflight read fails;"\n' % (st["n_before"], st["before_max"], st["md5_before"][:8] + "...")
        + ('  echo "  any scanned table has an open transaction over 60 s; a table is over 512 MiB; the statement_timeout is 0, over 2 min or unreadable;"\n' if tables else '')
        + '  echo "  a login fails (then a FAILED-LOGIN tombstone blocks every rerun); the dry run lists anything but %s; an APPLY-STATE marker or tombstone already exists."\n' % V
        + '  echo "After the push starts, any failure or interruption leaves the APPLY-STATE marker: the result is UNKNOWN, there is NO retry, and the next step is the read-back and s1-reconcile-%s-online.sh."\n' % S)
    a = a[:sa] + summ + a[sb:]
    a = sub(a, 'echo "Migration: 0254_perm_hon44_role_enforcement.sql, sealed sha256 $SEALED_SHA"', 'echo "Migration: %s, sealed sha256 $SEALED_SHA"' % F, label="summary migration")
    # the rule.js: tables and the four rules, rebuilt from the pack
    rj0 = a.index("const S1 = [")
    rj1 = a.index('} else done(false, "unknown rule");')
    js = []
    tl = "[" + ", ".join('"%s"' % t for t in tables) + "]"
    js.append("const S1 = %s;\nconst W3 = %s;\n" % (tl, tl))
    js.append("const exact = (list) => rows.length === list.length && list.every((t) => rows.filter((r) => r.table_name === t).length === 1) && rows.every((r) => list.includes(r.table_name));\n")
    js.append('if (rule === "g02") {\n  if (rows.length !== 1) done(false, "expected 1 row, got " + rows.length);\n  const r = rows[0];\n'
              '  if (!numEq(r.applied_count, %d)) done(false, "the hosted history is not %d rows (applied_count " + r.applied_count + ")");\n'
              '  if (r.hosted_max !== "%s") done(false, "hosted history max is not %s (" + r.hosted_max + ")");\n'
              '  if (r.list_md5 !== "%s") done(false, "the set of applied versions is not the expected one (list_md5 " + r.list_md5 + ")");\n'
              '  if (!numEq(r.rows_%s, 0)) done(false, "%s is already applied (rows_%s " + r.rows_%s + ")");\n'
              '  done(true, "history is %d rows, max %s, the expected version set, %s absent");\n'
              % (st["n_before"], st["n_before"], st["before_max"], st["before_max"], st["md5_before"], V, V, V, V, st["n_before"], st["before_max"], V))
    if "g12" in reads:
        fl = pack["preflight"]["fields"]
        js.append('} else if (rule === "g12") {\n  if (rows.length !== 1) done(false, "expected 1 row, got " + rows.length);\n  const r = rows[0], bad = [];\n'
                  '  if (!numEq(r.at_hosted_%s, 1)) bad.push("at_hosted_%s");\n'
                  '  for (const k of [%s]) if (!isTrue(r[k])) bad.push(k);\n'
                  '  done(bad.length === 0, bad.length ? "the sealed %s preflight is predicted to refuse or to run against the wrong shape: " + bad.join(", ") : "the sealed %s preflight passes");\n'
                  % (st["before_max"], st["before_max"], ", ".join('"%s"' % f for f in fl), V, V))
    if tables:
        js.append('} else if (rule === "open") {\n  if (!exact(S1)) done(false, "the table set is not exactly the %d scanned table(s) (" + rows.length + " rows)");\n'
                  '  const absent = rows.filter((r) => !isTrue(r.table_present)).map((r) => r.table_name);\n'
                  '  if (absent.length) done(false, "table_present is not true for " + absent.join(", "));\n'
                  '  const old = rows.filter((r) => !numEq(r.old_xact_backends, 0));\n'
                  '  done(old.length === 0, old.length ? "a transaction older than 60 s on " + old.length + " scanned table(s)" : "no transaction older than 60 s on the %d scanned table(s)");\n'
                  % (ntab, ntab))
        js.append('} else if (rule === "w03") {\n  if (!exact(W3)) done(false, "the table set is not exactly the %d named table(s) (" + rows.length + " rows)");\n'
                  '  const absent = rows.filter((r) => !isTrue(r.present)).map((r) => r.table_name);\n'
                  '  if (absent.length) done(false, "table missing: " + absent.join(", "));\n'
                  '  if (rows.some((r) => !(int(r.total_bytes) >= 0))) done(false, "total_bytes unreadable");\n'
                  '  const over = rows.filter((r) => int(r.total_bytes) > 512 * 1024 * 1024).map((r) => r.table_name);\n'
                  '  if (over.length) done(false, "over 512 MiB: " + over.join(", "));\n'
                  '  const st = new Set(rows.map((r) => r.statement_timeout)), lt = new Set(rows.map((r) => r.lock_timeout));\n'
                  '  if (st.has(undefined) || lt.has(undefined) || st.size !== 1 || lt.size !== 1) done(false, "settings missing or inconsistent");\n'
                  '  const s = String([...st][0]).trim(), m = /^(\\d+)(ms|s|min|h|d)?$/.exec(s);\n'
                  '  if (!m) done(false, "the statement_timeout is not a readable duration (" + s + ")");\n'
                  '  const ms = Number(m[1]) * ({ ms: 1, s: 1000, min: 60000, h: 3600000, d: 86400000 })[m[2] || "ms"];\n'
                  '  if (ms === 0) done(false, "the statement_timeout is 0 (unbounded)");\n'
                  '  if (ms > 120000) done(false, "the statement_timeout is " + s + ", longer than 2 min");\n'
                  '  done(true, "%d table(s) under 512 MiB; statement_timeout=" + s + " lock_timeout=" + [...lt][0]);\n' % (ntab, ntab))
    a = a[:rj0] + "".join(js) + a[rj1:]
    # reads
    gate_names = {"g02": "g02-history-%s.sql" % S, "g12": "g12-%s-preflight-%s.sql" % (S, S), "open": "s1-open-transactions-%s.sql" % S, "w03": "w03-table-sizes-%s.sql" % S}
    sqlvar = {"g02": "SQL_G02", "g12": "SQL_G12", "open": "SQL_OPEN", "w03": "SQL_W03"}
    rg = "".join('read_gate %s "$%s" %s\n' % (gate_names[r_], sqlvar[r_], r_) for r_ in reads)
    a = rsub(a, r"read_gate g02-history-0254a\.sql[^\n]*\nread_gate g12[^\n]*\nread_gate s1-open[^\n]*\nread_gate w03[^\n]*\n", rg, label="read_gate calls")
    a = sub(a, '[ "$(cd "$RES" && ls -A | wc -l | tr -d \' \')" = 8 ] || die "the online results directory does not hold exactly the 4 results and 4 sidecars. NOTHING was applied."',
            '[ "$(cd "$RES" && ls -A | wc -l | tr -d \' \')" = %d ] || die "the online results directory does not hold exactly the %d results and %d sidecars. NOTHING was applied."' % (2 * n_reads, n_reads, n_reads), label="results count")
    a = sub(a, 'echo "All 4 pre-push reads passed; the access token is cleared." >&2', 'echo "All %d pre-push reads passed; the access token is cleared." >&2' % n_reads, label="reads passed echo")
    # the pinned-gate-file loop in Part 0 (4 gate files verified by manifest)
    a = sub(a, '[ "$(printf \'%s\\n\' "$oks" | grep -c \': OK$\')" = 4 ] || die "MANIFEST.sha256 did not verify exactly 4 gate files"',
            '[ "$(printf \'%%s\\n\' "$oks" | grep -c \': OK$\')" = %d ] || die "MANIFEST.sha256 did not verify exactly %d gate files"' % (n_reads, n_reads), label="manifest count")
    pairs = " ".join('"%s:$%s"' % (gate_names[r_], sqlvar[r_]) for r_ in reads)
    a = rsub(a, r'for pair in "g02-history-0254a\.sql:\$SQL_G02"[^\n]*; do', "for pair in %s; do" % pairs, label="gate pair loop")
    # dry run / push flags and wording
    a = sub(a, 'run_cli "$DRY" db push --db-url "$URL" --include-all --dry-run', 'run_cli "$DRY" db push --db-url "$URL" %s--dry-run' % ia, label="dry run cmd")
    a = sub(a, 'run_cli "$PUSH" db push --db-url "$URL" --include-all --yes', 'run_cli "$PUSH" db push --db-url "$URL" %s--yes' % ia, label="push cmd")
    a = sub(a, 'die "the dry run lists 1 migration but not the expected 0254.', 'die "the dry run lists 1 migration but not the expected %s.' % V, label="dry run die")
    a = sub(a, 'echo "Dry run OK: exactly 1 migration, 0254." >&2', 'echo "Dry run OK: exactly 1 migration, %s." >&2' % V, label="dry ok echo")
    a = sub(a, 'fail_report "the applied migration is not exactly 0254."', 'fail_report "the applied migration is not exactly %s."' % V, label="applied die")
    a = sub(a, 'echo "STAGE 0254 APPLIED $(utcnow): 1 migration (0254), finish line present, exit 0"', 'echo "STAGE %s APPLIED $(utcnow): 1 migration (%s), finish line present, exit 0"' % (V, V), label="applied record")
    a = sub(a, "echo \"STAGE 0254 PUSHED: exactly 1 migration (0254);", "echo \"STAGE %s PUSHED: exactly 1 migration (%s);" % (V, V), label="pushed echo")
    # read-back verification at the end of apply
    a = rsub(a, r"printf '%s' \"\$c\" \| grep -Eq '\"applied_count\":\"\?248\"\?\[,\}\]'[^\n]*\n[^\n]*\n",
             hist_chain("c", st, True) + "; then\n", label="apply read-back chain")
    a = sub(a, 'echo "read-back verified $(utcnow): 248 rows, max 0257, 0254 once, 0247 absent" >> "$RUN"',
            'echo "read-back verified $(utcnow): %d rows, max %s, %s once, version-set md5 as expected" >> "$RUN"' % (st["n_after"], st["after_max"], V), label="read-back record")
    a = sub(a, "OVERALL PASS (0254 read-back: history, 2 verify checks and the owner-only read-policy proof; read-only, not a promotion)", overall, label="overall pass")
    # the s1 history result file names
    a = a.replace("s1-history-0254a", "s1-history-%s" % S)
    a = a.replace("g02-history-0254a", "g02-history-%s" % S)
    # remaining generic renames
    a = a.replace("0254a", S).replace("STAGE 0254 ", "STAGE %s " % V).replace("sealed 0254", "sealed %s" % V)
    a = sub(a, '-p "The dry run above lists exactly 0254. Type', '-p "The dry run above lists exactly %s. Type' % V, label="second approve prompt")
    a = a.replace("0254_perm_hon44_role_enforcement.sql", F).replace("\x01", "_")
    return a, reads, gate_names


def comment_fixups(a, V, S, absent, st):
    a = rsub(a, r"# The ONE pending file and its sha256 \([^\n]*\n",
             "# The ONE pending file and its sha256 (sealed %s). %s are NOT in this stage.\n" % (V, absent), label="pending comment")
    a = rsub(a, r"# 0249 and above \(other than [0-9]{4}\) cannot be in the bundle[^\n]*\n",
             "# Versions above the stage maximum cannot be in the bundle, and any extra, missing or altered file stops here.\n", label="bundle comment")
    a = rsub(a, r"# STAGE (?:0254|[0-9]{4})-AFTER-0257: 0247, 0249[^\n]*\n",
             "# %s must be ABSENT from the list and the tar%s\n" % (absent, ". With --include-all, anything left in the directory would be applied with this step." if st["include_all"] else "."), label="absent comment")
    return a


def gen_reconcile(st, S, shas):
    V = st["ver"]
    r = tpl("s1-reconcile-0254a-online.sh")
    hdr_end = r.index("set -u\numask 077")
    r = ("#!/bin/bash\n# Hone STAGE %s ONLINE, step %d (PREPARATION ONLY / HELD). GENERATED by multi-stage/build.py from the reviewed s1-reconcile-0254#a-online.sh (ecfb2d3b); logic unchanged, constants and history expectations generated.\n"
         "# Clears the s1-apply-%s-online.sh APPLY-STATE marker, and ONLY by a recorded reconcile from READ-BACK EVIDENCE newer than the marker (ALL: the read-back shows the end state; NONE: a history read taken >= 1200 s after an IN-FLIGHT marker shows nothing applied). It makes no connection.\n"
         % (V, st["k"], S)) + r[hdr_end:]
    r = rsub(r, r"SEALED_SHA=[0-9a-f]{64}\n# the pinned read queries:[^\n]*\nSQL_S1H=[0-9a-f]{64}\nSQL_G02=[0-9a-f]{64}\n",
             "SEALED_SHA=%s\nSQL_S1H=%s\nSQL_G02=%s\n" % (st["sealed"], shas["sql"]["s1-history"], shas["sql"]["g02-history"]), label="reconcile pins")
    r = rsub(r, r"#CONST-BEGIN\nRUNNER_SHA=[0-9a-f]{64}\n#CONST-END", "#CONST-BEGIN\nRUNNER_SHA=%s\n#CONST-END" % shas["runner"], label="reconcile runner")
    r = rsub(r, r"\[ \"\$at_s\" -ge \$\(\(mt_s \+ NONE_WAIT_S\)\) \][^\n]*\n[^\n]*\n",
             '[ "$at_s" -ge $((mt_s + NONE_WAIT_S)) ] && ' + hist_chain("c", st, False) + "\n", label="reconcile none chain")
    r = rsub(r, r"if \[ \"\$at_s\" -gt \"\$mt_s\" \] && printf '%s' \"\$c\" \| grep -Eq '\"applied_count\":\"\?248\"\?\[,\}\]'[^\n]*\n[^\n]*; then cls=ALL; ev=\$d; fi",
             'if [ "$at_s" -gt "$mt_s" ] && ' + hist_chain("c", st, True) + "; then cls=ALL; ev=$d; fi", label="reconcile all chain")
    r = sub(r, "OVERALL PASS (0254 read-back: history, 2 verify checks and the owner-only read-policy proof; read-only, not a promotion)", shas["overall"], label="reconcile overall")
    r = sub(r, "a 247-row read means a restore", "a %d-row read means a restore" % st["n_before"], label="reconcile row msg")
    r = sub(r, "pgrep -f 'supabase|s1-apply-0254a|g02-read-0254'", "pgrep -f 'supabase|s1-apply-%s|g02-read-%s'" % (S, S), label="reconcile pgrep")
    r = rsub(r, r"and shows exactly 247 rows, max 0257, 0254 absent[^\n]*\n", "and shows exactly %d rows, max %s, %s absent (the pinned version-set md5)\n" % (st["n_before"], st["before_max"], st["ver"]), label="reconcile none comment")
    r = r.replace("0254a", S).replace("0254#a", "0254a")
    return r


def gen_g02read(st, S, shas, tables_n):
    g = tpl("g02-read-0254a-online.sh")
    hdr_end = g.index("set -u\numask 077")
    g = ("#!/bin/bash\n# Hone STAGE %s ONLINE, step %d (PREPARATION ONLY / HELD). GENERATED by multi-stage/build.py from the reviewed g02-read-0254#a-online.sh (d5fe9726); logic unchanged.\n"
         "# ONE standalone READ of the pinned g02-history-%s.sql through the verified runner: the fresh history read s1-reconcile-%s-online.sh accepts on its NONE route (>= 1200 s after the marker). READ-ONLY.\n"
         % (st["ver"], st["k"], S, S)) + g[hdr_end:]
    g = rsub(g, r"#CONST-BEGIN\n.*?#CONST-END",
             "#CONST-BEGIN\nPLAT_OS=Darwin\nPLAT_ARCH=arm64\nTTY=/dev/tty\nGO_SHA=%s\nRUNNER_SHA=%s\nRMANIFEST_SHA=%s\nSQL_G02=%s\n#CONST-END" % (shas["go"], shas["runner"], shas["wr_manifest"], shas["sql"]["g02-history"]), label="g02 const")
    g = sub(g, "grep -Eo '\"(applied_count|hosted_max|versions_ge_0249)\":\"?[0-9]+\"?'", "grep -Eo '\"(applied_count|hosted_max|rows_%s)\":\"?[0-9]+\"?'" % st["ver"], label="g02 fields")
    g = g.replace("0254a", S).replace("0254#a", "0254a")
    return g


def gen_s1read(st, pack, S, shas, files):
    V = st["ver"]
    w = tpl("window-s1read-0254a.sh")
    hdr_end = w.index("set -u\numask 077")
    w = ("#!/bin/bash\n# Hone STAGE %s ONLINE, step %d READ-BACK (PREPARATION ONLY / HELD). GENERATED by multi-stage/build.py from the reviewed window-s1read-0254#a.sh (e2313ac8): read-only, fail-closed, no retries.\n"
         "# Exit 0 ONLY after it prints the exact OVERALL PASS line. That is read-back evidence; it does not promote anything.\n" % (V, st["k"])) + w[hdr_end:]
    w = rsub(w, r"GO_SHA=[0-9a-f]{64}\nRUNNER_SHA=[0-9a-f]{64}\nMANIFEST_SHA=[0-9a-f]{64}\n",
             "GO_SHA=%s\nRUNNER_SHA=%s\nMANIFEST_SHA=%s\n" % (shas["go"], shas["runner"], shas["s1_manifest"]), label="s1read pins")
    w = sub(w, 'FILES="s1-history-0254a.sql c01_functions-exist.sql c02_function-bodies.sql c03_read-policies.sql"\nNFILES=4\n',
            'FILES="%s"\nNFILES=%d\n' % (" ".join(files), len(files)), label="s1read files")
    w = rsub(w, r"  if \[ \"\$f\" = s1-history-0254a\.sql \]; then\n.*?\n  fi\n  n=\$\(\(n\+1\)\)",
             '  if [ "$f" = s1-history-%s.sql ]; then\n    # The history is read FIRST. If it is not exactly the end state, nothing else is read.\n    %s \\\n'
             '      || die "s1-history: the history is not exactly %d rows, max %s, %s once, the expected version set (md5 %s). The step did not reach its end state. Do NOT continue. Nothing else was read; report this result: $r"\n  fi\n  n=$((n+1))'
             % (S, hist_chain("c", st, True), st["n_after"], st["after_max"], V, st["md5_after"]), label="s1read history check")
    # the node check
    a0 = w.index("const EXPECT = {")
    a1 = w.index('console.log("");\nconsole.log("OVERALL PASS')
    pre = open(os.path.join(pack["_dir"], "verify-pre.js.part")).read() if pack and pack.get("verify_label") else ""
    body = open(os.path.join(pack["_dir"], "verify-body.js.part")).read() if pack and pack.get("verify_label") else ""
    hist = ('const h = rows("s1-history-%s");\nif (h.length !== 1) fail("s1-history-%s: not exactly one row");\nconst r = h[0];\n'
            'if (!(num(r.applied_count, %d) && r.hosted_max === "%s" && r.list_md5 === "%s" && num(r.rows_%s, 1))) fail("history is not %d / %s / the expected version set / %s once");\n'
            'console.log("PASS history: %d rows, max %s, the expected version set, %s once");\n'
            % (S, S, st["n_after"], st["after_max"], st["md5_after"], V, st["n_after"], st["after_max"], V, st["n_after"], st["after_max"], V))
    w = w[:a0] + pre + hist + body + w[a1:]
    w = sub(w, "OVERALL PASS (0254 read-back: history, 2 verify checks and the owner-only read-policy proof; read-only, not a promotion)", shas["overall"], n=2, label="s1read overall")
    w = w.replace("0254a", S)
    w = w.replace("sealed 0254", "sealed %s" % V).replace("WINDOW S1 READ-BACK (0254)", "WINDOW S1 READ-BACK (%s)" % V).replace("0254#a", "0254a")
    return w


def gen_conf(st, S, shas):
    c = tpl("0254a.conf")
    c = rsub(c, r"# PREPARATION ONLY / HELD\.[^\n]*\n", "# PREPARATION ONLY / HELD. Stage manifest for step %d (migration %s) of an ordered multi-stage plan. GENERATED by multi-stage/build.py. Plain KEY=VALUE lines; nothing here is evaluated.\n" % (st["k"], st["ver"]), label="conf header")
    c = sub(c, "STAGE=0254a\n", "STAGE=%s\n" % S, label="conf stage")
    c = rsub(c, r"PIN=[0-9a-f]{64}  s1-apply-0254a-online/s1-apply-0254a-online\.sh", "PIN=%s  s1-apply-%s-online/s1-apply-%s-online.sh" % (shas["apply"], S, S), label="conf pin apply")
    c = rsub(c, r"PIN=[0-9a-f]{64}  s1-apply-0254a-online/s1-reconcile-0254a-online\.sh", "PIN=%s  s1-apply-%s-online/s1-reconcile-%s-online.sh" % (shas["reconcile"], S, S), label="conf pin reconcile")
    c = rsub(c, r"PIN=[0-9a-f]{64}  window-reads-s1-0254a/window-s1read-0254a\.sh", "PIN=%s  window-reads-s1-%s/window-s1read-%s.sh" % (shas["s1read"], S, S), label="conf pin s1read")
    c = sub(c, "PROMPT=approve|The dry run above lists exactly 0254. Type", "PROMPT=approve|The dry run above lists exactly %s. Type" % st["ver"], label="conf second approve prompt")
    c = c.replace("0254a", S)
    return c


def gen_installer(st, S, fileshas, shas, srcdir, warn):
    i = tpl("install-0254a-online.sh")
    i = rsub(i, r"#!/bin/bash\n# PREPARATION ONLY / HELD\.[^\n]*\n# 1\. Download the 21 reviewed files[^\n]*\n",
             "#!/bin/bash\n# PREPARATION ONLY / HELD. STAGE %s ONLINE, step %d of an ordered multi-stage plan. GENERATED by multi-stage/build.py. Local to this Mac: no hosted call, no secret.\n"
             "# 1. Download the %d package files, check each by FULL sha256; install nothing unless all match.\n" % (st["ver"], st["k"], len(fileshas)), label="installer header")
    setblock = "SET='\n" + "".join("%s %s\n" % (h, n) for n, h in sorted(fileshas.items())) + "'\n"
    i = rsub(i, r"SET='\n.*?\n'\n", setblock, label="installer SET")
    i = sub(i, "[ \"$n\" = 21 ] || { rm -rf \"$T\"; die \"internal: expected 21 pinned files, read $n\"; }", "[ \"$n\" = %d ] || { rm -rf \"$T\"; die \"internal: expected %d pinned files, read $n\"; }" % (len(fileshas), len(fileshas)), label="installer count 1")
    i = sub(i, "[ \"$inst\" = 21 ] || die \"installed files did not re-check ($inst of 21)\"", "[ \"$inst\" = %d ] || die \"installed files did not re-check ($inst of %d)\"" % (len(fileshas), len(fileshas)), label="installer count 2")
    i = sub(i, 'echo "INSTALLED 21 of 21 pinned files, each re-checked in place"', 'echo "INSTALLED %d of %d pinned files, each re-checked in place"' % (len(fileshas), len(fileshas)), label="installer count 3")
    i = sub(i, "expected exactly: ~/hone-s1/s1-apply-0254a-online/s1-apply-0254a-online.sh 450e8333..., .../s1-reconcile-0254a-online.sh ecfb2d3b...)",
            "expected exactly: ~/hone-s1/s1-apply-%s-online/s1-apply-%s-online.sh %s..., .../s1-reconcile-%s-online.sh %s...)" % (S, S, shas["apply"][:8], S, shas["reconcile"][:8]), label="installer expected")
    i = rsub(i, r"SRC=sam@[^\n]*\n", "SRC=%s\n" % srcdir, label="installer SRC")
    if warn:
        i = sub(i, 'echo "INSTALLED %d of %d pinned files, each re-checked in place"' % (len(fileshas), len(fileshas)),
                'echo "INSTALLED %d of %d pinned files, each re-checked in place"\necho "WARNING: this step has NO migration-specific content gates (no preflight, no table or lock check, no content read-back). It is a rehearsal artefact, NOT production-ready."' % (len(fileshas), len(fileshas)), label="installer warn")
    i = i.replace("0254a", S)
    return i


def retarget(text, V, S):
    """a step whose version is not 0254 still carries the template's '0254' in prose. Only the known template phrases are renamed (the
    stage id, the file names, the allowlist and the absent-version lists legitimately contain other numbers and are never touched)"""
    if V == "0254":
        return text
    text = text.replace("install-0254-online.sh", "install-%s-online.sh" % S)
    text = re.sub(r"(?<![\w.-])0254(?= (?:gate files|stage|read-back))", V, text)
    text = text.replace("(0254 read-back", "(%s read-back" % V)
    return text


def rule_violation(rules, plan, hosted_versions):
    """the stage-drop rules (OPS release plan 2026-10-30): returns the reason a plan is refused, or None"""
    for x, deps in sorted(rules.get("closure", {}).items()):
        if x not in plan:
            for d in deps:
                if d in plan:
                    return "dependency closure: %s is dropped, so %s must be dropped too" % (x, d)
    for a, b in rules.get("adjacent", []):
        if a in plan:
            i = plan.index(a)
            if i + 1 >= len(plan) or plan[i + 1] != b:
                return "%s must be immediately followed by %s (no plan may leave %s without %s)" % (a, b, a, b)
    for x, deps in sorted(rules.get("requires_earlier", {}).items()):
        if x in plan:
            i = plan.index(x)
            for d in deps:
                if d not in plan[:i] and d not in hosted_versions:
                    return "%s needs %s earlier in the plan or already hosted" % (x, d)
    return None


def sha_lines(items):
    return "".join("%s  %s\n" % (h, n) for n, h in items)


def emit_adopted(st, out, specdir, ctx):
    """Step 1 = a reviewed package copied UNCHANGED (checked by sha256 against its own SHA256SUMS). Only the bundle is
    rebuilt from bytes (hosted files + the sealed target; V5: no merged carrier PR is needed) and must equal the package's tar."""
    S, V = st["stage"], st["ver"]
    ad = os.path.join(os.path.dirname(os.path.abspath(__file__)), "adopted", st["adopt"]["dir"])
    sums = {}
    for ln in open(os.path.join(ad, "SHA256SUMS.txt")).read().splitlines():
        h, n = ln.split("  ", 1)
        sums[n] = h
    tarn = "s1-apply-%s-online/migrations-stage%s.tar" % (S, S)
    tar = ustar(st["bundle"])
    if shab(tar) != sums[tarn] or shab(tar) != st["adopt"]["tar_sha256"]:
        die("adopted %s: the bundle rebuilt from bytes (%s) is not the package's tar (%s)" % (S, shab(tar), sums[tarn]))
    lst = "".join("%s  %s\n" % (shab(b), n) for n, b in sorted(st["bundle"].items()))
    if shab(lst.encode()) != st["adopt"]["list_sha256"]:
        die("adopted %s: the bundle list sha256 differs from the pinned one" % S)
    d = os.path.join(out, S)
    for n, h in sums.items():
        if n == tarn:
            continue
        b = open(os.path.join(ad, n), "rb").read()
        if shab(b) != h:
            die("adopted %s: %s differs from the package's SHA256SUMS" % (S, n))
        write(os.path.join(d, n), b, 0o755 if n.endswith(".sh") else 0o644)
    for extra in ("install-%s-online.sh" % S, "README.txt", "Z3-RECORD-PLAN.txt"):
        write(os.path.join(d, extra), open(os.path.join(ad, extra), "rb").read(), 0o755 if extra.endswith(".sh") else 0o644)
    write(os.path.join(d, tarn), tar, 0o644)
    write(os.path.join(d, "SHA256SUMS.txt"), open(os.path.join(ad, "SHA256SUMS.txt"), "rb").read())
    ap = open(os.path.join(d, "s1-apply-%s-online/s1-apply-%s-online.sh" % (S, S))).read()
    if "HEAD_SHA=%s" % st["head"] not in ap:
        die("adopted %s: the package's HEAD_SHA is not the spec's head_sha %s" % (S, st["head"]))
    if shab(ap.encode()) != st["adopt"]["apply_sha256"]:
        die("adopted %s: apply sha256 is not the pinned one" % S)
    exp = {"step": st["k"], "stage": S, "adopted": True, "migration": st["file"], "sealed_sha256": st["sealed"], "include_all": st["include_all"],
           "history_before": {"rows": st["n_before"], "max": st["before_max"], "list_md5": st["md5_before"], "versions_present": [v4(x) for x in sorted(st["before"])]},
           "history_after": {"rows": st["n_after"], "max": st["after_max"], "list_md5": st["md5_after"], "added": V},
           "absent_in_bundle": [v4(x) for x in st["absent"]], "bundle": {"files": st["n_after"], "tar_sha256": shab(tar), "list_sha256": shab(lst.encode()), "built_from": "bytes: the hosted tree + the sealed target (no carrier PR merge needed)"},
           "dry_run_must_list": [st["file"]], "content_gates": True, "gate_reads": 4,
           "between_steps": ["window-s1read-%s.sh" % S, "s1-reconcile-%s-online.sh (ALL route)" % S],
           "pins": {"reconcile": sums["s1-apply-%s-online/s1-reconcile-%s-online.sh" % (S, S)], "s1read": sums["window-reads-s1-%s/window-s1read-%s.sh" % (S, S)], "g02read": sums["s1-apply-%s-online/g02-read-%s-online.sh" % (S, S)], "go": ctx["go"], "runner": sums["window-reads-%s/run-window-read-macos.sh" % S], "overall": re.search(r"grep -Fxq '(OVERALL PASS[^']*)'", open(os.path.join(d, "window-reads-s1-%s/window-s1read-%s.sh" % (S, S))).read()).group(1), "apply": shab(ap.encode()), "conf": sums["runner/stages/%s.conf" % S], "bundle": shab(tar), "list": shab(lst.encode())}, "file_sha256": sums}
    write(os.path.join(d, "EXPECT.json"), json.dumps(exp, indent=2, sort_keys=True) + "\n")
    return ({k: exp[k] for k in ("step", "stage", "migration", "sealed_sha256", "include_all", "history_before", "history_after", "absent_in_bundle", "bundle", "content_gates")} | {"apply_sha256": shab(ap.encode()), "conf_sha256": sums["runner/stages/%s.conf" % S], "adopted": True})


def emit_step(st, out, specdir, ctx):
    if st.get("adopt"):
        return emit_adopted(st, out, specdir, ctx)
    go, srcbase, runner_b, stage_run, run_exp = ctx["go"], ctx["srcbase"], ctx["runner_b"], ctx["stage_run"], ctx["run_exp"]
    S, V = st["stage"], st["ver"]
    pack = load_pack(st, specdir)
    d = os.path.join(out, S)
    ad, wd, sd, rd = [os.path.join(d, x) for x in ("s1-apply-%s-online" % S, "window-reads-%s" % S, "window-reads-s1-%s" % S, "runner")]
    sql = gen_sql(st, pack, S)
    tar = ustar(st["bundle"])
    lst = sha_lines(sorted((n, shab(b)) for n, b in st["bundle"].items()))
    lst = "".join("%s  %s\n" % (shab(b), n) for n, b in sorted(st["bundle"].items()))
    shas = {"go": go, "runner": shab(runner_b), "bundle": shab(tar), "list": shab(lst.encode()), "sql": {}}
    for n, t in sql.items():
        key = "g02-history" if n.startswith("g02-") else "s1-history" if n.startswith("s1-history") else "g12" if n.startswith("g12") else n.rsplit("-" + S, 1)[0]
        shas["sql"][key] = shab(t.encode())
    reads_files = [("g02-history-%s.sql" % S)] + [n for n in ("g12-%s-preflight-%s.sql" % (S, S), "s1-open-transactions-%s.sql" % S, "w03-table-sizes-%s.sql" % S) if n in sql]
    cfiles = [(n, open(os.path.join(pack["_dir"], n), "rb").read()) for n in (pack or {}).get("verify_sql", [])]
    s1files = ["s1-history-%s.sql" % S] + [n for n, _ in cfiles]
    shas["wr_manifest"] = shab(sha_lines((n, shab(sql[n].encode())) for n in reads_files).encode())
    shas["s1_manifest"] = shab(sha_lines([("s1-history-%s.sql" % S, shab(sql["s1-history-%s.sql" % S].encode()))] + [(n, shab(b)) for n, b in cfiles]).encode())
    verify = (pack or {}).get("verify_label") or "history only (no content verification was supplied for this migration)"
    shas["overall"] = "OVERALL PASS (%s read-back: %s; read-only, not a promotion)" % (V, verify)
    # read-back script, then apply (pins it), then the rest
    s1read = retarget(gen_s1read(st, pack, S, shas, s1files), V, S)
    shas["s1read"] = shab(s1read.encode())
    apply_, reads, gnames = gen_scripts(st, pack, S, shas, None)
    apply_ = retarget(comment_fixups(apply_, V, S, ranges(st["absent"]) if st["absent"] else "none", st), V, S)
    shas["apply"] = shab(apply_.encode())
    recon = retarget(gen_reconcile(st, S, shas), V, S)
    shas["reconcile"] = shab(recon.encode())
    g02r = retarget(gen_g02read(st, S, shas, 0), V, S)
    shas["g02read"] = shab(g02r.encode())
    conf = gen_conf(st, S, shas)
    shas["conf"] = shab(conf.encode())
    files = {}
    files["s1-apply-%s-online/s1-apply-%s-online.sh" % (S, S)] = (apply_, 0o755)
    files["s1-apply-%s-online/s1-reconcile-%s-online.sh" % (S, S)] = (recon, 0o755)
    files["s1-apply-%s-online/g02-read-%s-online.sh" % (S, S)] = (g02r, 0o755)
    files["s1-apply-%s-online/migrations-stage%s.tar" % (S, S)] = (tar, 0o644)
    files["s1-apply-%s-online/MIGRATIONS-stage%s.sha256" % (S, S)] = (lst, 0o644)
    for n in reads_files:
        files["window-reads-%s/%s" % (S, n)] = (sql[n], 0o644)
    files["window-reads-%s/MANIFEST.sha256" % S] = (sha_lines((n, shab(sql[n].encode())) for n in reads_files), 0o644)
    files["window-reads-%s/run-window-read-macos.sh" % S] = (runner_b, 0o755)
    files["window-reads-s1-%s/s1-history-%s.sql" % (S, S)] = (sql["s1-history-%s.sql" % S], 0o644)
    for n, b in cfiles:
        files["window-reads-s1-%s/%s" % (S, n)] = (b, 0o644)
    files["window-reads-s1-%s/MANIFEST.sha256" % S] = (sha_lines([("s1-history-%s.sql" % S, shab(sql["s1-history-%s.sql" % S].encode()))] + [(n, shab(b)) for n, b in cfiles]), 0o644)
    files["window-reads-s1-%s/run-window-read-macos.sh" % S] = (runner_b, 0o755)
    files["window-reads-s1-%s/window-s1read-%s.sh" % (S, S)] = (s1read, 0o755)
    files["runner/hone-stage-run.sh"] = (stage_run, 0o755)
    files["runner/run.exp"] = (run_exp, 0o644)
    files["runner/stages/%s.conf" % S] = (conf, 0o644)
    fshas = {n: shab(c if isinstance(c, bytes) else c.encode()) for n, (c, _) in files.items()}
    inst = gen_installer(st, S, fshas, shas, "%s/stage-%s-mac" % (srcbase, S), not pack)
    for n, (c, mode) in files.items():
        write(os.path.join(d, n), c, mode)
    write(os.path.join(d, "install-%s-online.sh" % S), inst, 0o755)
    sums = dict(fshas)
    sums["install-%s-online.sh" % S] = shab(inst.encode())
    write(os.path.join(d, "SHA256SUMS.txt"), sha_lines(sorted(sums.items())))
    exp = {"step": st["k"], "stage": S, "migration": st["file"], "sealed_sha256": st["sealed"], "include_all": st["include_all"],
           "history_before": {"rows": st["n_before"], "max": st["before_max"], "list_md5": st["md5_before"], "versions_present": [v4(x) for x in sorted(st["before"])]},
           "history_after": {"rows": st["n_after"], "max": st["after_max"], "list_md5": st["md5_after"], "added": V},
           "absent_in_bundle": [v4(x) for x in st["absent"]], "bundle": {"files": st["n_after"], "tar_sha256": shas["bundle"], "list_sha256": shas["list"]},
           "dry_run_must_list": [st["file"]], "content_gates": bool(pack), "gate_reads": len(reads), "gate_tables": list((pack or {}).get("tables") or []),
           "between_steps": ["window-s1read-%s.sh (read-back, must print the exact OVERALL PASS line)" % S, "s1-reconcile-%s-online.sh (ALL route; archives the APPLY-STATE marker)" % S],
           "pins": {k: v for k, v in shas.items() if k not in ("sql",)}, "file_sha256": sums}
    write(os.path.join(d, "EXPECT.json"), json.dumps(exp, indent=2, sort_keys=True) + "\n")
    warn = "" if pack else "\n**CONTENT GATES MISSING: this step has a history-only gate. It is NOT production-ready until its migration review supplies a gate pack (preflight, table/lock reads, content read-back).**\n"
    write(os.path.join(d, "README.txt"),
          "PREPARATION ONLY / HELD. Step %d of an ordered multi-stage plan: apply %s alone.%s\n\nBundle: hosted files + steps 1..%d = %d files (sha256 %s).\n%s\nHistory %d rows (max %s) -> %d rows (max %s), %s once.\n"
          "Run order: install, run the stage through the runner, then window-s1read-%s.sh, then s1-reconcile-%s-online.sh, and only then the next step.\n"
          % (st["k"], st["file"], warn, st["k"], st["n_after"], shas["bundle"], "include-all: " + ("YES (step is below the hosted max)" if st["include_all"] else "no (plain push)"), st["n_before"], st["before_max"], st["n_after"], st["after_max"], V, S, S))
    return ({k: exp[k] for k in ("step", "stage", "migration", "sealed_sha256", "include_all", "history_before", "history_after", "absent_in_bundle", "bundle", "content_gates")} | {"apply_sha256": shas["apply"], "conf_sha256": shas["conf"]})



def gen_plan_check(rules, vers, sequences, stages, hosted):
    """the plan validator the operator runs BEFORE any stage: the stage-drop rules, then an exact lookup of the pre-built stage packages"""
    rel = set()
    for x, deps in rules.get("closure", {}).items(): rel |= {x} | set(deps)
    for a, b in rules.get("adjacent", []): rel |= {a, b}
    for x, deps in rules.get("requires_earlier", {}).items(): rel |= {x} | set(deps)
    j = lambda m: " ".join("%s:%s" % (k, ",".join(v)) for k, v in sorted(m.items()))
    known = "".join("%s|%s|%s\n" % (name, " ".join(q["versions"]), " ".join(q["stages"])) for name, q in sorted(sequences.items()))
    return (
        "#!/bin/bash\n# PREPARATION ONLY / HELD. GENERATED by multi-stage/build.py. Plan validation BEFORE any stage runs: usage: plan-check.sh VERSION...  (in the order they would be applied)\n"
        "# 1. the stage-drop rules (dependency closure, adjacency, requires-earlier), 2. an exact lookup of the pre-built stage packages. Makes no connection. Exit 0 prints the stage ids to run, one per line.\n"
        "set -u\n"
        "CLOSURE='%s'   # X:deps  -- if X is not planned, none of deps may be\n"
        "ADJACENT='%s'   # A:B  -- if A is planned, B must be the very next step\n"
        "REQUIRES='%s'   # X:deps  -- if X is planned, each dep must be earlier in the plan or already hosted\n"
        "HOSTED_REL='%s'   # the rule-relevant versions that are hosted already\n"
        "KNOWN='\n%s'\n"
        'die() { echo "PLAN REFUSED: $*" >&2; exit 1; }\n'
        '[ $# -ge 1 ] || die "give the versions in the order they would be applied"\n'
        'plan=" "; for v in "$@"; do case "$v" in [0-9][0-9][0-9][0-9]) ;; *) die "$v is not a four-digit version" ;; esac\n'
        '  case "$plan" in *" $v "*) die "$v is planned twice" ;; esac; plan="$plan$v "; done\n'
        'inplan() { case "$plan" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }\n'
        'pos() { local i=0 x; for x in $plan; do i=$((i+1)); [ "$x" = "$1" ] && { echo $i; return; }; done; echo 0; }\n'
        'for e in $CLOSURE; do x=${e%%%%:*}; deps=${e#*:}; inplan "$x" && continue; for d in ${deps//,/ }; do inplan "$d" && die "dependency closure: $x is dropped, so $d must be dropped too"; done; done\n'
        'for e in $ADJACENT; do a=${e%%%%:*}; b=${e#*:}; inplan "$a" || continue; pa=$(pos "$a"); pb=$(pos "$b"); [ "$pb" = $((pa+1)) ] || die "$a must be immediately followed by $b (no plan may leave $a without $b)"; done\n'
        'for e in $REQUIRES; do x=${e%%%%:*}; deps=${e#*:}; inplan "$x" || continue; px=$(pos "$x"); for d in ${deps//,/ }; do pd=$(pos "$d"); if [ "$pd" = 0 ] || [ "$pd" -gt "$px" ]; then case " $HOSTED_REL " in *" $d "*) ;; *) die "$x needs $d earlier in the plan or already hosted" ;; esac; fi; done; done\n'
        'want="$*"; hit=$(printf \'%%s\' "$KNOWN" | awk -F"|" -v w="$want" \'$2 == w {print $3; exit}\')\n'
        '[ -n "$hit" ] || die "the rules allow this plan, but no pre-built stage package matches this exact order of versions: $want"\n'
        'for s in $hit; do echo "$s"; done\n'
    ) % (j(rules.get("closure", {})), j({a: [b] for a, b in rules.get("adjacent", [])}), j(rules.get("requires_earlier", {})), " ".join(sorted(rel & hosted)), known)


def main():
    args = [a for a in sys.argv[1:]]
    if len(args) != 2:
        die("usage: build.py SPEC.json OUTDIR")
    specp, out = os.path.abspath(args[0]), os.path.abspath(args[1])
    spec = json.load(open(specp))
    specdir = os.path.dirname(specp)
    spec["hosted"]["dir"] = os.path.normpath(os.path.join(specdir, spec["hosted"]["dir"]))
    for s_ in spec["steps"]:
        s_["file"] = os.path.normpath(os.path.join(specdir, s_["file"]))
    hosted, _ = plan(spec, include=[])
    ctx = {"go": spec.get("go_sha", "dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b"),
           "srcbase": spec.get("src_base", "sam@100.123.145.56:/home/sam/hone-handoffs/2026-10-18/01-ops"),
           "runner_b": open(os.path.join(TPL, "run-window-read-macos.sh"), "rb").read()}
    tpl("run-window-read-macos.sh")
    ctx["stage_run"], ctx["run_exp"] = tpl("hone-stage-run.sh"), tpl("run.exp")
    n = len(spec["steps"])
    vers = [os.path.basename(x["file"])[:4] for x in spec["steps"]]
    if os.path.exists(out):
        shutil.rmtree(out)
    rules = spec.get("rules", {})
    sequences, stages, skipped = {}, {}, {}
    for mask in range((1 << n) - 1, -1, -1):
        include = [i for i in range(n) if mask >> i & 1]
        dropped = [vers[i] for i in range(n) if i not in include]
        if any(spec["steps"][i].get("droppable", True) is False for i in range(n) if i not in include):
            continue
        have = set(str(v4(v)) for v in hosted)
        bad = None
        for i in include:
            for r in spec["steps"][i].get("requires", []):
                if r not in have:
                    bad = "%s requires %s" % (vers[i], r)
            have.add(vers[i])
        name = "full" if not dropped else "drop-" + "+".join(dropped)
        bad = bad or rule_violation(rules, [vers[i] for i in include], set(str(v4(v)) for v in hosted))
        if bad:
            skipped[name] = bad
            continue
        _, steps = plan(spec, include=include)
        seq = []
        for st in steps:
            if st["stage"] not in stages:
                stages[st["stage"]] = emit_step(st, out, specdir, ctx)
            elif stages[st["stage"]]["history_before"]["list_md5"] != st["md5_before"] or stages[st["stage"]]["history_after"]["list_md5"] != st["md5_after"]:
                die("internal: stage %s was emitted twice with a different history" % st["stage"])
            seq.append(st["stage"])
        sequences[name] = {"dropped": dropped, "stages": seq, "versions": [st["ver"] for st in steps]}
    write(os.path.join(out, "plan-check.sh"), gen_plan_check(rules, vers, sequences, stages, set(str(v4(v)) for v in hosted)), 0o755)
    plan_json = {"rules": rules, "hosted_before_step_1": {"rows": len(hosted), "max": v4(max(hosted)), "md5": md5list(set(hosted))},
                 "sequences": sequences, "stages": stages, "skipped_sequences": skipped,
                 "readiness": [dict({"migration": os.path.basename(x["file"]), "droppable": x.get("droppable", True), "requires": x.get("requires", [])}, **x.get("ready", {})) for x in spec["steps"]]}
    write(os.path.join(out, "PLAN.json"), json.dumps(plan_json, indent=2, sort_keys=True) + "\n")
    seq = ["# Multi-stage plan (PREPARATION ONLY / HELD)\n",
           "One runner invocation per migration; after each, read back and reconcile before the next. A step that fails leaves the APPLY-STATE marker, which refuses every later step.\n",
           "Every valid way to drop a step is pre-built (%d stage packages, %d sequences): dropping needs no rebuild. A dropped step's successors use the stage package named `<ver>-after-<applied before>`.\n" % (len(stages), len(sequences))]
    for name, q in sorted(sequences.items(), key=lambda kv: (len(kv[1]["dropped"]), kv[0])):
        seq.append("## %s" % name)
        for k, S in enumerate(q["stages"], 1):
            p = stages[S]
            seq.append("%d. `%s` (%s): %d -> %d rows, max %s, include-all %s%s" % (k, S, p["migration"], p["history_before"]["rows"], p["history_after"]["rows"], p["history_after"]["max"], "yes" if p["include_all"] else "no", "" if p["content_gates"] else "  **(CONTENT GATES MISSING)**"))
        seq.append("")
    seq.append("## Readiness of each step\n")
    for r in plan_json["readiness"]:
        seq.append("- `%s`: %s" % (r["migration"], "; ".join("%s=%s" % (k, v) for k, v in sorted(r.items()) if k != "migration")))
    write(os.path.join(out, "SEQUENCE.md"), "\n".join(seq) + "\n")
    print("built %d stage package(s), %d sequence(s) into %s" % (len(stages), len(sequences), out))


if __name__ == "__main__":
    try:
        main()
    except Refused as e:
        sys.stderr.write("BUILD REFUSED: %s\n" % e)
        sys.exit(1)
