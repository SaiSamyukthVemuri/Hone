import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

// Call the real validator, never the setup main or a host storage command.
const invoke = (change: string) => spawnSync("python3", ["-c", `
import importlib.util
spec = importlib.util.spec_from_file_location("pool", "scripts/ci/create-vps-pool.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
b = {"blockdevices": [{"type": "disk", "size": m.BYTES, "serial": m.SERIAL,
                       "fstype": None, "mountpoints": [None]}]}
s = {"signatures": []}; p = []; size = m.BYTES
${change}
m.validate_target(b, s, p, size)
`], { encoding: "utf8", timeout: 3000 });

describe("CI pool setup refuses any target outside the new blank Volume", () => {
  it("accepts the verified new blank disk facts", () => {
    expect(invoke("").status).toBe(0);
  });
  it.each([
    ['wrong disk', 'b["blockdevices"][0]["serial"] = "other"'],
    ['root filesystem', 'b["blockdevices"][0].update(fstype="ext4", mountpoints=["/"])'],
    ['mounted disk', 'b["blockdevices"][0]["mountpoints"] = ["/mnt/in-use"]'],
    ['partitioned disk', 'b["blockdevices"][0]["children"] = [{"type": "part"}]'],
    ['existing data signature', 's["signatures"] = [{"type": "LVM2_member"}]'],
    ['wrong size', 'size -= 1'],
    ['unknown signature read', 's = {}'],
    ['null signature read', 's = {"signatures": None}'],
    ['unknown mount read', 'del b["blockdevices"][0]["mountpoints"]'],
    ['unknown inventory', 'p = None'],
    ['existing CI pool', 'p = [{"name": "hone-ci"}]'],
  ])("refuses %s before initialization", (_, change) => {
    expect(invoke(change).status).not.toBe(0);
  });
});
