import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "../../scripts/verify-changed.mjs");
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Run the actual CLI, replacing only its external executables. No real
// typecheck, payment test, provider, database or network is invoked here.
function run(units: number, gates: number, plan = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "hone-verify-payment-"));
  scratch.push(dir);
  const trace = path.join(dir, "trace");
  const executable = (name: string, body: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> "$VERIFY_TRACE"\n${body}\n`);
    chmodSync(file, 0o700);
  };
  executable("npx", `case "$*" in *vitest*) echo 'synthetic payment unit result'; exit ${units};; *) exit 0;; esac`);
  executable("npm", `echo 'synthetic safety gate result'; exit ${gates}`);
  const result = spawnSync(process.execPath, [SCRIPT, "--files", "lib/billing/payment-refund.ts", ...(plan ? ["--plan"] : [])], {
    cwd: dir,
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: dir, NODE_ENV: "test", VERIFY_TRACE: trace },
  });
  let calls = "";
  try { calls = readFileSync(trace, "utf8"); } catch { /* --plan launches nothing */ }
  return { ...result, calls };
}

describe("ENG-003: payment verification cannot mask or omit a required check", () => {
  it.each([[1, 0], [0, 1], [1, 1]])("unit exit %i / gate exit %i fails and executes both", (units, gates) => {
    const result = run(units, gates);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.calls).toContain("npx vitest run");
    expect(result.calls).toContain("npm run check:stripe-gates");
  });

  it("requires both passing checks and selects billing/refund cases by file", () => {
    const result = run(0, 0);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.calls).toContain("npx vitest run payment stripe checkout manual-fee refund tests/lib/billing/");
    expect(result.calls).not.toContain("-t payment");
    expect(result.calls.match(/npm run check:stripe-gates/g)).toHaveLength(1);
    expect(result.stdout).toContain("were NOT run");
  });

  it("dry-run reports both required checks without executing either", () => {
    const result = run(1, 1, true);
    expect(result.status).toBe(0);
    expect(result.calls).toBe("");
    expect(result.stdout).toContain("payment unit regressions");
    expect(result.stdout).toContain("payment safety gates");
    expect(result.stdout).toContain("nothing executed");
  });
});
