import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
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
    // First slice: the ten v3 modes publish; Junior Thermolysis and OmniBlend (and every v1/v2 contract) are skipped with reasons.
    expect(plan.publish).toHaveLength(10);
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

describe("--owned-target refuses everything but a paired, loopback, slot-held, non-shared stack", () => {
  const holder = (() => { try { return readFileSync(path.join(homedir(), "hone-handoffs/heavy-slot"), "utf8").trim(); } catch { return ""; } })();
  const run = (env: Record<string, string>) => {
    const { sha256 } = dryRun();
    return spawnSync(process.execPath, [script, "--apply-local", "--owned-target", `--expect-plan=${sha256}`], {
      cwd: root, encoding: "utf8", timeout: 20000, env: { ...process.env, HONE_MACHINE_PUBLICATION_SERVICE_ROLE_KEY: "x", ...env },
    });
  };
  it("refuses without HONE_SLOT_HOLDER equal to the holder", () => {
    const r = run({ HONE_SLOT_HOLDER: `${holder}-not` });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("HONE_SLOT_HOLDER");
  }, 30000);
  it.skipIf(!holder)("refuses a half pair, a non-loopback endpoint and a missing port", () => {
    const base = { HONE_SLOT_HOLDER: holder };
    expect(run({ ...base, E2E_SUPABASE_URL: "http://127.0.0.1:59101", HONE_LOCAL_DB_URL: "" }).stderr).toContain("BOTH");
    expect(run({ ...base, E2E_SUPABASE_URL: "https://hosted.invalid:443", HONE_LOCAL_DB_URL: "postgresql://p:p@127.0.0.1:59102/postgres" }).stderr).toContain("loopback");
    expect(run({ ...base, E2E_SUPABASE_URL: "http://127.0.0.1", HONE_LOCAL_DB_URL: "postgresql://p:p@127.0.0.1:59102/postgres" }).stderr).toContain("loopback");
  }, 60000);
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
