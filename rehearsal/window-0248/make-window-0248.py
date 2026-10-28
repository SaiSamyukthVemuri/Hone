#!/usr/bin/env python3
"""REHEARSAL - NEVER MERGE. Generator for the two 0248-ONLY window variants (Machines, STAGE-0248-VARIANTS).

  window-s0a-0248.sh     from window-s0a.sh   (ca0450d3, candidate 5)   Mac S0a read, 0248-only stage
  window-s1read-0248.sh  from window-s1read.sh (dc930b6a)                S1 read-back, 0248-only stage

Every change is an exact-once replacement on a base file whose sha256 is pinned below, so the diff against each base is the review artifact
(variants/*/*.diff). Nothing here reaches a database. The hosted history before the stage is 245 rows, max 0246; after it 246 rows, max 0248, 0247
absent (team/STAGE-0247-0250-PACKAGE.md, Resolution D). HEAD_SHA is OPEN until a commit exists whose supabase/migrations is production plus the
sealed 0248 only: the generator writes forty zeros and BOTH the script and the comparator refuse that value.

usage: make-window-0248.py [--head-sha 40hex] [--out DIR]
"""
import argparse, difflib, hashlib, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
ZERO_HEAD = "0" * 40

BASE_PINS = {
    "s0a/window-s0a.sh": "ca0450d34daff4b5",
    "s0a/compare-preflight.mjs": "c9b0f102980104d5",
    "s0a/compare-preflight-lib.mjs": "f0f13c80d91a5d23",
    "s0a/run-window-read-macos.sh": "471ecb9d18116f9b",
    "s0a/g12-0243-intake-definers.sql": "2c852e304c57a019",
    "s0a/s1-open-transactions.sql": "37aef615ead1b88b",
    "s0a/w03-table-sizes.sql": "7c7a1e09ee7d6572",
    "s0a/BASELINE-W1-MACOS-CANDIDATE-5.json": "1b22730afd845aa5",
    "s1read/window-s1read.sh": "dc930b6a0c74ab5a",
    "verify/0248_intake_protected_write_enforcement.sql": "1f6f9ad0026cee66",
    "verify/c01_functions-exist.sql": "3069d3e3d874fc06",
    "verify/c02_function-bodies.sql": "7819e34a397c488e",
}
VERIFY_SHA_WITH_BODIES = "576ff6bc423dcb41cc4464b645abddb240683126763e8c7e105cc7d6fa5cda66"
BODY_MD5 = "48669dd8dba82d0d15984631ea8af739"

def sha_bytes(b): return hashlib.sha256(b).hexdigest()

def read(rel):
    b = open(os.path.join(SRC, rel), "rb").read()
    if rel in BASE_PINS and not sha_bytes(b).startswith(BASE_PINS[rel]):
        sys.exit("base file %s does not match its pinned sha256 (%s...)" % (rel, BASE_PINS[rel]))
    return b

def text(rel): return read(rel).decode("utf-8")

def sub(t, old, new, count=1, what=""):
    n = t.count(old)
    if n != count:
        sys.exit("replacement %r matched %d times, expected %d: %s" % (what or old[:60], n, count, old[:100]))
    return t.replace(old, new)

def line_sub(t, needle, fn, what=""):
    lines = t.split("\n")
    idx = [i for i, l in enumerate(lines) if (l.startswith(needle[1:]) if needle.startswith('^') else needle in l)]
    if len(idx) != 1:
        sys.exit("line needle %r matched %d lines, expected 1 (%s)" % (needle, len(idx), what))
    lines[idx[0]] = fn(lines[idx[0]])
    return "\n".join(lines)

def block_sub(t, start, end, new, what=""):
    i = t.find(start)
    if i < 0 or t.count(start) != 1: sys.exit("block start %r not found exactly once (%s)" % (start[:60], what))
    j = t.find(end, i + len(start))
    if j < 0: sys.exit("block end %r not found (%s)" % (end[:60], what))
    return t[:i] + new + t[j:]

def diff(a, b, name):
    # a REVIEW COPY: trailing whitespace is stripped so the repository's whitespace check passes; it is not meant to be applied with patch
    d = "".join(difflib.unified_diff(a.splitlines(True), b.splitlines(True), "base/" + name, "variant/" + name, n=1))
    lines = [l.rstrip() for l in d.split("\n")]
    while lines and lines[-1] == "": lines.pop()
    return "\n".join(lines) + "\n"

# --------------------------------------------------------------------------------------------------------------------------------------
# SQL files
# --------------------------------------------------------------------------------------------------------------------------------------
G02 = """-- ===========================================================================
-- GATE G2 (0248-ONLY STAGE): live hosted migration history before the 0248 push
-- Derived for the 0248-only stage from g02-history.sql (the 0212/0213 form). Reads supabase_migrations.schema_migrations only.
-- One SELECT. No writes. Counts and version strings only.
--
-- RUN ONLY VIA: run-window-read-macos.sh g02-history-0248.sql (window-s0a-0248.sh does this).
--
-- EXPECTED PASS (every column):
--   applied_count    = 245          (hosted before the stage: 245 rows)
--   hosted_max       = '0246'
--   versions_ge_0247 = 0            (nothing at or above 0247, so 0248 is not applied yet and 0247 is absent)
--   rows_0245        = 1
--   rows_0246        = 1
--   last4            = '0246,0245,0244,0243'
-- STOP CONDITION: any column differs. Do not apply, do not repair history.
-- ===========================================================================
select
  (select count(*) from supabase_migrations.schema_migrations)                          as applied_count,
  (select max(version) from supabase_migrations.schema_migrations)                      as hosted_max,
  (select count(*) from supabase_migrations.schema_migrations where version >= '0247') as versions_ge_0247,
  (select count(*) from supabase_migrations.schema_migrations where version = '0245')   as rows_0245,
  (select count(*) from supabase_migrations.schema_migrations where version = '0246')   as rows_0246,
  (select string_agg(t.version, ',' order by t.version desc)
     from (select m.version from supabase_migrations.schema_migrations m
           order by m.version desc limit 4) t)                                          as last4;
"""

S1_HISTORY = """-- ===========================================================================
-- S1 READ-BACK (0248-ONLY STAGE, window-s1read-0248.sh): live hosted migration history AFTER the 0248 push
-- Derived from s1-history.sql (the 0246 form). Reads supabase_migrations.schema_migrations only. One SELECT. No writes.
-- Counts and version strings only; no identifiers, no table data.
--
-- RUN ONLY VIA: run-window-read-macos.sh s1-history-0248.sql (window-s1read-0248.sh does this).
-- NO chain guard, on purpose: this file IS the history read, and window-s1read-0248.sh checks it before it reads anything else.
--
-- EXPECTED PASS (every column):
--   applied_count                  = 246   (245 before the stage + 0248)
--   hosted_max                     = '0248'
--   rows_0248                      = 1     (0248 present exactly once)
--   rows_0247                      = 0     (0247 absent)
--   versions_ge_0247               = 1     (only 0248 is at or above 0247)
--   versions_above_0248            = 0     (nothing above 0248)
--   versions_0213_0246_once_each   = 34    (the chain below the stage is intact)
-- STOP CONDITION: any column differs. Do not promote. Do not repair history.
-- ===========================================================================
select
  (select count(*) from supabase_migrations.schema_migrations)                          as applied_count,
  (select max(version) from supabase_migrations.schema_migrations)                      as hosted_max,
  (select count(*) from supabase_migrations.schema_migrations where version = '0248')   as rows_0248,
  (select count(*) from supabase_migrations.schema_migrations where version = '0247')   as rows_0247,
  (select count(*) from supabase_migrations.schema_migrations where version >= '0247') as versions_ge_0247,
  (select count(*) from supabase_migrations.schema_migrations where version > '0248')   as versions_above_0248,
  (select count(*) from generate_series(213, 246) g(v)
     where (select count(*) from supabase_migrations.schema_migrations m where m.version = lpad(g.v::text, 4, '0')) = 1) as versions_0213_0246_once_each;
"""

def sibling(rel, name):
    t = text(rel)
    t = sub(t, "= '0212'", "= '0246'", 1, name + " guard value")
    t = sub(t, "at_hosted_0212", "at_hosted_0246", t.count("at_hosted_0212"), name + " guard column")
    head = ("-- 0248-ONLY STAGE SIBLING of %s (derived by make-window-0248.py): the chain guard moved from hosted 0212 to hosted 0246 and its column\n"
            "-- is named at_hosted_0246. Every other line, INCLUDING the comments that describe 0212, is the original text.\n") % os.path.basename(rel)
    return head + t


def g12_preflight():
    """Read-only DRY RUN of the sealed 0248's own preflight (its DO block), so the gate asks the question 0248 will ask, at hosted 0246.
    The offender predicate is a verbatim substring of the sealed file (only the two plpgsql variables are renamed); the rest is a transcription
    of the preceding checks. The 0212-era rule (no callable intake definer at all) is wrong at 0246: the writer is callable by service_role by
    design and the pinned 0216 receptionist command is callable by authenticated."""
    sealed = text("verify/0248_intake_protected_write_enforcement.sql")
    a = sealed.index("    select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace\n    where n.nspname = 'public' and p.prosecdef and p.oid <> v_writer")
    b = sealed.index("  ) then\n    raise exception 'Unexpected callable intake definer requires review.'")
    frag = sealed[a:b]
    if ";" in frag or "--" in frag: sys.exit("the sealed offender predicate holds a semicolon or comment: the runner would refuse it")
    if not frag.startswith("    select 1 from"): sys.exit("offender predicate does not start with its select")
    frag = "    select count(*) from" + frag[len("    select 1 from"):]
    frag = sub(frag, "p.oid <> v_writer", "p.oid <> o.v_writer", 1, "writer ref")
    frag = sub(frag, "p.proowner = v_owner", "p.proowner = o.v_owner", 1, "owner ref")
    if re.search(r"\bv_(writer|owner)\b", frag.replace("o.v_writer", "").replace("o.v_owner", "")): sys.exit("an unrenamed plpgsql variable remains in the offender predicate")
    return """-- ===========================================================================
-- G12 (0248-ONLY STAGE): a read-only DRY RUN of the sealed 0248's own preflight, at hosted 0246
-- Derived for the 0248-only stage; replaces the 0212-era g12 (0243-intake-definers). That rule (no callable intake definer at all) is wrong at 0246:
-- the governed writer is callable by service_role by design and 0216's receptionist command is callable by authenticated, and 0248 exempts exactly those.
-- The offender count below is the sealed 0248's own predicate, copied verbatim (only its two variables are renamed); the other columns transcribe the
-- checks that run before it. One SELECT over pg_catalog and supabase_migrations; no table data.
--
-- RUN ONLY VIA: run-window-read-macos.sh g12-0243-intake-definers-0248.sql (window-s0a-0248.sh does this).
--
-- EXPECTED PASS (every column):
--   at_hosted_0246               = 1      (the chain guard: division by zero unless the hosted history max is 0246)
--   context_ok                   = true   (writer is a search_path-pinned definer, the revision guard is an invoker with the same owner)
--   owner_not_assumable          = true   (no runtime role is, or can SET as, the writer's owner)
--   writer_privileges_ok         = true   (service_role can execute the writer; anon and authenticated cannot; no other or grantable grantee)
--   owner_authority_ok           = true   (the owner can select and update client_intake_forms and clients)
--   unexpected_callable_definers = 0      (no other callable definer reads client_intake_forms, except the pinned receptionist command)
-- STOP CONDITION: any column differs. 0248 is predicted to refuse ("Unexpected callable intake definer requires review." or an unsafe-context error).
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0246'
                   then 1 else 0 end) as at_hosted_0246
),
own as (
  select
    pg_catalog.to_regprocedure('public.write_intake_revision(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.int8,pg_catalog.jsonb,pg_catalog.int4,pg_catalog.text,pg_catalog.jsonb)') as v_writer,
    pg_catalog.to_regprocedure('public.advance_intake_revision()') as v_guard
),
own2 as (
  select o.v_writer, o.v_guard,
         (select p.proowner from pg_catalog.pg_proc p where p.oid = o.v_writer) as v_owner,
         (select r.oid from pg_catalog.pg_roles r where r.rolname = 'service_role') as v_service
  from own o
)
select
  g.at_hosted_0246,
  coalesce(o.v_owner is not null and o.v_service is not null
    and exists (select 1 from pg_catalog.pg_proc p where p.oid = o.v_writer and p.prosecdef and p.proconfig = array['search_path=""']::text[])
    and exists (select 1 from pg_catalog.pg_proc p where p.oid = o.v_guard and not p.prosecdef and p.proowner = o.v_owner and p.proconfig = array['search_path=""']::text[]),
    false) as context_ok,
  coalesce((select count(*) from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')) = 4
    and not exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
      and (r.oid = o.v_owner or pg_catalog.pg_has_role(r.oid, o.v_owner, 'MEMBER') or pg_catalog.pg_has_role(r.oid, o.v_owner, 'SET'))),
    false) as owner_not_assumable,
  coalesce(pg_catalog.has_function_privilege('service_role', o.v_writer, 'EXECUTE')
    and not pg_catalog.has_function_privilege('anon', o.v_writer, 'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated', o.v_writer, 'EXECUTE')
    and not exists (
      select 1 from pg_catalog.pg_proc p,
        lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
      where p.oid = o.v_writer and a.privilege_type = 'EXECUTE'
        and (a.grantee not in (o.v_owner, o.v_service)
           or (a.grantee <> o.v_owner and a.is_grantable))),
    false) as writer_privileges_ok,
  coalesce(pg_catalog.has_table_privilege(o.v_owner, 'public.client_intake_forms', 'SELECT')
    and pg_catalog.has_table_privilege(o.v_owner, 'public.client_intake_forms', 'UPDATE')
    and pg_catalog.has_table_privilege(o.v_owner, 'public.clients', 'SELECT')
    and pg_catalog.has_table_privilege(o.v_owner, 'public.clients', 'UPDATE'),
    false) as owner_authority_ok,
  (
""" + frag + """  ) as unexpected_callable_definers
from chain_guard g, own2 o
"""

# --------------------------------------------------------------------------------------------------------------------------------------
# comparator lib variant
# --------------------------------------------------------------------------------------------------------------------------------------
KEPT = ["g02-history-0248", "g12-0243-intake-definers-0248", "s1-open-transactions-0248", "w03-table-sizes-0248"]
SEALED_0248_SHA = sha_bytes(read("verify/0248_intake_protected_write_enforcement.sql"))

def lib_variant():
    t = text("s0a/compare-preflight-lib.mjs")
    t = block_sub(t, "export const FILES = [", "];\n",
                  "export const FILES = [\n  " + ", ".join('"%s"' % k for k in KEPT) + ",\n", "FILES")
    t = block_sub(t, "export const G2 = {", "\n\n// Check ids.",
                  'export const G2 = { applied_count: 245, hosted_max: "0246", versions_ge_0247: 0, rows_0245: 1, rows_0246: 1,\n  last4: "0246,0245,0244,0243" };',
                  "G2")
    checks = [
        ("S0-1", "G1 project-ref is canonical production and an operator is named", "attest"),
        ("S0-2", "G2 hosted history is exactly 245 / max 0246 / none >= 0247 (0248-only stage)", "data"),
        ("S0-6c", "G12: the sealed 0248 preflight predicts a pass (context, privileges, owner authority, no unexpected callable intake definer)", "data"),
        ("S0-7", "No transaction older than 60 s (s1-open-transactions)", "data"),
        ("S0-14", "Results belong to THIS window: sidecar present, hashes bind, captured inside the window and not older than N minutes", "data"),
        ("S0-W3", "W3: none of the ten tables over 512 MiB; statement_timeout and lock_timeout reported", "data"),
        ("S0-8", "Window outside 07:45-10:00 UTC and holds in place", "attest"),
        ("S0-9", "G3 met at the carrying head: the sealed 0248 sha256", "attest"),
        ("S0-10", "G4 recorded and R-6 answered", "attest"),
        ("S0-12", "No permission refusal recorded (DENIAL files empty)", "attest"),
        ("S0-13", "All 4 files present and readable, none refused or errored, all at hosted 0246", "data"),
    ]
    t = block_sub(t, "export const CHECKS = [", "].map(([id, label, source])",
                  "export const CHECKS = [\n" + "".join('  ["%s", "%s", "%s"],\n' % c for c in checks), "CHECKS")
    t = sub(t, 'export const CHECKSUM_VERSIONS = Array.from({ length: 34 }, (_, i) => String(213 + i).padStart(4, "0"));',
            'export const CHECKSUM_VERSIONS = Array.from({ length: 34 }, (_, i) => String(213 + i).padStart(4, "0"));\n'
            '// The sealed 0248 file, pinned in the comparator so that a baseline cannot launder it (team/STAGE-0247-0250-PACKAGE.md).\n'
            'export const SEALED_0248_SHA = "%s";' % SEALED_0248_SHA, 1, "sealed const")
    # S0-13
    t = block_sub(t, "  // S0-13 file level\n", "\n  res[\"S0-2\"]",
                  '  // S0-13 file level\n  if (fileIssues.length) res["S0-13"] = fail(fileIssues.join("; "));\n  else {\n'
                  '    const notAt = FILES.filter((n) => n !== "g02-history-0248" && parsed[n].some((r) => !numEq(r.at_hosted_0246, 1)));\n'
                  '    res["S0-13"] = notAt.length ? fail(`chain guard value is not 1 in: ${notAt.join(", ")}`) : pass("4 files readable; chain guard is 1 in the 3 files that carry it (g02 has none)");\n  }\n', "S0-13")
    t = sub(t, 'need(["g02-history"], (rows)', 'need(["g02-history-0248"], (rows)', 1, "S0-2 need")
    t = block_sub(t, '  res["S0-6c"] = need(["g12-0243-intake-definers"]', '\n  res["S0-7"]',
                  '  res["S0-6c"] = need(["g12-0243-intake-definers-0248"], (rows) => {\n'
                  '    if (rows.length !== 1) return fail(`expected 1 row, got ${rows.length}`);\n'
                  '    const r = rows[0];\n'
                  '    const bad = [];\n'
                  '    for (const k of ["context_ok", "owner_not_assumable", "writer_privileges_ok", "owner_authority_ok"]) if (!isTrue(r[k])) bad.push(k);\n'
                  '    if (!numEq(r.unexpected_callable_definers, 0)) bad.push("unexpected_callable_definers");\n'
                  '    return bad.length ? fail(`the sealed 0248 preflight is predicted to refuse: ${bad.join(", ")}`) : pass();\n'
                  '  });\n', "S0-6c block")
    t = sub(t, 'need(["s1-open-transactions"], (rows)', 'need(["s1-open-transactions-0248"], (rows)', 1, "S0-7 need")
    t = sub(t, 'need(["w03-table-sizes"], (rows)', 'need(["w03-table-sizes-0248"], (rows)', 1, "W3 need")
    t = sub(t, "all 13 captured inside the window", "all 4 captured inside the window", 1, "S0-14 message")
    s09 = ('  res["S0-9"] = att((a) => {\n'
           '    const g = a.g3, b = baseline && baseline.g3;\n'
           '    if (!g || !b) return fail("g3 attestation or baseline.g3 missing");\n'
           '    if (!hex(b.head_sha, 40) || /^0{40}$/.test(b.head_sha)) return fail("baseline.g3.head_sha is the OPEN placeholder: no carrying commit is pinned yet");\n'
           '    if (!hex(g.head_sha, 40) || g.head_sha !== b.head_sha) return fail("g3.head_sha is not the pinned carrying head (40 hex)");\n'
           '    const got = g.checksums, want = b.checksums;\n'
           '    if (!got || !want || typeof got !== "object" || typeof want !== "object") return fail("g3.checksums or baseline.g3.checksums missing");\n'
           '    if (Object.keys(want).length !== 1 || want["0248"] !== SEALED_0248_SHA) return fail("baseline.g3.checksums is not exactly the sealed 0248 sha256 pinned in the comparator");\n'
           '    if (Object.keys(got).length !== 1 || got["0248"] !== SEALED_0248_SHA) return fail("g3.checksums is not exactly the sealed 0248 sha256");\n'
           '    return pass("0248 checksum equals the sealed file");\n'
           '  });\n')
    t = block_sub(t, '  res["S0-9"] = att((a) => {', '\n  res["S0-10"] = att(', s09, "S0-9")
    # S0-11 (0242 disposition) is DROPPED for the 0248-only stage: 0242 is already hosted (history max 0246) and 0248 never mentions it.
    t = block_sub(t, '  res["S0-11"] = att(', '\n  res["S0-12"] = att(', "", "S0-11")
    return t

# --------------------------------------------------------------------------------------------------------------------------------------
# S0a script variant
# --------------------------------------------------------------------------------------------------------------------------------------
def s0a_script(pins, head):
    base = text("s0a/window-s0a.sh")
    t = base
    t = sub(t, "#!/bin/bash\n", "#!/bin/bash\n"
            "# 0248-ONLY STAGE VARIANT of window-s0a.sh (ca0450d3), generated by make-window-0248.py; the diff against the base is the review artifact.\n"
            "# Hosted history before the stage is 245 rows, max 0246. KEPT: g02 (parameterised), g12, s1-open-transactions, w03 (their chain guard moved from hosted\n"
            "# 0212 to hosted 0246). DROPPED: the census, g06, g07, g09a-d, g10, g11, g11b (S1-range and 0214/0244/payment reads). G3 is the sealed 0248 sha256 at the\n"
            "# carrying head. HEAD_SHA is OPEN until that commit exists: this script refuses to run while it is forty zeros.\n", 1, "banner")
    t = line_sub(t, "capture the 14 manifest-pinned read-only window files",
                 lambda l: "# Hone #1035 WINDOW S0a, 0248-ONLY STAGE (recovery_regime pitr): capture the 4 manifest-pinned read-only window files through the verified runner", "title")
    t = line_sub(t, 'WR="$ROOT/window-reads-c4"', lambda l: 'WR="$ROOT/window-reads-0248"      # the 0248-only variant lives apart from window-reads-c4 (its comparator lib and baseline differ)', "WR")
    t = line_sub(t, "^MANIFEST_SHA=", lambda l: "MANIFEST_SHA=" + pins["s0a_manifest"], "manifest")
    t = line_sub(t, "^LIB_SHA=", lambda l: "LIB_SHA=" + pins["s0a_lib"], "lib")
    t = line_sub(t, "^BASELINE=", lambda l: "BASELINE=BASELINE-W1-0248.json", "baseline name")
    t = line_sub(t, "^BASELINE_SHA=", lambda l: "BASELINE_SHA=" + pins["s0a_baseline"], "baseline sha")
    t = line_sub(t, "^G3_FILE=", lambda l: "G3_FILE=G3-CHECKSUMS-0248.txt", "g3 file")
    t = line_sub(t, "^G3_SHA=", lambda l: "G3_SHA=" + pins["s0a_g3"], "g3 sha")
    t = line_sub(t, "^HEAD_SHA=", lambda l: "HEAD_SHA=" + head, "head")
    t = line_sub(t, "^ask D0242 ", lambda l: "", "S0-11 ask")
    t = line_sub(t, "^ask D0242REF ", lambda l: "", "S0-11 ref ask")
    t = line_sub(t, "  disposition_0242:", lambda l: "", "S0-11 attest field")
    t = sub(t, 'A_D0242="$D0242" A_D0242REF="$D0242REF" ', "", 1, "S0-11 env")
    t = sub(t, "for id in S0-1 S0-8 S0-9 S0-10 S0-11 S0-12; do", "for id in S0-1 S0-8 S0-9 S0-10 S0-12; do", 1, "precheck ids")
    t = sub(t, "Attestation pre-check passed (S0-1, S0-8, S0-9, S0-10, S0-11, S0-12).", "Attestation pre-check passed (S0-1, S0-8, S0-9, S0-10, S0-12).", 1, "precheck msg")
    t = sub(t, "G3, G4, R-6, 0242, denials", "G3, G4, R-6, denials", 1, "precheck comment")
    t = line_sub(t, "^FILES=", lambda l: 'FILES="' + " ".join(k + ".sql" for k in KEPT) + '"', "files")
    t = sub(t, "utcnow() { date -u +%Y-%m-%dT%H:%M:%SZ; }\n",
            "utcnow() { date -u +%Y-%m-%dT%H:%M:%SZ; }\n"
            '[ "$HEAD_SHA" != 0000000000000000000000000000000000000000 ] || die "HEAD_SHA is OPEN: no carrying commit is pinned yet, so G3 cannot be checked; this variant refuses to run until it is set and re-pinned"\n', 1, "head guard")
    t = sub(t, "= 14 ] || die \"MANIFEST.sha256 did not verify exactly 14 gate files\"", "= %d ] || die \"MANIFEST.sha256 did not verify exactly %d gate files\"" % (len(KEPT), len(KEPT)), 1, "manifest count")
    t = line_sub(t, "echo \"G3: the head is the pinned final head",
                 lambda l: 'echo "G3: the head is the pinned carrying head $HEAD_SHA and its one checksum (the sealed 0248 file) comes from the pinned file $G3_FILE (sha256 checked above); the comparator compares it to the sha256 pinned in its own source. Nothing to type." >&2', "g3 echo")
    t = sub(t, 'const want = []; for (let v = 213; v <= 246; v++) want.push(String(v).padStart(4, "0"));', 'const want = ["0248"];', 1, "mk-attest want")
    t = sub(t, 'if (Object.keys(checksums).length !== 34 || want.some((v) => !checksums[v])) { console.error("checksums are not exactly 0213..0246 once each"); process.exit(1); }',
            'if (Object.keys(checksums).length !== 1 || want.some((v) => !checksums[v])) { console.error("checksums are not exactly the one 0248 line"); process.exit(1); }', 1, "mk-attest count")
    t = sub(t, "# Part 2: the 14 files, one at a time", "# Part 2: the %d files, one at a time" % len(KEPT), 1, "part 2")
    t = block_sub(t, '  if [ "$f" = g02-history.sql ]; then', "  n=$((n+1))",
                  '  if [ "$f" = g02-history-0248.sql ]; then\n'
                  '    printf \'%s\' "$c" | grep -Eq \'"applied_count":"?245"?[,}]\' || die "g02: the hosted history is not 245 rows; stopped"\n'
                  '    printf \'%s\' "$c" | grep -q \'"hosted_max":"0246"\' || die "g02: hosted history max is not 0246; the guarded files would refuse; stopped"\n'
                  '    printf \'%s\' "$c" | grep -Eq \'"versions_ge_0247":"?0"?[,}]\' || die "g02: versions at or above 0247 exist; stopped"\n'
                  '  fi\n', "g02 asserts")
    t = sub(t, 'echo "ok $n/14 $f', 'echo "ok $n/%d $f' % len(KEPT), 1, "ok n")
    t = sub(t, '[ "$n" = 14 ] || die "only $n of 14 files completed"', '[ "$n" = %d ] || die "only $n of %d files completed"' % (len(KEPT), len(KEPT)), 1, "n check")
    t = sub(t, "= 28 ] || die \"the results directory does not hold exactly the 14 results and 14 sidecars\"",
            "= %d ] || die \"the results directory does not hold exactly the %d results and %d sidecars\"" % (2 * len(KEPT), len(KEPT), len(KEPT)), 1, "results count")
    t = sub(t, "Captured and validated: 14 results + 14 sidecars (the comparator compares 13; g09d is read by you). Running the comparator.",
            "Captured and validated: %d results + %d sidecars (the comparator compares all %d). Running the comparator." % (len(KEPT), len(KEPT), len(KEPT)), 1, "captured message")
    # nothing of the S1-range stage may remain in the executable text
    return base, t

# --------------------------------------------------------------------------------------------------------------------------------------
# S1 read-back script variant
# --------------------------------------------------------------------------------------------------------------------------------------
def parse_checks_list():
    rows = {}
    for l in text("verify/checks.list").splitlines():
        if not l.strip(): continue
        cid, fn, ssha, esha = l.split("\t")
        rows[cid] = (fn, ssha, esha)
    return rows

def s1read_script(pins):
    base = text("s1read/window-s1read.sh")
    t = base
    chk = parse_checks_list()
    if set(chk) != {"functions-exist", "function-bodies"}: sys.exit("checks.list is not exactly functions-exist and function-bodies")
    for cid, rel in (("functions-exist", "verify/c01_functions-exist.sql"), ("function-bodies", "verify/c02_function-bodies.sql")):
        if sha_bytes(read(rel)) != chk[cid][1]: sys.exit("%s does not hash to the sql sha256 in checks.list" % rel)
    t = sub(t, "#!/bin/bash\n", "#!/bin/bash\n"
            "# 0248-ONLY STAGE VARIANT of window-s1read.sh (dc930b6a), generated by make-window-0248.py; the diff against the base is the review artifact.\n"
            "# History end state: 246 rows, max 0248, 0248 once, 0247 absent, nothing above 0248. The S1 comparator (closures, table privileges, body md5 of\n"
            "# 0213-0246, census) does not apply to 0248 and is NOT used: the stage's own verify bundle checks run instead (verify_sha %s:\n"
            "# functions-exist = 1 and the body md5 of public.advance_intake_revision), each compared by the sha256 of its canonical result, as verify.sh does.\n" % VERIFY_SHA_WITH_BODIES, 1, "banner")
    t = line_sub(t, "# dce26b75, then run the pinned comparator (compare-preflight.mjs --stage s1)",
                 lambda l: "# dce26b75, then check them against the sealed 0248 stage expectations (no comparator).", "comment 4")
    t = line_sub(t, "# object census, privilege closures and replaced function bodies through the verified runner",
                 lambda l: "# 0248 history and the stage's two verify-bundle checks through the verified runner 471ecb9d and supabase-go", "desc line")
    t = line_sub(t, "Exit 0 ONLY after the comparator prints the exact line", lambda l: '# Exit 0 ONLY after this script prints the exact line "OVERALL PASS (0248 read-back ...)". That is read-back evidence; it does not promote.', "exit comment")
    t = line_sub(t, 'WR="$ROOT/window-reads"', lambda l: "", "WR line")
    t = line_sub(t, 'WR1="$ROOT/window-reads-s1"', lambda l: 'WR1="$ROOT/window-reads-s1-0248" # this script, the runner copy, the 0248 gate files and their manifest', "WR1")
    t = line_sub(t, "^MANIFEST_SHA=", lambda l: "MANIFEST_SHA=" + pins["s1_manifest"], "manifest sha")
    for needle in ("^CMP_SHA=", "^LIB_SHA=", "^BASELINE=", "^BASELINE_SHA="):
        t = line_sub(t, needle, lambda l: "", needle)
    t = line_sub(t, "^FILES=", lambda l: 'FILES="s1-history-0248.sql c01_functions-exist.sql c02_function-bodies.sql"', "files")
    t = line_sub(t, "^NFILES=", lambda l: "NFILES=3", "nfiles")
    for needle in ('[ -f "$WR/compare-preflight.mjs"', '[ -f "$WR/compare-preflight-lib.mjs"', '[ -f "$WR/$BASELINE"'):
        t = line_sub(t, needle, lambda l: "", needle)
    t = line_sub(t, "the comparator needs Node 18 or newer", lambda l: l.replace("the comparator needs Node 18 or newer", "the check needs Node 18 or newer"), "node msg")
    t = sub(t, "# Part 1: the six files,", "# Part 1: the three files,", 1, "part 1")
    t = sub(t, "(division by zero means the history max is not 0246)", "(a refusal or an invalid result)", 1, "guard message")
    t = block_sub(t, "  if [ \"$f\" = s1-history.sql ]; then", "  n=$((n+1))",
                  '  if [ "$f" = s1-history-0248.sql ]; then\n'
                  '    # The history is read FIRST. If it is not exactly the 0248 end state, nothing else is read.\n'
                  '    printf \'%s\' "$c" | grep -Eq \'"applied_count":"?246"?[,}]\' && printf \'%s\' "$c" | grep -q \'"hosted_max":"0248"\' \\\n'
                  '      && printf \'%s\' "$c" | grep -Eq \'"rows_0248":"?1"?[,}]\' && printf \'%s\' "$c" | grep -Eq \'"rows_0247":"?0"?[,}]\' \\\n'
                  '      && printf \'%s\' "$c" | grep -Eq \'"versions_ge_0247":"?1"?[,}]\' && printf \'%s\' "$c" | grep -Eq \'"versions_above_0248":"?0"?[,}]\' \\\n'
                  '      && printf \'%s\' "$c" | grep -Eq \'"versions_0213_0246_once_each":"?34"?[,}]\' \\\n'
                  '      || die "s1-history: the history is not exactly 246 rows, max 0248, 0248 once, 0247 absent, nothing above 0248, 0213..0246 once each. The 0248 stage did not reach its end state. Do NOT promote. Nothing else was read; report this result: $r"\n'
                  '  fi\n', "history asserts")
    t = sub(t, "Assembling the read-back and running the comparator.", "Checking them against the sealed 0248 stage expectations.", 1, "assembling message")
    part2 = '''# ---------------------------------------------------------------------------------------------------------
# Part 2: the 0248 stage expectations, from the stage's own verify bundle (verify_sha %(vsha)s), then the verdict.
# Each check is compared by the sha256 of its canonical result (sorted keys, no whitespace), exactly as verify.sh does. Exit 0 ONLY on the exact line.
# ---------------------------------------------------------------------------------------------------------
cat > "$TMPD/check-0248.mjs" <<'NODE'
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const e = process.env;
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
const rows = (f) => { const j = JSON.parse(readFileSync(`${e.A_RES}/${f}.json`, "utf8")); if (!Array.isArray(j) || !j.length || j.some((r) => !r || typeof r !== "object" || Array.isArray(r))) fail(`${f}: not a non-empty array of objects`); return j; };
const canon = (v) => (Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v));
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const num = (v, n) => (typeof v === "number" ? v === n : typeof v === "string" && /^-?\\d+$/.test(v) && Number(v) === n);
const EXPECT = { functions_exist: "%(e1)s", function_bodies: "%(e2)s" };
const BODY_MD5 = "%(md5)s";
const h = rows("s1-history-0248");
if (h.length !== 1) fail("s1-history-0248: not exactly one row");
const r = h[0];
if (!(num(r.applied_count, 246) && r.hosted_max === "0248" && num(r.rows_0248, 1) && num(r.rows_0247, 0) && num(r.versions_ge_0247, 1) && num(r.versions_above_0248, 0) && num(r.versions_0213_0246_once_each, 34))) fail("history is not 246 / 0248 / 0248 once / 0247 absent / nothing above / 34 below");
console.log("PASS history: 246 rows, max 0248, 0248 once, 0247 absent, nothing above 0248, 0213..0246 once each");
const c1 = rows("c01_functions-exist");
if (sha(canon(c1)) !== EXPECT.functions_exist) fail(`c01 functions-exist: result sha256 ${sha(canon(c1))} is not the bundle's ${EXPECT.functions_exist}`);
console.log("PASS functions-exist: result sha256 equals the verify bundle's (public.advance_intake_revision exists once)");
const c2 = rows("c02_function-bodies");
if (sha(canon(c2)) !== EXPECT.function_bodies) fail(`c02 function-bodies: result sha256 ${sha(canon(c2))} is not the bundle's ${EXPECT.function_bodies}`);
if (c2.length !== 1 || c2[0].proname !== "advance_intake_revision" || c2[0].md5 !== BODY_MD5) fail("c02: the body md5 of public.advance_intake_revision is not the sealed one");
console.log("PASS function-bodies: result sha256 equals the verify bundle's; body md5 of public.advance_intake_revision is " + BODY_MD5);
console.log("");
console.log("OVERALL PASS (0248 read-back: history and 2 verify-bundle checks; read-only, not a promotion)");
NODE
VERDICT="$WORK/verdict.txt"
crc=0
A_RES="$RES" node "$TMPD/check-0248.mjs" </dev/null >"$VERDICT" 2>&1 || crc=$?
cat "$VERDICT"
T_END=$(utcnow)
echo "S1 read-back started $T_START and finished $T_END (UTC): record both." >&2
if [ "$crc" = 0 ] && grep -Fxq 'OVERALL PASS (0248 read-back: history and 2 verify-bundle checks; read-only, not a promotion)' "$VERDICT"; then
  echo "WINDOW S1 READ-BACK (0248): OVERALL PASS. Results and verdict are in $WORK" >&2
  echo "This is read-only evidence that the 0248 stage reached its end state. It does not promote anything." >&2
  exit 0
fi
die "the 0248 read-back did not pass (exit $crc). Do NOT promote. Evidence is in $WORK"
''' % {"vsha": VERIFY_SHA_WITH_BODIES, "e1": chk["functions-exist"][2], "e2": chk["function-bodies"][2], "md5": BODY_MD5}
    marker = "# ---------------------------------------------------------------------------------------------------------\n# Part 2: assemble the --readback JSON"
    i = t.find(marker)
    if i < 0 or t.count(marker) != 1: sys.exit("part 2 marker not found exactly once")
    t = t[:i] + part2
    return base, t

# --------------------------------------------------------------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--head-sha", default=ZERO_HEAD)
    ap.add_argument("--out", default=os.path.join(HERE, "variants"))
    a = ap.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", a.head_sha): sys.exit("--head-sha must be 40 lowercase hex")
    out = a.out
    files = {}
    runner = read("s0a/run-window-read-macos.sh")
    # ---- S0a directory
    sql = {"g02-history-0248.sql": G02,
           "g12-0243-intake-definers-0248.sql": g12_preflight(),
           "s1-open-transactions-0248.sql": sibling("s0a/s1-open-transactions.sql", "s1-open-transactions"),
           "w03-table-sizes-0248.sql": sibling("s0a/w03-table-sizes.sql", "w03")}
    for n, body in sql.items(): files["s0a/" + n] = body.encode()
    manifest = "".join("%s  %s\n" % (sha_bytes(files["s0a/" + n]), n) for n in sql)
    files["s0a/MANIFEST.sha256"] = manifest.encode()
    lib = lib_variant()
    files["s0a/compare-preflight-lib.mjs"] = lib.encode()
    files["s0a/compare-preflight.mjs"] = read("s0a/compare-preflight.mjs")
    files["s0a/run-window-read-macos.sh"] = runner
    g3 = "%s  0248_intake_protected_write_enforcement.sql\n" % SEALED_0248_SHA
    files["s0a/G3-CHECKSUMS-0248.txt"] = g3.encode()
    b = json.loads(text("s0a/BASELINE-W1-MACOS-CANDIDATE-5.json"))
    for k in ("g09", "g11_rule", "s1", "_sources", "_decisions", "_candidate"): b.pop(k, None)
    b["_candidate"] = "0248-ONLY STAGE baseline derived from W1 candidate 5 by make-window-0248.py: the PITR, recovery, window and project-ref pins are unchanged; the 1035 g09, g11 and s1 sections are dropped; g3 is the sealed 0248 file at the carrying head (OPEN while the head is forty zeros)."
    b["manifest_sha256"] = sha_bytes(files["s0a/MANIFEST.sha256"])
    b["g3"] = {"head_sha": a.head_sha, "checksums": {"0248": SEALED_0248_SHA}}
    b["required_checks"] = []
    b["_decisions"] = [
        "planned_duration_minutes is unchanged from candidate 5 (110): it is OPS's number and only requires that much of the window remain; OPS may lower it for a one-file stage.",
        "S0-11 (0242 disposition) is DROPPED (OPS ruling on Team's recommendation, after re-reading its original reason): it gated S1 (apply 0213-0246), because 0242 revokes member INSERT on audit_logs and breaks the old app's archive/unarchive audit write (ROLLOUT-0213-0246-DECISION-PACKAGE, 0242 row, T-0242-1, R-3). Hosted history is already at 0246, so that apply is done; 0248 never mentions 0242 and replaces only advance_intake_revision(). Keep S0-11 for any stage that carries 0247 or later.",
        "g10 is DROPPED: its seven names are 0213-0246 constraints, not the intake table or its trigger; Team's table marked it keep-if-defined and no such definition exists.",
    ]
    files["s0a/BASELINE-W1-0248.json"] = (json.dumps(b, indent=2) + "\n").encode()
    pins = {"s0a_manifest": sha_bytes(files["s0a/MANIFEST.sha256"]), "s0a_lib": sha_bytes(files["s0a/compare-preflight-lib.mjs"]),
            "s0a_baseline": sha_bytes(files["s0a/BASELINE-W1-0248.json"]), "s0a_g3": sha_bytes(files["s0a/G3-CHECKSUMS-0248.txt"])}
    base, s0a = s0a_script(pins, a.head_sha)
    files["s0a/window-s0a-0248.sh"] = s0a.encode()
    files["s0a/window-s0a-0248.diff"] = diff(base, s0a, "window-s0a.sh").encode()
    files["s0a/compare-preflight-lib-0248.diff"] = diff(text("s0a/compare-preflight-lib.mjs"), lib, "compare-preflight-lib.mjs").encode()
    # ---- S1 read-back directory
    s1sql = {"s1-history-0248.sql": S1_HISTORY,
             "c01_functions-exist.sql": text("verify/c01_functions-exist.sql"),
             "c02_function-bodies.sql": text("verify/c02_function-bodies.sql")}
    for n, body in s1sql.items(): files["s1read/" + n] = body.encode()
    files["s1read/MANIFEST.sha256"] = "".join("%s  %s\n" % (sha_bytes(files["s1read/" + n]), n) for n in s1sql).encode()
    files["s1read/run-window-read-macos.sh"] = runner
    base1, s1 = s1read_script({"s1_manifest": sha_bytes(files["s1read/MANIFEST.sha256"])})
    files["s1read/window-s1read-0248.sh"] = s1.encode()
    files["s1read/window-s1read-0248.diff"] = diff(base1, s1, "window-s1read.sh").encode()
    pinsout = {k: sha_bytes(v) for k, v in sorted(files.items()) if not k.endswith(".diff")}
    files["SHAS.json"] = (json.dumps({"head_sha": a.head_sha, "verify_sha_with_bodies": VERIFY_SHA_WITH_BODIES, "sealed_0248_sha256": SEALED_0248_SHA, "files": pinsout}, indent=2) + "\n").encode()
    for rel, body in files.items():
        p = os.path.join(out, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "wb").write(body)
        if rel.endswith(".sh"): os.chmod(p, 0o755)
    print("generated %d files under %s (head_sha %s)" % (len(files), out, a.head_sha))

if __name__ == "__main__":
    main()
