#!/usr/bin/env python3
"""Read-only storage snapshot for the dedicated CI pool. Never starts a job.

These conservative pilot budgets are proposals, not measured CI peaks. The
supervisor must hold its admission lock and exclude other pool writers before
using a fresh snapshot; this standalone check does not provide that lock.
"""
import json
import os
import re
import stat
import subprocess
import sys
from decimal import Decimal, InvalidOperation, ROUND_CEILING

DEVICE = "/dev/disk/by-id/scsi-0HC_Volume_107429924"
SERIAL = "107429924"
BYTES = 193273528320
POOL = "hone-ci"
GIB = 1024 ** 3
ROOT_RESERVE = 80 * GIB
JOB_BUDGET = 30 * GIB
POOL_RESERVE = 10 * GIB


def number(value):
    if isinstance(value, bool) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", str(value).strip()):
        raise ValueError("Unknown or invalid numeric read")
    result = Decimal(str(value).strip())
    if not result.is_finite():
        raise ValueError("Non-finite read")
    return result


def rows(report, key):
    reports = report["report"]
    if len(reports) != 1 or not isinstance(reports[0][key], list):
        raise ValueError("Unknown LVM report shape")
    return reports[0][key]


def validate_lvm_children(node):
    # An initialized LVM disk legitimately has mapper descendants in lsblk.
    # These are not partitions. The PV/VG check below still binds the pool to
    # the exact dedicated disk; reject partitions and other/unknown mappings.
    children = node.get("children", [])
    if not isinstance(children, list):
        raise ValueError("Unknown block-device descendants")
    for child in children:
        if not isinstance(child, dict) or child.get("type") != "lvm":
            raise ValueError("Unexpected non-LVM block-device descendant")
        validate_lvm_children(child)


def validate(root_free, disk, pool, pvs, lvs, device_path):
    if number(root_free) < ROOT_RESERVE:
        raise ValueError("Root reserve below 80 GiB; no automatic cleanup")
    if (str(disk["serial"]).strip() != SERIAL or number(disk["size"]) != BYTES
            or disk["type"] != "disk"):
        raise ValueError("Dedicated Volume identity changed")
    validate_lvm_children(disk)
    if pool["name"] != POOL or pool["driver"] != "lvm" or pool["status"] != "Created":
        raise ValueError("Expected created hone-ci LVM pool")
    config = pool["config"]
    if (config.get("lvm.use_thinpool") != "true"
            or config.get("volume.block.filesystem") != "ext4"
            or config.get("volume.size") != "30GiB"):
        raise ValueError("Unqualified thin-pool, filesystem or disk budget")
    if config.get("volatile.initial_source", config.get("source")) != DEVICE:
        raise ValueError("Pool original source differs from the dedicated Volume")
    vg = config.get("lvm.vg_name", POOL)
    thin_name = config.get("lvm.thinpool_name", "LXDThinPool")
    physical = [p for p in rows(pvs, "pv") if p["vg_name"].strip() == vg]
    if len(physical) != 1 or physical[0]["pv_name"].strip() != device_path:
        raise ValueError("Pool VG is not exclusively on the verified Volume")
    logical = [v for v in rows(lvs, "lv") if v["vg_name"].strip() == vg]
    matches = [v for v in logical if v["lv_name"].strip() == thin_name]
    if len(matches) != 1:
        raise ValueError("Unknown thin pool")
    thin = matches[0]
    attr = thin["lv_attr"].strip()
    if (thin["segtype"].strip() != "thin-pool" or len(attr) != 10
            or attr[0] != "t" or attr[1] != "w" or attr[4] != "a"
            or thin["lv_health_status"].strip()):
        raise ValueError("Thin pool inactive, unhealthy or not writable")
    total = number(thin["lv_size"])
    data = number(thin["data_percent"])
    metadata = number(thin["metadata_percent"])
    if not 0 <= data <= 100 or not 0 <= metadata < 50:
        raise ValueError("Thin data read invalid or metadata at/above pilot 50% ceiling")
    if not 0 < total <= BYTES:
        raise ValueError("Thin-pool size outside dedicated Volume")
    # LVM percentages are rounded. Add 0.01 percentage points before estimating
    # used data so rounding down cannot manufacture free bytes at the boundary.
    used = (total * min(Decimal(100), data + Decimal("0.01")) / 100).to_integral_value(rounding=ROUND_CEILING)
    free = total - used
    if free < JOB_BUDGET + POOL_RESERVE:
        raise ValueError("Thin data cannot cover one 30 GiB job plus 10 GiB reserve")
    # Also reserve every existing thin LV's FULL logical size, including images
    # and snapshots. Current Data% alone misses future writes/overcommit.
    committed = Decimal(0)
    for volume in logical:
        if volume["pool_lv"].strip() == thin_name:
            if volume["segtype"].strip() != "thin":
                raise ValueError("Unknown child volume type")
            committed += number(volume["lv_size"])
    if committed + JOB_BUDGET + POOL_RESERVE > total:
        raise ValueError("Logical commitments would overcommit the thin pool")
    return {"root_available_bytes": int(root_free), "pool_bytes": int(total),
            "pool_free_bytes_conservative": int(free),
            "existing_logical_commitment_bytes": int(committed),
            "metadata_percent": str(metadata), "new_job_budget_bytes": JOB_BUDGET}


def command(args):
    return subprocess.run(args, check=True, text=True, capture_output=True,
                          timeout=20, env=dict(os.environ, LC_ALL="C",
                          PATH="/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin")).stdout


def main():
    if os.geteuid() != 0:
        raise ValueError("Run via sudo for read-only LXD/LVM inspection; do not grant CI host access")
    if not stat.S_ISBLK(os.stat(DEVICE).st_mode):
        raise ValueError("Dedicated CI Volume missing; refusing root-disk fallback")
    disk_rows = json.loads(command(["lsblk", "--bytes", "--json", "--output",
                                  "NAME,TYPE,SIZE,SERIAL", DEVICE]))["blockdevices"]
    if len(disk_rows) != 1:
        raise ValueError("Expected one dedicated CI disk")
    pools = json.loads(command(["/snap/bin/lxc", "--force-local", "storage", "list", "--format=json"]))
    matches = [pool for pool in pools if pool["name"] == POOL]
    if len(matches) != 1:
        raise ValueError("Dedicated CI pool absent or ambiguous; no root-disk fallback")
    pool = matches[0]
    pvs = json.loads(command(["pvs", "--reportformat", "json", "-o", "pv_name,vg_name"]))
    lvs = json.loads(command(["lvs", "-a", "--reportformat", "json", "--units", "b", "--nosuffix",
                             "-o", "vg_name,lv_name,lv_attr,segtype,lv_size,pool_lv,data_percent,metadata_percent,lv_health_status"]))
    fs = os.statvfs("/srv/hone")
    # Compare kernel device numbers, not a guessed /dev/sdX or an unverified
    # alias. Canonicalize PV names only after checking they are block devices.
    target = os.stat(DEVICE).st_rdev
    for pv in rows(pvs, "pv"):
        path = pv["pv_name"].strip()
        info = os.stat(path)
        if not stat.S_ISBLK(info.st_mode):
            raise ValueError("PV does not resolve to a block device")
        pv["pv_name"] = DEVICE if info.st_rdev == target else path
    receipt = validate(fs.f_bavail * fs.f_frsize, disk_rows[0], pool, pvs, lvs, DEVICE)
    print(json.dumps(receipt, sort_keys=True))
    print("Storage snapshot passes proposed pilot budgets ONLY; isolation, memory, exclusive admission, peak measurement and live recovery remain unproven.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, InvalidOperation, KeyError, TypeError, OSError,
            subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        print("BLOCKED:", exc, file=sys.stderr)
        print("No job started; no storage or cleanup changes made.", file=sys.stderr)
        raise SystemExit(2)
