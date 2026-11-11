import { expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

it("an absent or unreadable LXD snap never invokes the installer wrapper", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hone-ci-preflight-"));
  try {
    const marker = path.join(root, "wrapper-called");
    const commands = {
      snap: "exit 1",
      lxc: 'touch "$WRAPPER_MARKER"; exit 97',
      docker: "exit 0",
      df: 'if [ "$1" = "-B1" ]; then printf "Avail\\n128849018880\\n"; else printf "fixture disk\\n"; fi',
    };
    for (const [name, body] of Object.entries(commands)) {
      const file = path.join(root, name);
      writeFileSync(file, "#!/usr/bin/env bash\n" + body + "\n");
      chmodSync(file, 0o700);
    }
    const result = spawnSync("bash", ["scripts/ci/vps-host-preflight.sh"], {
      encoding: "utf8",
      env: { ...process.env, PATH: root + path.delimiter + process.env.PATH, WRAPPER_MARKER: marker },
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Installed LXD snap not confirmed");
    expect(result.stdout).toContain("Disk admission passes");
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
