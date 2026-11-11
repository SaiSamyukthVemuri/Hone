import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

// Real policy, synthetic read receipts only: never execute host LXD/LVM calls.
const fixture = `
import importlib.util
spec = importlib.util.spec_from_file_location("admission", "scripts/ci/check-vps-storage.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
root = 108 * m.GIB
disk = {"serial": m.SERIAL, "size": m.BYTES, "type": "disk"}
pool = {"name": m.POOL, "driver": "lvm", "status": "Created", "config": {
 "lvm.use_thinpool": "true", "volume.block.filesystem": "ext4", "volume.size": "30GiB",
 "volatile.initial_source": m.DEVICE, "lvm.vg_name": "hone-ci", "lvm.thinpool_name": "LXDThinPool"}}
pvs = {"report": [{"pv": [{"pv_name": m.DEVICE, "vg_name": "hone-ci"}]}]}
thin = {"vg_name": "hone-ci", "lv_name": "LXDThinPool", "lv_attr": "twi-a-tz--",
 "segtype": "thin-pool", "lv_size": str(170*m.GIB), "pool_lv": "",
 "data_percent": "10.00", "metadata_percent": "5.00", "lv_health_status": ""}
image = dict(thin, lv_name="images_reviewed", segtype="thin", pool_lv="LXDThinPool", lv_size=str(30*m.GIB))
lvs = {"report": [{"lv": [thin, image]}]}
`;
const invoke = (change = "", end = "m.validate(root, disk, pool, pvs, lvs, m.DEVICE)") =>
  spawnSync("python3", ["-c", fixture + change + "\n" + end], { encoding: "utf8", timeout: 3000 });

describe("dedicated CI storage snapshot (not worker authorization)", () => {
  it("accepts 108 GiB root free with a separately qualified thin pool", () => {
    expect(invoke().status).toBe(0);
  });
  it.each([
    ["root reserve breach", "root = 80*m.GIB-1"],
    ["unknown root read", 'root = "NaN"'],
    ["different Volume", 'disk["serial"] = "root-disk"'],
    ["changed Volume size", 'disk["size"] -= 1'],
    ["partitioned Volume", 'disk["children"] = [{"type": "part"}]'],
    ["directory pool", 'pool["driver"] = "dir"'],
    ["unavailable pool", 'pool["status"] = "Unavailable"'],
    ["thin provisioning disabled", 'pool["config"]["lvm.use_thinpool"] = "false"'],
    ["unqualified filesystem", 'pool["config"]["volume.block.filesystem"] = "btrfs"'],
    ["changed disk quota", 'pool["config"]["volume.size"] = "100GiB"'],
    ["root source fallback", 'pool["config"]["volatile.initial_source"] = "/dev/sda1"'],
    ["VG on root", 'pvs["report"][0]["pv"][0]["pv_name"] = "/dev/sda1"'],
    ["VG spans another disk", 'pvs["report"][0]["pv"].append({"vg_name":"hone-ci", "pv_name":"/dev/other"})'],
    ["unreadable PV report", 'pvs = {"report": []}'],
    ["absent thin pool", 'lvs["report"][0]["lv"] = [image]'],
    ["inactive thin pool", 'thin["lv_attr"] = "twi---tz--"'],
    ["unhealthy thin pool", 'thin["lv_health_status"] = "needs_check"'],
    ["missing health read", 'del thin["lv_health_status"]'],
    ["nearly full data", 'thin["data_percent"] = "85.00"'],
    ["metadata ceiling", 'thin["metadata_percent"] = "50.00"'],
    ["unknown metadata", 'thin["metadata_percent"] = ""'],
    ["invalid percentage", 'thin["data_percent"] = "101"'],
    ["logical overcommit despite low Data%", 'image["lv_size"] = str(140*m.GIB)'],
    ["unknown child volume", 'image["segtype"] = "unknown"'],
  ])("refuses %s", (_, change) => {
    const result = invoke(change);
    expect(result.status, result.stderr).not.toBe(0);
  });
  it("accepts the root reserve boundary without charging CI disks to root", () => {
    expect(invoke("root = 80*m.GIB").status).toBe(0);
  });
  it("returns actual bytes and both thin accounting measurements", () => {
    const result = invoke("", "import json; print(json.dumps(m.validate(root, disk, pool, pvs, lvs, m.DEVICE)))");
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.root_available_bytes).toBe(108 * 1024 ** 3);
    expect(receipt.existing_logical_commitment_bytes).toBe(30 * 1024 ** 3);
    expect(receipt.metadata_percent).toBe("5.00");
    expect(receipt.pool_free_bytes_conservative).toBeLessThan(170 * 1024 ** 3 * 0.9);
  });
  it("collector refuses a missing block device before calling any host command", () => {
    const result = invoke(`
m.os.geteuid = lambda: 0
m.os.stat = lambda _: (_ for _ in ()).throw(FileNotFoundError("missing CI Volume"))
m.command = lambda _: (_ for _ in ()).throw(AssertionError("must not reach host commands"))
try:
 m.main()
except FileNotFoundError:
 print("refused missing Volume")
else:
 raise AssertionError("expected refusal")`, "");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("refused missing Volume");
  });
  it("collector resolves the actual PV identity and reads separate LXD/LVM receipts", () => {
    const result = invoke(`
import json, stat
from types import SimpleNamespace
calls = []
m.os.geteuid = lambda: 0
m.os.stat = lambda _: SimpleNamespace(st_mode=stat.S_IFBLK, st_rdev=123)
m.os.statvfs = lambda _: SimpleNamespace(f_bavail=root//4096, f_frsize=4096)
pvs["report"][0]["pv"][0]["pv_name"] = "/dev/disk-alias"
def read(args):
 calls.append(args)
 if args[0] == "lsblk": return json.dumps({"blockdevices": [disk]})
 if args == ["/snap/bin/lxc", "--force-local", "storage", "list", "--format=json"]: return json.dumps([pool])
 if args[0] == "pvs": return json.dumps(pvs)
 if args[0] == "lvs": return json.dumps(lvs)
 raise AssertionError("Unexpected host command")
m.command = read
m.main()
assert len(calls) == 4`, "");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Storage snapshot passes proposed pilot budgets ONLY");
  });
});
