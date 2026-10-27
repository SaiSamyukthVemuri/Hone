#!/usr/bin/env python3
"""REHEARSAL - NEVER MERGE. Builds the test copy of s1-apply.sh and the bundle variants for the rehearsal.
The test copy differs from the real script ONLY in the lines this tool rewrites (pins, URL, ref, embedded list, and the
platform check on Linux); it asserts that and prints the changed lines.
usage:
  fixture.py copy  <real-script> <out-script> --go-sha S --bundle-sha S --list-sha S --ref R --url U --go34 FILE [--no-platform]
  fixture.py syn   <outdir> [--fail 0230]                 synthetic bundle with the REAL names (+ list, go34 file)
  fixture.py vary  <srcdir> <outdir> <tamper|add247|add247-list|drop|alter|link>
"""
import hashlib, io, os, sys, tarfile

def sha(b): return hashlib.sha256(b).hexdigest()

def read_pairs(listfile):
    return [tuple(l.rstrip("\n").split("  ", 1)) for l in open(listfile) if l.strip()]

def write_tar(path, files, extra=None, head=None):
    """files: dict name -> bytes ; ustar, fixed mtime, directories first (as git archive)."""
    with (tarfile.open(path, "w", format=tarfile.PAX_FORMAT, pax_headers={"comment": head}) if head else tarfile.open(path, "w", format=tarfile.USTAR_FORMAT)) as t:
        for d in ("supabase", "supabase/migrations"):
            ti = tarfile.TarInfo(d + "/"); ti.type = tarfile.DIRTYPE; ti.mode = 0o775; ti.mtime = 1761420540; t.addfile(ti)
        for name in sorted(files):
            ti = tarfile.TarInfo("supabase/migrations/" + name); ti.size = len(files[name]); ti.mode = 0o664; ti.mtime = 1761420540
            t.addfile(ti, io.BytesIO(files[name]))
        for n, kind in (extra or []):
            ti = tarfile.TarInfo(n); ti.type = kind; ti.linkname = "/etc/passwd"; ti.mtime = 1761420540; t.addfile(ti)

def write_list(path, files):
    with open(path, "w") as f:
        for name in sorted(files): f.write(f"{sha(files[name])}  {name}\n")

def emit(outdir, files, bundle="migrations-d189768b.tar", lst="MIGRATIONS-d189768b.sha256", extra=None, list_files=None, head=None):
    os.makedirs(outdir, exist_ok=True)
    write_tar(os.path.join(outdir, bundle), files, extra, head)
    write_list(os.path.join(outdir, lst), list_files if list_files is not None else files)
    go34 = {k: v for k, v in (list_files if list_files is not None else files).items() if 213 <= int(k[:4]) <= 246}
    with open(os.path.join(outdir, "go34.txt"), "w") as f:
        for name in sorted(go34): f.write(f"{sha(go34[name])}  {name}\n")
    pins = {"bundle_sha": sha(open(os.path.join(outdir, bundle), "rb").read()), "list_sha": sha(open(os.path.join(outdir, lst), "rb").read())}
    with open(os.path.join(outdir, "pins.env"), "w") as f:
        f.write(f"BUNDLE_SHA={pins['bundle_sha']}\nLIST_SHA={pins['list_sha']}\n")

def load_dir(d, bundle="migrations-d189768b.tar"):
    files = {}
    with tarfile.open(os.path.join(d, bundle)) as t:
        for m in t.getmembers():
            if m.isfile(): files[os.path.basename(m.name)] = t.extractfile(m).read()
    return files

def cmd_copy(a):
    src, dst = a[0], a[1]
    flags = [x for x in a[2:] if x == "--no-platform"]
    rest = [x for x in a[2:] if x != "--no-platform"]
    o = dict(zip(rest[0::2], rest[1::2]))
    lines = open(src).read().split("\n")
    out, changed, in_go = [], [], False
    go34 = open(o["--go34"]).read().rstrip("\n") if "--go34" in o else None
    for l in lines:
        n = l
        if l == "#GO34-BEGIN" and go34 is not None: in_go = True; out.append(l); out.append("GO34='" + go34 + "'"); changed.append("GO34 block"); continue
        if l == "#GO34-END": in_go = False; out.append(l); continue
        if in_go: continue
        for key, flag in (("GO_SHA", "--go-sha"), ("BUNDLE_SHA", "--bundle-sha"), ("LIST_SHA", "--list-sha"), ("REF", "--ref")):
            if l.startswith(key + "="): n = f"{key}={o[flag]}"
        if l.startswith("URL="): n = 'URL="' + o["--url"] + '"'
        if l.startswith("H0214=") and go34 is not None: n = "H0214=" + [x for x in go34.split("\n") if "  0214_" in x][0].split("  ")[0]
        if flags and l.startswith('[ "$(uname -s)" = Darwin ]'): n = "true"
        if n != l: changed.append(n.split("=")[0] if "=" in n else n)
        out.append(n)
    open(dst, "w").write("\n".join(out)); os.chmod(dst, 0o755)
    allowed = {"GO_SHA", "BUNDLE_SHA", "LIST_SHA", "REF", "URL", "H0214", "GO34 block", "true"}
    assert set(changed) <= allowed, f"unexpected rewrite: {set(changed) - allowed}"
    print("test copy rewrites: " + ", ".join(changed))

def cmd_syn(a):
    head = a[a.index("--head") + 1] if "--head" in a else None
    out = a[0]; fail = a[a.index("--fail") + 1] if "--fail" in a else None; slow = a[a.index("--sleep") + 1] if "--sleep" in a else None
    names = [n for _, n in read_pairs(os.path.join(os.path.dirname(os.path.abspath(__file__)), "MIGRATIONS-d189768b.sha256"))]
    files = {}
    for n in names:
        v = int(n[:4])
        if v <= 212: body = b"select 1;\n"
        elif fail and n.startswith(fail): body = b"begin;\nselect 1/0;\ncommit;\n"
        elif slow and n.startswith(slow): body = b"begin;\nselect pg_sleep(30);\ncommit;\n"
        else:
            nap = "select pg_sleep(2);\n" if n[:4] in ("0213", "0229", "0246") else ""   # keeps the CLI alive long enough for the argv sampler
            body = f"begin;\ncreate table public.s1_t{n[:4]} (id int);\n{nap}commit;\n".encode()
        files[n] = body
    emit(out, files, head=head)

def cmd_vary(a):
    src, out, kind = a[0], a[1], a[2]
    files = load_dir(src); lst = dict(files)
    extra = None
    if kind == "tamper": # flip a byte inside the tar AFTER building (pins left stale on purpose)
        emit(out, files); p = os.path.join(out, "migrations-d189768b.tar"); b = bytearray(open(p, "rb").read()); b[2048] ^= 1; open(p, "wb").write(b); return
    if kind == "add247": files["0247_extra.sql"] = b"select 1;\n"; lst = {k: v for k, v in files.items() if not k.startswith("0247")}
    elif kind == "add247-list": files["0247_extra.sql"] = b"select 1;\n"; lst = dict(files)
    elif kind == "drop": lst = dict(files); files.pop(sorted(files)[50])
    elif kind == "alter": k = [n for n in files if n.startswith("0225")][0]; files[k] = files[k] + b"-- altered\n"; lst = dict(files)
    elif kind == "link": extra = [("supabase/migrations/0999_link.sql", tarfile.SYMTYPE)]; lst = dict(files)
    emit(out, files, extra=extra, list_files=lst)

if __name__ == "__main__":
    {"copy": cmd_copy, "syn": cmd_syn, "vary": cmd_vary}[sys.argv[1]](sys.argv[2:])
