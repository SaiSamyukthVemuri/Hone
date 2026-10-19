import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const script = path.join(root, "scripts/publish-machine-contracts.mjs");
const dryRun = () => JSON.parse(execFileSync(process.execPath, [script, "--dry-run"], {
  cwd: root, encoding: "utf8", timeout: 15000,
  env: { ...process.env, HONE_MACHINE_PUBLICATION_SERVICE_ROLE_KEY: "test-secret-must-not-appear", NEXT_PUBLIC_SUPABASE_URL: "https://hosted.invalid" },
}));

describe("machine publication operator entry", () => {
  it("runs on the declared TypeScript compiler, without credentials or a server", () => {
    const { sha256, ...plan } = dryRun();
    expect(sha256).toBe(createHash("sha256").update(JSON.stringify(plan)).digest("hex"));
    expect(plan.publish).toEqual([]);
    expect(plan.skipped.length).toBeGreaterThan(0);
    expect(JSON.stringify(plan)).not.toContain("test-secret-must-not-appear");
  }, 20000);
  it("refuses hosted or implicit apply modes before compiling or contacting a target", () => {
    for (const args of [[], ["--apply"], ["--apply-hosted"], ["--apply-local"], ["--dry-run", "--url=https://hosted.invalid"]]) {
      const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", timeout: 15000 });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Hosted publication is disabled");
    }
  }, 20000);
  it("refuses a changed plan before any slot, container or credential access", () => {
    const result = spawnSync(process.execPath, [script, "--apply-local", `--expect-plan=${"0".repeat(64)}`], { cwd: root, encoding: "utf8", timeout: 15000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Catalogue plan changed");
  }, 20000);
});

describe("allocated finite-reading migration (static evidence only)", () => {
  const source = readFileSync(path.join(root, "supabase/migrations/0235_machine_finite_readings.sql"), "utf8");
  const sql = source.replace(/--[^\n]*/g, "");
  const detectsFiniteConstraint = (text: string) =>
    /alter table public\.treatment_setup_readings\s+add constraint treatment_setup_readings_finite_value\s+check\s*\(value_numeric is null or value_numeric not in\s*\(\s*'NaN'::numeric,\s*'Infinity'::numeric,\s*'-Infinity'::numeric\)\) not valid;/i.test(text);
  it("enforces new rows without rewriting immutable historical observations", () => {
    expect(detectsFiniteConstraint(sql)).toBe(true);
    expect(sql).toMatch(/begin;\s*set local lock_timeout = '5s';/);
    expect(sql).toMatch(/commit;/);
    expect(sql).not.toMatch(/\b(update|delete|truncate)\b/i);
  });
  it.each(["NaN", "Infinity", "-Infinity"])("negative control: detector notices missing %s", (value) => {
    expect(detectsFiniteConstraint(sql.replace(`'${value}'::numeric`, "'0'::numeric"))).toBe(false);
  });
});
