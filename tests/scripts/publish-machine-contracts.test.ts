import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("--owned-target refusals (no real slot file, no real docker: a temp HOME and a fake docker on PATH)", () => {
  const { sha256 } = dryRun();
  // A fake `docker` driven by files in its own temp dir: names.txt, port-<container>, label-<container>.
  const fixture = (opts: { holder?: string | null; names?: string[]; ports?: Record<string, string>; labels?: Record<string, string> }) => {
    const dir = mkdtempSync(path.join(tmpdir(), "pub-owned-"));
    const home = path.join(dir, "home"), bin = path.join(dir, "bin");
    mkdirSync(path.join(home, "hone-handoffs"), { recursive: true }); mkdirSync(bin);
    if (opts.holder !== null) writeFileSync(path.join(home, "hone-handoffs/heavy-slot"), `${opts.holder ?? "photos"}\n`);
    writeFileSync(path.join(dir, "names.txt"), (opts.names ?? []).join("\n") + "\n");
    for (const [c, v] of Object.entries(opts.ports ?? {})) writeFileSync(path.join(dir, `port-${c}`), `${v}\n`);
    for (const [c, v] of Object.entries(opts.labels ?? {})) writeFileSync(path.join(dir, `label-${c}`), `${v}\n`);
    writeFileSync(path.join(bin, "docker"), `#!/bin/sh
case "$1" in
  ps) cat "${dir}/names.txt" ;;
  port) cat "${dir}/port-$2" 2>/dev/null || exit 1 ;;
  inspect) cat "${dir}/label-$4" 2>/dev/null || exit 1 ;;
esac
`, { mode: 0o755 });
    return { dir, home, bin };
  };
  const run = (f: ReturnType<typeof fixture>, env: Record<string, string>) =>
    spawnSync(process.execPath, [script, "--apply-local", "--owned-target", `--expect-plan=${sha256}`], {
      cwd: root, encoding: "utf8", timeout: 30000,
      env: { ...process.env, HOME: f.home, PATH: `${f.bin}:${process.env.PATH}`, HONE_MACHINE_PUBLICATION_SERVICE_ROLE_KEY: "x", ...env },
    });
  const PAIR = { E2E_SUPABASE_URL: "http://127.0.0.1:59401", HONE_LOCAL_DB_URL: "postgresql://p:p@127.0.0.1:59402/postgres" };
  const GOOD = {
    names: ["supabase_kong_mine", "supabase_db_mine"],
    ports: { supabase_kong_mine: "0.0.0.0:59401", supabase_db_mine: "0.0.0.0:59402" },
    labels: { supabase_kong_mine: "mine", supabase_db_mine: "mine" },
  };

  it("refuses with its own message when there is NO heavy-slot file (not a raw ENOENT)", () => {
    const r = run(fixture({ holder: null }), { HONE_SLOT_HOLDER: "photos", ...PAIR });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no heavy-slot file or it is empty");
    expect(r.stderr).not.toContain("ENOENT");
  }, 40000);
  it("refuses when HONE_SLOT_HOLDER is not the holder, and says it is an attestation", () => {
    const r = run(fixture({ holder: "photos" }), { HONE_SLOT_HOLDER: "someone-else", ...PAIR });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("HONE_SLOT_HOLDER must equal");
    expect(r.stderr).toContain("cannot prove whose stack");
  }, 40000);
  it("refuses a half pair, a non-loopback endpoint and a missing port", () => {
    const f = fixture({ holder: "photos", ...GOOD });
    const base = { HONE_SLOT_HOLDER: "photos" };
    expect(run(f, { ...base, E2E_SUPABASE_URL: PAIR.E2E_SUPABASE_URL, HONE_LOCAL_DB_URL: "" }).stderr).toContain("BOTH");
    expect(run(f, { ...base, E2E_SUPABASE_URL: "https://hosted.invalid:443", HONE_LOCAL_DB_URL: PAIR.HONE_LOCAL_DB_URL }).stderr).toContain("loopback");
    expect(run(f, { ...base, E2E_SUPABASE_URL: "http://127.0.0.1", HONE_LOCAL_DB_URL: PAIR.HONE_LOCAL_DB_URL }).stderr).toContain("loopback");
  }, 60000);
  it("reads the container mapping back: no container maps the API port, or the SQL port is another container's", () => {
    const env = { HONE_SLOT_HOLDER: "photos", ...PAIR };
    expect(run(fixture({ holder: "photos", names: ["supabase_kong_mine"], ports: { supabase_kong_mine: "0.0.0.0:11111" }, labels: {} }), env).stderr).toContain("No local Supabase API container maps");
    const wrongDb = { ...GOOD, ports: { ...GOOD.ports, supabase_db_mine: "0.0.0.0:11112" } };
    expect(run(fixture({ holder: "photos", ...wrongDb }), env).stderr).toContain("mapping does not match");
  }, 60000);
  it("refuses API and SQL containers that carry different project labels, and the shared stack", () => {
    const env = { HONE_SLOT_HOLDER: "photos", ...PAIR };
    expect(run(fixture({ holder: "photos", ...GOOD, labels: { supabase_kong_mine: "mine", supabase_db_mine: "other" } }), env).stderr).toContain("same Supabase project label");
    const shared = { names: ["supabase_kong_Hone-0162", "supabase_db_Hone-0162"], ports: { "supabase_kong_Hone-0162": "0.0.0.0:59401", "supabase_db_Hone-0162": "0.0.0.0:59402" }, labels: {} };
    expect(run(fixture({ holder: "photos", ...shared }), env).stderr).toContain("must not be the shared stack");
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
