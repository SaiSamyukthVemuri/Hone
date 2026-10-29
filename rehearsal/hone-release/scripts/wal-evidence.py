#!/usr/bin/env python3
# hone-release helper: wal-evidence.py. A line-for-line Python port of Machines' wal-evidence.mjs (HON66-PROOF-3, fx3-wal; 33 tests there), so the launcher needs no Node.
# Input: the verbatim bodies of the pinned read helper's `pitr-wal` answer taken TWICE (s1, s2) and the S0a record (the same answer captured at S0a). Output: one verdict
# {PASS|FAIL|CLOSED} as JSON. No network, no database. This is the endpoint-compatible SUBSET of Insurance's A0..A8 rule (PITR-IDLE-RULE-END); it does NOT consult the
# provider horizon or pitr-ready-count. Fail-closed: anything unreadable, unexpected or ambiguous is FAIL or CLOSED, never PASS.
# usage: wal-evidence.py --s1 FILE --s2 FILE --s0a FILE [--max-s0a-age SECONDS]    exit 0 PASS, 1 FAIL, 3 CLOSED, 2 usage
import calendar, json, re, sys, time
COLUMNS = ["db_now_utc", "postmaster_start_utc", "in_recovery", "lsn_write", "lsn_insert", "lsn_flush", "cur_wal_file", "cur_wal_offset", "archived_count", "last_archived_wal", "last_archived_utc", "failed_count", "last_failed_wal", "last_failed_utc", "archiver_stats_reset_utc", "archive_mode", "archive_timeout_s", "wal_level", "checkpoint_timeout", "wal_segment_size", "wal_segment_size_bytes", "next_xid", "xact_commit", "xact_rollback"]
NULLABLE = {"last_archived_wal", "last_archived_utc", "last_failed_wal", "last_failed_utc", "archiver_stats_reset_utc"}
INTS = {"archived_count", "failed_count", "archive_timeout_s", "wal_segment_size_bytes", "xact_commit", "xact_rollback"}
UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$"); LSN = re.compile(r"^[0-9A-F]{1,8}/[0-9A-F]{1,8}$"); WAL = re.compile(r"^[0-9A-F]{24}$")
T_MAX = 1200; N_FLOOR = 600; N_MARGIN = 180; N_MAX = 1800; DEFAULT_MAX_S0A_AGE_S = 1800
SAME = ["postmaster_start_utc", "archiver_stats_reset_utc", "wal_segment_size_bytes", "failed_count", "last_failed_utc", "last_failed_wal", "archived_count", "last_archived_wal", "last_archived_utc", "lsn_write", "lsn_insert", "lsn_flush", "cur_wal_file", "cur_wal_offset"]

def ms(s): return calendar.timegm(time.strptime(s, "%Y-%m-%dT%H:%M:%SZ")) * 1000
def int_of(v):
    if isinstance(v, bool): return None
    if isinstance(v, int): return v
    if isinstance(v, str) and re.fullmatch(r"\d+", v): return int(v)
    return None
def bool_of(v):
    if v is True or v in ("t", "true"): return True
    if v is False or v in ("f", "false"): return False
    return None
def one_row(text):
    try: d = json.loads(text)
    except ValueError: return None, "not JSON"
    if isinstance(d, dict) and "rows" in d: d = d["rows"]
    if not isinstance(d, list) or len(d) != 1 or not isinstance(d[0], dict): return None, "not exactly one row (a JSON array holding one object)"
    return d[0], None
def shape_errors(row):
    e = [("missing column " + k) for k in COLUMNS if k not in row] + [("unexpected column " + k) for k in row if k not in COLUMNS]
    if e: return e
    for k in COLUMNS:
        v = row[k]
        if v is None:
            if k not in NULLABLE: e.append(k + " is null")
            continue
        if k in INTS:
            if int_of(v) is None: e.append(k + " is not a whole number")
            continue
        if k == "in_recovery":
            if bool_of(v) is None: e.append("in_recovery is not a boolean")
            continue
        if not isinstance(v, str) or v == "": e.append(k + " is not a non-empty string"); continue
        if k.endswith("_utc") and not UTC.match(v): e.append(k + " is not a UTC second timestamp")
        if k.startswith("lsn_") and not LSN.match(v): e.append(k + " is not an LSN")
        if k == "cur_wal_file" and not WAL.match(v): e.append("cur_wal_file is not a 24-hex WAL file name")
        if k in ("cur_wal_offset", "next_xid") and not re.fullmatch(r"\d+", v): e.append(k + " is not digits")
    return e
def seg_of(name, seg_bytes):
    if not isinstance(name, str) or not WAL.match(name): return None
    per = 0x100000000 // seg_bytes
    return name[:8], int(name[8:16], 16) * per + int(name[16:], 16)

def evaluate(s1, s2, s0a, max_age):
    checks, closed = [], None
    def add(i, ok, d): checks.append({"id": i, "ok": bool(ok), "detail": d})
    rows = {}
    for name, text in (("s1", s1), ("s2", s2), ("s0a", s0a)):
        if text is None: continue
        r, err = one_row(text)
        if err: add("shape:" + name, False, err); continue
        se = shape_errors(r); add("shape:" + name, not se, "; ".join(se) or "24 columns, types ok")
        if not se: rows[name] = r
    if s0a is None: add("s0a:present", False, "no S0a record supplied: the comparison to S0a cannot be made")
    if "s1" not in rows or "s2" not in rows or (s0a is not None and "s0a" not in rows): return finish(checks, closed)
    a, b, z = rows["s1"], rows["s2"], rows.get("s0a")
    for n, r in (("s1", a), ("s2", b)):
        add("in_recovery:" + n, bool_of(r["in_recovery"]) is False, "a standby has no WAL position of its own")
        add("archive_mode:" + n, r["archive_mode"] in ("on", "always"), "archive_mode=%s" % r["archive_mode"])
        add("wal_level:" + n, r["wal_level"] in ("replica", "logical"), "wal_level=%s" % r["wal_level"])
    T = int_of(a["archive_timeout_s"])
    if not (T is not None and 1 <= T <= T_MAX):
        closed = "archive_timeout=%ss is 0, unknown or above %ds: the idle path is closed" % (a["archive_timeout_s"], T_MAX); add("archive_timeout", False, closed); return finish(checks, closed)
    add("archive_timeout", int_of(b["archive_timeout_s"]) == T, "T=%ds in both samples" % T)
    N = min(N_MAX, max(N_FLOOR, T + N_MARGIN)); gap = (ms(b["db_now_utc"]) - ms(a["db_now_utc"])) / 1000
    add("gap", N <= gap <= N_MAX, "gap=%ss, required %d..%ds (N = max(%d, T+%d))" % (gap, N, N_MAX, N_FLOOR, N_MARGIN))
    for k in SAME: add("unchanged:" + k, str(a[k]) == str(b[k]), "%s -> %s" % (a[k], b[k]))
    add("archiver:not-failing-now", a["last_failed_utc"] is None or (a["last_archived_utc"] is not None and ms(a["last_failed_utc"]) < ms(a["last_archived_utc"])), "last_failed=%s last_archived=%s" % (a["last_failed_utc"], a["last_archived_utc"]))
    seg_bytes = int_of(a["wal_segment_size_bytes"]); cur = seg_of(a["cur_wal_file"], seg_bytes); arch = seg_of(a["last_archived_wal"], seg_bytes)
    if arch is None:
        closed = "last_archived_wal=%s is not a WAL segment (a base-backup label, a history file or nothing): backlog cannot be excluded from these reads" % a["last_archived_wal"]; add("backlog", False, closed)
    else: add("backlog", cur[0] == arch[0] and cur[1] - 1 <= arch[1] <= cur[1], "current segment %d, last archived %d (same timeline %s): nothing completed is waiting" % (cur[1], arch[1], cur[0]))
    if z:
        add("s0a:older", ms(z["db_now_utc"]) < ms(a["db_now_utc"]), "S0a %s < s1 %s" % (z["db_now_utc"], a["db_now_utc"]))
        age = (ms(a["db_now_utc"]) - ms(z["db_now_utc"])) / 1000
        add("s0a:age", 0 <= age <= max_age, "s1 is %ss after the S0a record (limit %ds)" % (age, max_age))
        for k in SAME + ["archive_timeout_s", "archive_mode", "wal_level"]: add("s0a-equal:" + k, str(z[k]) == str(a[k]), "S0a %s vs %s" % (z[k], a[k]))
    return finish(checks, closed)
def finish(checks, closed):
    failed = [c for c in checks if not c["ok"]]
    return {"verdict": "CLOSED" if closed else ("FAIL" if failed else "PASS"), "closed_reason": closed, "failed": [c["id"] for c in failed], "checks": checks}
def main():
    a = sys.argv[1:]
    if len(a) == 2 and a[0] == "--gap-for":   # the gap the first sample requires, or -1 when the path is closed (archive_timeout 0, unknown or above T_MAX)
        r, err = one_row(open(a[1], encoding="utf-8").read()); t = int_of(r.get("archive_timeout_s")) if r else None
        print(min(N_MAX, max(N_FLOOR, t + N_MARGIN)) if t is not None and 1 <= t <= T_MAX else -1); sys.exit(0)
    o = {a[i]: a[i + 1] for i in range(0, len(a) - 1, 2)}
    if "--s1" not in o or "--s2" not in o: sys.stderr.write("usage: wal-evidence.py --s1 F --s2 F --s0a F [--max-s0a-age S]\n"); sys.exit(2)
    rd = lambda p: open(p, encoding="utf-8").read()
    r = evaluate(rd(o["--s1"]), rd(o["--s2"]), rd(o["--s0a"]) if "--s0a" in o and __import__("os").path.exists(o["--s0a"]) else None, int(o.get("--max-s0a-age", DEFAULT_MAX_S0A_AGE_S)))
    print(json.dumps(r)); sys.exit({"PASS": 0, "CLOSED": 3}.get(r["verdict"], 1))
main()
