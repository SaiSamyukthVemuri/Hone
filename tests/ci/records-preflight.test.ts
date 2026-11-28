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
    for (const j of HEAVY) expect(jobs[j].needs, j).toEqual(["changes", "records-preflight", "validate"]);
    expect(jobs.validate.needs).toBe("changes");
    expect(jobs["canonical-record"].needs).toBe("changes");
    expect(jobs["browser-e2e"].needs).toEqual(["changes", "browser-e2e-shard", "canonical-record"]);
    // CI-COST-03 adds one status function, `!cancelled()`, so the implicit
    // success() is gone and both earlier gates are written out in VALIDATE_GATE.
    for (const j of HEAVY) {
      expect(jobs[j].if!.startsWith(`\${{ ${VALIDATE_GATE} && github.event.pull_request.draft != true && ( `), j).toBe(true);
      expect(jobs[j].if!.split(VALIDATE_GATE)[1], j).not.toMatch(/always\(\)|cancelled\(\)|failure\(\)|success\(\)|\.result/);
    }
  });
});

// CI-COST-03. The heavy lanes wait for validate, and on a pull request start only
// when it passed. A failed or skipped pre-flight still skips them, and a production
// push still runs them whatever validate concluded.
export const VALIDATE_GATE =
  "!cancelled() && needs.changes.result == 'success' && needs.records-preflight.result == 'success' && (github.event_name != 'pull_request' || needs.validate.result == 'success')";

type GateInput = { cancelled?: boolean; event: string; changes: string; preflight: string; validate: string };
/** Evaluates exactly the shapes VALIDATE_GATE uses; anything left over is refused. */
function gate(i: GateInput): boolean {
  const js = VALIDATE_GATE
    .replace("!cancelled()", String(!i.cancelled))
    .replace(/needs\.changes\.result == '(\w+)'/, (_, v) => String(i.changes === v))
    .replace(/needs\.records-preflight\.result == '(\w+)'/, (_, v) => String(i.preflight === v))
    .replace(/needs\.validate\.result == '(\w+)'/, (_, v) => String(i.validate === v))
    .replace(/github\.event_name != '(\w+)'/, (_, v) => String(i.event !== v));
  expect(js, "only booleans and operators remain").toMatch(/^[\s()|&!truefals]*$/);
  return Function(`return (${js})`)() as boolean;
}

describe("CI-COST-03 heavy lanes wait for validate", () => {
  const ok = { changes: "success", preflight: "success", validate: "success" };
  it("validate itself is unchanged: it needs `changes` alone and no heavy lane", () => {
    expect(jobs.validate.needs).toBe("changes");
    expect(jobs.validate.if).toBe("${{ needs.changes.outputs.docs_only != 'true' }}");
  });
  it("pull request: runs only when validate passed", () => {
    expect(gate({ event: "pull_request", ...ok })).toBe(true);
    for (const validate of ["failure", "cancelled", "skipped"]) {
      expect(gate({ event: "pull_request", ...ok, validate }), validate).toBe(false);
    }
  });
  it("production push: runs whatever validate concluded", () => {
    for (const validate of ["success", "failure", "cancelled"]) {
      expect(gate({ event: "push", ...ok, validate }), validate).toBe(true);
    }
  });
  it("a failed or skipped pre-flight, or a failed `changes`, skips the lanes on every event", () => {
    for (const event of ["pull_request", "push"]) {
      for (const bad of ["failure", "skipped", "cancelled"]) {
        expect(gate({ event, ...ok, preflight: bad }), `${event} preflight ${bad}`).toBe(false);
        expect(gate({ event, ...ok, changes: bad }), `${event} changes ${bad}`).toBe(false);
      }
    }
  });
  it("a cancelled run starts nothing", () => {
    expect(gate({ cancelled: true, event: "push", ...ok })).toBe(false);
  });
});
