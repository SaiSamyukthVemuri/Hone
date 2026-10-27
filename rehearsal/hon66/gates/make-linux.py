#!/usr/bin/env python3
"""HON66: derive the Linux variants of the reviewed Mac gate scripts by a FIXED list of substitutions (every one asserted to occur the
stated number of times, so a changed Mac script cannot be ported silently). The Mac scripts are read from their reviewed locations
and never edited. Output: ./<name>-linux.sh, ./LINUX-DIFFS.txt, ./BASELINE-W1-LINUX-CANDIDATE-5.json (written by the second half).
usage: make-linux.py   (from machines/linux-gates)"""
import difflib, hashlib, json, os, re, sys
M = "/home/sam/hone-handoffs/2026-10-18/machines/"
LINUX_GO_SHA = "174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c"      # supabase 2.102.0 linux_amd64 inner binary (checksum-verified archive)
LINUX_RUNNER_SHA = "ec9b7c568a69d3b776ee9c643bcb52eb567639ab9cb0c995b33f59cf6d974468"  # run-window-read.sh, the ORIGINAL Linux runner, unchanged
MAC_GO_SHA = "dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b"
MAC_RUNNER_SHA = "471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357"
sha = lambda b: hashlib.sha256(b).hexdigest()

OSGATE_OLD = '[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "not macOS arm64"'
OSGATE_NEW = '[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || die "not Linux x86_64 (the pinned supabase-go is linux_amd64)"'

SECRET_HELPER = r'''
# The PAT arrives on FILE DESCRIPTOR 3, opened by hone-release (root-owned custody layer); it is never a file this script opens, never an
# argument, never in the environment. There is no database-password input: reads use a FIXED, NON-SECRET placeholder only so that the
# CLI never creates a login role (HON66-PROOF M9; the CI proves the read path never authenticates with it).
READ_PW_PLACEHOLDER="hone-read-placeholder-not-a-secret"
# secret_from_fd3 VAR LABEL: exactly one non-empty line of at most 4096 bytes on fd 3, then fd 3 is closed. Nothing is printed.
secret_from_fd3() {
  local _v="" _x="" _l="$2"
  { true <&3; } 2>/dev/null || die "fd 3 is not open (hone-release passes the $_l on fd 3)"
  IFS= read -r -n 4097 <&3 _v || [ -n "$_v" ] || die "could not read the $_l from fd 3"
  if IFS= read -r -t 1 -n 1 _x <&3; then die "fd 3 holds more than one line or more than 4096 bytes"; fi
  exec 3<&-
  [ -n "$_v" ] || die "the $_l on fd 3 is empty"
  [ "${#_v}" -le 4096 ] || die "the $_l on fd 3 is longer than 4096 bytes"
  printf -v "$1" '%s' "$_v"
}
'''

SHIM = r'''
# The ORIGINAL Linux runner (run-window-read.sh, unchanged) calls `npx --yes supabase@2.102.0 db query ...`, which would download and run
# unverified bytes. This shim is first on PATH for that one child: it accepts ONLY that exact invocation, requires a non-empty database
# password (the password-present rule that prevents the CLI's hosted login-role write), re-checks the pinned supabase-go sha256 and execs it.
SHIM="$WORK/shim"; mkdir -p "$SHIM" && chmod 700 "$SHIM" || die "mkdir shim failed"
cat > "$SHIM/npx" <<'SHIMEOF'
#!/bin/bash
GO_SHA=@GO_SHA@
[ "$#" -eq 9 ] && [ "$1" = --yes ] && [ "$2" = supabase@2.102.0 ] && [ "$3" = db ] && [ "$4" = query ] && [ "$5" = --linked ] && [ "$6" = -o ] && [ "$7" = json ] && [ "$8" = -f ] || { echo "npx shim: REFUSED: not the reviewed db query invocation" >&2; exit 97; }
[ -n "${SUPABASE_DB_PASSWORD:-}" ] || { echo "npx shim: REFUSED: no database password (it would let the CLI create a login role)" >&2; exit 97; }
[ -n "${HONE_SUPABASE_BIN:-}" ] && [ -f "$HONE_SUPABASE_BIN" ] && [ "$(sha256sum "$HONE_SUPABASE_BIN" | cut -d' ' -f1)" = "$GO_SHA" ] || { echo "npx shim: REFUSED: supabase-go missing or sha256 mismatch" >&2; exit 97; }
exec env -u GITHUB_TOKEN -u GH_TOKEN "$HONE_SUPABASE_BIN" --agent no db query --linked -o json -f "$9"
SHIMEOF
sed -i "s/@GO_SHA@/$GO_SHA/" "$SHIM/npx" && chmod 700 "$SHIM/npx" || die "shim write failed"
'''

def count(s, old, n, label):
    c = s.count(old)
    if c != n:
        sys.exit(f"{label}: expected {n} occurrence(s) of {old[:70]!r}, found {c} (the Mac script changed: review before porting)")

def common(s, name, creds):
    """creds: list of (VAR, ENVNAME, LABEL) read from files; the matching prompts are removed."""
    s = s.replace("#!/bin/bash\n", "#!/bin/bash\n# LINUX VARIANT of the reviewed Mac script (HON66-LINUX-GATES), derived by machines/linux-gates/make-linux.py with a fixed substitution\n# list (see LINUX-DIFFS.txt). The PAT arrives on fd 3 from hone-release; no database password is read (fixed non-secret placeholder); nothing is prompted or on argv.\n", 1)
    count(s, OSGATE_OLD, 1, name); s = s.replace(OSGATE_OLD, OSGATE_NEW)
    if MAC_GO_SHA in s:
        count(s, MAC_GO_SHA, 1, name); s = s.replace(MAC_GO_SHA, LINUX_GO_SHA)
    count(s, "sha() { shasum -a 256 -- \"$1\" | cut -d' ' -f1; }", 1, name)
    s = s.replace("sha() { shasum -a 256 -- \"$1\" | cut -d' ' -f1; }", "sha() { sha256sum -- \"$1\" | cut -d' ' -f1; }")
    s = s.replace('command -v shasum >/dev/null 2>&1 || die "shasum not found"', 'command -v sha256sum >/dev/null 2>&1 || die "sha256sum not found"')
    s = s.replace("shasum -a 256 -c MANIFEST.sha256", "sha256sum -c MANIFEST.sha256")
    s = s.replace("(run the Mac check first)", "(run the installer check first)")
    s = s.replace("Credentials are typed privately (never echoed, never on a command line, never written)", "The PAT arrives on fd 3 from hone-release (never printed, never on a command line, never written)")
    s = s.replace("The token is typed privately (never echoed, never on a command", "The PAT arrives on fd 3 from hone-release (never printed, never on a command")
    s = s.replace("typed privately (never echoed, never on a command line, never written)", "received on fd 3 (never printed, never on a command line, never written)")
    s = s.replace("Nothing is typed except the two hidden credentials.", "The PAT arrives on fd 3; nothing is typed.")
    s = s.replace("stat -f '%u %Lp'", "stat -c '%u %a'").replace("stat -f '%u'", "stat -c '%u'")
    for var, envn, label in creds:
        pat = re.compile(r'IFS= read -rs -p "[^"]*" ' + re.escape(var) + r' </dev/tty \|\| die "[^"]*"\necho >&2\n')
        assert len(pat.findall(s)) == 1, f"{name}: prompt for {var}"
        s = pat.sub((f'secret_from_fd3 {var} "{label}"\n' if envn == "HONE_GATE_TOKEN_FILE" else f'{var}="$READ_PW_PLACEHOLDER"\n'), s)
    return s

def insert_helper(s, name):
    anchor = "cleanup() {"
    count(s, anchor, 1, name)
    i = s.index(anchor)
    return s[:i] + SECRET_HELPER.lstrip("\n") + "\n" + s[i:]

def drop_tty_check(s, name):
    for old in ('[ -r /dev/tty ] || die "no terminal for private entry"\n',):
        count(s, old, 1, name); s = s.replace(old, "")
    return s

def runner(s, name, where):
    old = f'/bin/bash "{where}/run-window-read-macos.sh"'
    count(s, old, 1, name)
    s = s.replace('SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 ' + old, 'SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 PATH="$SHIM:$PATH" ' + old.replace("run-window-read-macos.sh", "run-window-read.sh"))
    count(s, 'PATH="$SHIM:$PATH"', 1, name)
    s = s.replace("run-window-read-macos.sh", "run-window-read.sh")
    s = s.replace(MAC_RUNNER_SHA, LINUX_RUNNER_SHA)
    # the shim is written once WORK exists (right after the private work directory is created)
    m = re.search(r'chmod 700 "\$WORK" \|\| die "chmod failed"\n', s)
    assert m, name
    s = s[:m.end()] + SHIM + s[m.end():]
    return s

OUT = {}
def cf(s):   # comment lines only: the Mac short shas in prose become the Linux ones (the full constants are replaced elsewhere)
    return "\n".join((l.replace("dce26b75", "174a90e2").replace("471ecb9d", "ec9b7c56") if l.startswith("#") else l) for l in s.split("\n"))
def build():
    # ---------------- window-s0a (c5) ----------------
    n = "window-s0a"; s = open(M + "window-reads-c4/window-s0a.sh").read()
    s = common(s, n, [("SUPABASE_ACCESS_TOKEN", "HONE_GATE_TOKEN_FILE", "access token"), ("SUPABASE_DB_PASSWORD", "HONE_GATE_PASSWORD_FILE", "database password")])
    s = insert_helper(s, n); s = runner(s, n, "$WR")
    s = s.replace("BASELINE=BASELINE-W1-MACOS-CANDIDATE-5.json", "BASELINE=BASELINE-W1-LINUX-CANDIDATE-5.json")
    count(s, "BASELINE_SHA=1b22730afd845aa50358a4fe3fb5f68aa36d22293329c7d16ba2effce7a50d82", 1, n)   # re-pinned below
    OUT[n] = cf(s)
    # ---------------- window-row4 (c5) ----------------
    n = "window-row4"; s = open(M + "window-reads-c4/window-row4.sh").read()
    s = common(s, n, [])
    s = s.replace("BASELINE=BASELINE-W1-MACOS-CANDIDATE-5.json", "BASELINE=BASELINE-W1-LINUX-CANDIDATE-5.json")
    count(s, "BASELINE_SHA=1b22730afd845aa50358a4fe3fb5f68aa36d22293329c7d16ba2effce7a50d82", 1, n)
    OUT[n] = cf(s)
    # ---------------- window-s1read ----------------
    n = "window-s1read"; s = open(M + "window-reads-s1/window-s1read.sh").read()
    s = common(s, n, [("SUPABASE_ACCESS_TOKEN", "HONE_GATE_TOKEN_FILE", "access token"), ("SUPABASE_DB_PASSWORD", "HONE_GATE_PASSWORD_FILE", "database password")])
    s = insert_helper(s, n); s = drop_tty_check(s, n); s = runner(s, n, "$WR1")
    s = s.replace("BASELINE=BASELINE-W1-MACOS-CANDIDATE-3.json", "BASELINE=BASELINE-W1-LINUX-CANDIDATE-3.json")
    OUT[n] = cf(s)
    # ---------------- pitr-backups ----------------
    n = "pitr-backups"; s = open(M + "pitr-status/pitr-backups.sh").read()
    s = common(s, n, [("tok", "HONE_GATE_TOKEN_FILE", "access token")])
    s = insert_helper(s, n); s = drop_tty_check(s, n)
    OUT[n] = cf(s)
    # ---------------- gap read ----------------
    n = "window-gap-read"; s = open(M + "window-gap-read/window-gap-read.sh").read()
    s = common(s, n, [("SUPABASE_ACCESS_TOKEN", "HONE_GATE_TOKEN_FILE", "access token"), ("SUPABASE_DB_PASSWORD", "HONE_GATE_PASSWORD_FILE", "database password")])
    s = insert_helper(s, n); s = drop_tty_check(s, n); s = runner(s, n, "$GR")
    OUT[n] = cf(s)
build()

# ---------------- baselines: the Mac baselines with ONLY the platform pins changed (text edit, formatting untouched) ----------------
def baseline(src, dst, pitr_linux_sha):
    t = open(M + src).read()
    n_runner = t.count(MAC_RUNNER_SHA); n_go = t.count(MAC_GO_SHA); n_pitr = t.count("85407d0b01d11497161c1c9d0374751ecaec80faed9609f2d4f073d71fe49413")
    t = t.replace(MAC_RUNNER_SHA, LINUX_RUNNER_SHA).replace(MAC_GO_SHA, LINUX_GO_SHA)
    t = t.replace("85407d0b01d11497161c1c9d0374751ecaec80faed9609f2d4f073d71fe49413", pitr_linux_sha)
    return dst, t, (n_runner, n_go, n_pitr)

if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    # pitr-backups first (its sha is pinned in the c5 baseline)
    pb = OUT["pitr-backups"]; pb_sha = sha(pb.encode())
    b5 = baseline("window-reads-c4/BASELINE-W1-MACOS-CANDIDATE-5.json", "BASELINE-W1-LINUX-CANDIDATE-5.json", pb_sha)
    b3 = baseline("window-reads/BASELINE-W1-MACOS-CANDIDATE-3.json", "BASELINE-W1-LINUX-CANDIDATE-3.json", pb_sha)
    shas = {b5[0]: sha(b5[1].encode()), b3[0]: sha(b3[1].encode())}
    # re-pin the baseline sha constants in the scripts that load them
    def repin(s, old_sha, new_name_sha):
        assert s.count(old_sha) == 1, old_sha
        return s.replace(old_sha, new_name_sha)
    OUT["window-s0a"] = repin(OUT["window-s0a"], "1b22730afd845aa50358a4fe3fb5f68aa36d22293329c7d16ba2effce7a50d82", shas["BASELINE-W1-LINUX-CANDIDATE-5.json"])
    OUT["window-row4"] = repin(OUT["window-row4"], "1b22730afd845aa50358a4fe3fb5f68aa36d22293329c7d16ba2effce7a50d82", shas["BASELINE-W1-LINUX-CANDIDATE-5.json"])
    OUT["window-s1read"] = repin(OUT["window-s1read"], "efc94a51f02bd2116a806229c8910b9ac48c2e5da6c0ff6556a3671e957301dd", shas["BASELINE-W1-LINUX-CANDIDATE-3.json"])
    diffs = []; report = {}
    srcs = {"window-s0a": "window-reads-c4/window-s0a.sh", "window-row4": "window-reads-c4/window-row4.sh", "window-s1read": "window-reads-s1/window-s1read.sh",
            "pitr-backups": "pitr-status/pitr-backups.sh", "window-gap-read": "window-gap-read/window-gap-read.sh"}
    for n, s in OUT.items():
        if n == "pitr-backups":
            assert sha(s.encode()) == pb_sha
        fn = f"{n}-linux.sh"
        open(os.path.join(here, fn), "w").write(s); os.chmod(os.path.join(here, fn), 0o755)
        mac = open(M + srcs[n]).read()
        diffs.append("".join(difflib.unified_diff(mac.splitlines(1), s.splitlines(1), f"mac/{srcs[n]}", f"linux/{fn}", n=0)))
        report[fn] = sha(s.encode())
    for dst, t, cnt in (b5, b3):
        open(os.path.join(here, dst), "w").write(t); report[dst] = sha(t.encode())
    open(os.path.join(here, "LINUX-DIFFS.txt"), "w").write("\n".join(diffs))
    json.dump(report, open(os.path.join(here, "SHAS.json"), "w"), indent=2)
    print(json.dumps(report, indent=2))
    print("baseline replacements (runner, go, pitr script):", b5[2], b3[2])
