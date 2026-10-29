#!/usr/bin/env python3
# REHEARSAL - NEVER MERGE. Unit tests of scripts/wal-evidence.py (the Python port of Machines' wal-evidence.mjs): every rule as a PASS case and a FAIL/CLOSED mutant.
import copy, importlib.util, json, os, sys, time
here = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(here, "..", "scripts", "wal-evidence.py")).read().replace("\nmain()\n", "\n")
ns = {"__name__": "wal_evidence"}; exec(compile(src, "wal-evidence.py", "exec"), ns)
ev = ns["evaluate"]
def iso(t): return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
T0 = 1_800_000_000
BASE = {"db_now_utc": iso(T0), "postmaster_start_utc": iso(T0 - 9999), "in_recovery": False, "lsn_write": "0/5000100", "lsn_insert": "0/5000100", "lsn_flush": "0/5000100", "cur_wal_file": "000000010000000000000005", "cur_wal_offset": "256",
        "archived_count": 5, "last_archived_wal": "000000010000000000000005", "last_archived_utc": iso(T0 - 400), "failed_count": 0, "last_failed_wal": None, "last_failed_utc": None, "archiver_stats_reset_utc": iso(T0 - 9999),
        "archive_mode": "on", "archive_timeout_s": 60, "wal_level": "replica", "checkpoint_timeout": "5min", "wal_segment_size": "16MB", "wal_segment_size_bytes": 16777216, "next_xid": "1000", "xact_commit": 10, "xact_rollback": 0}
def rowj(**kw): r = copy.deepcopy(BASE); r.update(kw); return json.dumps([r])
def trio(gap=700, s2=None, s0a=None, s1=None):
    a = rowj(**(s1 or {})); b = rowj(db_now_utc=iso(T0 + gap), **(s2 or {})); z = rowj(db_now_utc=iso(T0 - 300), **(s0a or {})); return a, b, z
fails = 0
def case(name, want, a, b, z):
    global fails
    got = ev(a, b, z, 1800)["verdict"]
    print(("ok   - " if got == want else "FAIL - ") + "%s (want %s, got %s)" % (name, want, got)); fails += got != want
case("two equal samples N apart, equal to the S0a record, archiver healthy", "PASS", *trio())
case("gap shorter than max(600, T+180)", "FAIL", *trio(gap=300))
case("gap longer than 1800 s", "FAIL", *trio(gap=2000))
case("the LSN moved between the samples", "FAIL", *trio(s2={"lsn_write": "0/5000200"}))
case("archived_count moved", "FAIL", *trio(s2={"archived_count": 6}))
case("the server restarted between the samples", "FAIL", *trio(s2={"postmaster_start_utc": iso(T0 + 100)}))
case("a standby (in_recovery true)", "FAIL", *trio(s1={"in_recovery": True}, s2={"in_recovery": True}))
case("archive_mode off", "FAIL", *trio(s1={"archive_mode": "off"}, s2={"archive_mode": "off"}))
case("wal_level minimal", "FAIL", *trio(s1={"wal_level": "minimal"}, s2={"wal_level": "minimal"}))
case("archive_timeout 0 closes the path", "CLOSED", *trio(s1={"archive_timeout_s": 0}, s2={"archive_timeout_s": 0}))
case("archive_timeout above 1200 closes the path", "CLOSED", *trio(s1={"archive_timeout_s": 3000}, s2={"archive_timeout_s": 3000}))
case("a backlog: the last archived segment is two behind the current one", "FAIL", *trio(s1={"last_archived_wal": "000000010000000000000003"}, s2={"last_archived_wal": "000000010000000000000003"}, s0a={"last_archived_wal": "000000010000000000000003"}))
case("last archived item is not a WAL segment (a label) closes the path", "CLOSED", *trio(s1={"last_archived_wal": "00000001000000000000000A.00000028.backup"}, s2={"last_archived_wal": "00000001000000000000000A.00000028.backup"}, s0a={"last_archived_wal": "00000001000000000000000A.00000028.backup"}))
case("the archiver failed after its last success", "FAIL", *trio(s1={"last_failed_utc": iso(T0 - 100), "last_failed_wal": "000000010000000000000005", "failed_count": 1}, s2={"last_failed_utc": iso(T0 - 100), "last_failed_wal": "000000010000000000000005", "failed_count": 1}, s0a={"last_failed_utc": iso(T0 - 100), "last_failed_wal": "000000010000000000000005", "failed_count": 1}))
case("the S0a record differs (another WAL position)", "FAIL", *trio(s0a={"lsn_write": "0/4000000"}))
case("no S0a record at all", "FAIL", *trio()[:2], None)
case("the S0a record is not older than the first sample", "FAIL", trio()[0], trio()[1], rowj(db_now_utc=iso(T0 + 5)))
case("a column missing from a sample", "FAIL", json.dumps([{k: v for k, v in BASE.items() if k != "next_xid"}]), trio()[1], trio()[2])
case("an unexpected extra column", "FAIL", json.dumps([dict(BASE, extra=1)]), trio()[1], trio()[2])
case("a body that is not one row", "FAIL", "[]", trio()[1], trio()[2])
case("the 4 GiB segment carry (segment 0x100 wraps the high word)", "PASS", *trio(s1={"cur_wal_file": "000000010000000100000000", "last_archived_wal": "0000000100000000000000FF"}, s2={"cur_wal_file": "000000010000000100000000", "last_archived_wal": "0000000100000000000000FF"}, s0a={"cur_wal_file": "000000010000000100000000", "last_archived_wal": "0000000100000000000000FF"}))
print("RESULT (wal-evidence): %d failed" % fails); sys.exit(1 if fails else 0)
