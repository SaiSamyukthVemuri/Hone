import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// js-yaml ships no types; reached the way tests/ci/ci-config.test.ts reaches it.
const yaml = createRequire(path.resolve("package.json"))("js-yaml") as { load(src: string): unknown };

// CI-COST-02. records-preflight runs the ledger and receipt suites before the heavy
// lanes start, and the heavy lanes need it. That is safe only while it asks
// EXACTLY the question validate asks: the same files, the same freshness mode, the
// same docs-only skip, and nothing at all on a production push.

const ROOT = path.resolve(__dirname, "../..");
type Step = { name?: string; if?: string; run?: string; env?: Record<string, string> };
type Job = { name?: string; needs?: string | string[]; if?: string; steps: Step[] };
const jobs = (yaml.load(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, Job> }).jobs;
const pre = jobs["records-preflight"];
const SUITES = ["tests/docs/canonical-production-facts.test.ts", "tests/ci/pr-release-receipt.test.ts"];
const HEAVY = ["db-integration", "browser-e2e-shard", "payment-browser-e2e", "mobile-completion-e2e", "google-browser-e2e", "storage-photos", "webkit-hon-62"];

describe("CI-COST-02 records pre-flight", () => {
  it("runs exactly the two record suites, with validate's freshness mode and docs-only skip", () => {
    const run = pre.steps.find((s) => s.run?.includes("vitest"))!;
    expect(run.run).toBe(`npx vitest run ${SUITES.join(" ")}`);
    const unit = jobs.validate.steps.find((s) => s.name === "Unit tests")!;
    expect(unit.run).toBe("npm test");
    expect(run.env).toEqual({ CANONICAL_FRESHNESS: unit.env!.CANONICAL_FRESHNESS });
    expect(pre.needs).toBe("changes");
    expect(pre.if).toBe(jobs.validate.if);
  });

  it("validate still runs both suites, so the gate adds no assertion of its own", () => {
    const cfg = readFileSync(path.join(ROOT, "vitest.config.ts"), "utf8");
    expect(cfg).toContain('include: ["tests/**/*.test.ts"]');
    expect(cfg).toContain('exclude: ["node_modules/**", ".next/**", "tests/db/**"]');
    for (const f of SUITES) expect(readFileSync(path.join(ROOT, f), "utf8").length, f).toBeGreaterThan(0);
  });

  it("is a no-op on push: every step is pull_request-only, so the heavy lanes still run on production", () => {
    expect(pre.steps.length).toBeGreaterThan(0);
    for (const s of pre.steps) expect(s.if, s.name).toBe("${{ github.event_name == 'pull_request' }}");
  });

  it("every heavy lane needs it, and no required job's needs changed", () => {
    for (const j of HEAVY) expect(jobs[j].needs, j).toEqual(["changes", "records-preflight"]);
    expect(jobs.validate.needs).toBe("changes");
    expect(jobs["canonical-record"].needs).toBe("changes");
    expect(jobs["browser-e2e"].needs).toEqual(["changes", "browser-e2e-shard", "canonical-record"]);
    // The heavy conditions carry no status function, so a failed or skipped
    // pre-flight skips them (implicit success()); the aggregator then fails closed.
    for (const j of HEAVY) expect(jobs[j].if, j).not.toMatch(/always\(\)|!cancelled\(\)|failure\(\)/);
  });
});
