#!/usr/bin/env python3
"""One-shot setup for Sam's verified NEW Volume. Default is checks only.

--create initializes this exact blank Volume as an LXD LVM/ext4 pool.
No force/wipe, host network, Docker, runner registration or teardown actions.
"""
import argparse
import json
import os
import stat
import subprocess
import sys

DEVICE = "/dev/disk/by-id/scsi-0HC_Volume_107429924"
SERIAL = "107429924"
BYTES = 193273528320
POOL = "hone-ci"
LXC = ["/snap/bin/lxc", "--force-local"]


def validate_target(blocks, signatures, pools, size):
    disks = blocks["blockdevices"]
    if len(disks) != 1:
        raise ValueError("Expected exactly one disk")
    disk = disks[0]
    if str(disk.get("serial", "")).strip() != SERIAL:
        raise ValueError("Volume serial mismatch")
    if disk.get("type") != "disk" or disk.get("children"):
        raise ValueError("Expected a whole disk with no partitions")
    if int(disk["size"]) != BYTES or size != BYTES:
        raise ValueError("Volume byte-size mismatch")
    if "fstype" not in disk or not isinstance(disk.get("mountpoints"), list):
        raise ValueError("Unknown filesystem or mount read")
    if disk["fstype"] or any(disk["mountpoints"]):
        raise ValueError("Disk has a filesystem or mount")
    if not isinstance(signatures.get("signatures"), list):
        raise ValueError("Unknown signature read")
    if signatures["signatures"]:
        raise ValueError("Disk contains signatures; refusing to initialize")
    if not isinstance(pools, list):
        raise ValueError("Unknown LXD pool inventory")
    if any(p["name"] == POOL for p in pools):
        raise ValueError("Pool already exists; inspect it instead of rerunning setup")


def command(args):
    env = dict(os.environ, LC_ALL="C",
               PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin")
    return subprocess.run(args, check=True, text=True, capture_output=True,
                          timeout=300, env=env).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--create", action="store_true")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit("Run via sudo; default mode only reads status")
    if not stat.S_ISBLK(os.stat(DEVICE).st_mode):
        raise SystemExit("Expected Volume device is not a block device")
    blocks = json.loads(command(["lsblk", "--bytes", "--json", "--output",
                                "NAME,TYPE,SIZE,SERIAL,FSTYPE,MOUNTPOINTS", DEVICE]))
    signatures = json.loads(command(["wipefs", "--no-act", "--json", DEVICE]))
    pools = json.loads(command(LXC + ["storage", "list", "--format=json"]))
    size = int(command(["blockdev", "--getsize64", DEVICE]).strip())
    validate_target(blocks, signatures, pools, size)
    print("Verified blank Volume", SERIAL, "at", os.path.realpath(DEVICE), "bytes", size)
    if not args.create:
        print("Checks only. --create initializes this exact Volume as LVM/ext4.")
        return
    # No guessed device, source.wipe, force-reuse, pool removal or retry.
    print("Initializing ONLY the verified new Volume as hone-ci (LVM/ext4).", flush=True)
    output = command(LXC + ["storage", "create", POOL, "lvm",
                            "source=" + DEVICE, "lvm.use_thinpool=true",
                            "volume.block.filesystem=ext4", "volume.size=30GiB"])
    print(output, end="")
    print(command(LXC + ["storage", "show", POOL]), end="")
    print(command(LXC + ["storage", "info", POOL]), end="")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError,
            subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        print("Stopped:", exc, file=sys.stderr)
        if isinstance(exc, subprocess.CalledProcessError) and exc.stderr:
            print(exc.stderr, file=sys.stderr)
        print("Inspect device and LXD state before retrying; no automatic wipe or cleanup.",
              file=sys.stderr)
        raise SystemExit(1)
