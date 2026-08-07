import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
// @ts-expect-error - .mjs utilities ship without type declarations
import { selectBrowserGroups, specsForGroups, BROWSER_GROUPS, EXTENDED } from "../../scripts/browser-groups.mjs";
// @ts-expect-error - .mjs utilities ship without type declarations
import { buildPlan } from "../../scripts/ci-plan.mjs";

type Sel = { groups: string[]; extended: boolean; reason: string };
const sel = (...files: string[]) => selectBrowserGroups(files) as Sel;
const plan = (...files: string[]) => buildPlan(files) as ReturnType<typeof buildPlan>;
const laneRuns = (p: ReturnType<typeof plan>, name: string) =>
  (p.lanes as Array<{ lane: string; run: boolean }>).find((l) => l.lane.startsWith(name))?.run;

describe("browser group manifest integrity", () => {
  it("maps every spec on disk to exactly one group", () => {
    const disk = readdirSync("e2e").filter((f) => f.endsWith(".spec.ts"));
    const mapped = Object.values(BROWSER_GROUPS as Record<string, { specs: string[] }>).flatMap(
      (g) => g.specs,
    );
    const unmapped = disk.filter((f) => !mapped.includes(f));
    expect(unmapped, "every spec must belong to a group or it will never run in a targeted lane").toEqual([]);
    // No duplicates across groups — a spec in two groups would run twice.
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  it("references no spec that does not exist", () => {
    const disk = new Set(readdirSync("e2e").filter((f) => f.endsWith(".spec.ts")));
    const mapped = Object.values(BROWSER_GROUPS as Record<string, { specs: string[] }>).flatMap((g) => g.specs);
    expect(mapped.filter((f) => !disk.has(f))).toEqual([]);
  });

  it("every group documents its purpose", () => {
    for (const [name, def] of Object.entries(BROWSER_GROUPS as Record<string, { description: string }>)) {
      expect(def.description.length, `${name} needs a description`).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// The ten acceptance cases, table-driven.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Timeout-margin fix (fix/targeted-browser-timeout-margin): this PR changes ONLY
// the targeted shard's hard timeout. These pins prove it changed no selection.
// ---------------------------------------------------------------------------

describe("browser selection is UNCHANGED by the timeout-margin fix", () => {
  it("the group set is exactly the ten existing groups", () => {
    expect(Object.keys(BROWSER_GROUPS as Record<string, unknown>).sort()).toEqual([
      "booking",
      "calendar",
      "google",
      "intake",
      "marketing",
      "owner_admin",
      "portal",
      "responsive",
      "sessions",
      "smoke",
    ]);
  });

  it("the manifest still maps all 59 specs, and the targeted lane still selects 27", () => {
    const mapped = Object.values(BROWSER_GROUPS as Record<string, { specs: string[] }>).flatMap(
      (g) => g.specs,
    );
    // 58 since practitioner-assisted-intake.spec.ts joined the intake group
    // (57 after PR #518 added intake-electrolysis-acknowledgement.spec.ts).
    // The count is deliberate: it is the tripwire for a spec that lands on
    // disk without being mapped, which would silently never run.
    expect(mapped).toHaveLength(59);
    // The exact selection that was cancelled twice at the old 10-minute ceiling.
    expect(specsForGroups(["calendar", "sessions", "smoke"])).toHaveLength(27);
  });

  it("targeted coverage is still ONE shard and extended still FOUR", () => {
    expect(plan("app/(app)/clients/[id]/sessions/[sessionId]/actions.ts").browser.sharded).toBe(false);
    expect(plan("e2e/helpers/seed.ts").browser.sharded).toBe(true);
  });
});

describe("acceptance case 1 — docs-only", () => {
  const p = plan("docs/production/migration-ledger.md", "README.md");
  it("runs no DB, browser, mobile, payment or Google lane", () => {
    expect(laneRuns(p, "db integration")).toBe(false);
    expect(laneRuns(p, "browser e2e")).toBe(false);
    expect(laneRuns(p, "payment browser")).toBe(false);
    expect(laneRuns(p, "google browser")).toBe(false);
    expect(laneRuns(p, "mobile completion")).toBe(false);
    expect(laneRuns(p, "typecheck")).toBe(false);
  });
  it("selects no browser group", () => {
    expect(sel("docs/x.md").groups).toEqual([]);
  });
});

describe("acceptance case 2 — migration-only", () => {
  const p = plan("supabase/migrations/0166_x.sql", "tests/migrations/0166-x.test.ts");
  it("runs validation + DB/security only", () => {
    expect(laneRuns(p, "typecheck")).toBe(true);
    expect(laneRuns(p, "db integration")).toBe(true);
    expect(laneRuns(p, "browser e2e")).toBe(false);
    expect(laneRuns(p, "payment browser")).toBe(false);
    expect(laneRuns(p, "google browser")).toBe(false);
    expect(laneRuns(p, "mobile completion")).toBe(false);
  });
});

describe("acceptance case 3 — session UI only", () => {
  const p = plan("app/(app)/clients/[id]/sessions/[sessionId]/actions.ts");
  it("selects the sessions group (plus smoke) and no unrelated lane", () => {
    const s = sel("app/(app)/clients/[id]/sessions/[sessionId]/actions.ts");
    expect(s.groups).toContain("sessions");
    expect(s.groups).toContain("smoke");
    expect(s.extended).toBe(false);
    expect(laneRuns(p, "payment browser")).toBe(false);
    expect(laneRuns(p, "google browser")).toBe(false);
    expect(laneRuns(p, "mobile completion")).toBe(false);
  });
  it("runs materially fewer specs than the whole suite", () => {
    const specs = specsForGroups(sel("app/(app)/clients/[id]/sessions/x.ts").groups) as string[];
    const total = readdirSync("e2e").filter((f) => f.endsWith(".spec.ts")).length;
    expect(specs.length).toBeLessThan(total);
    expect(specs.length).toBeGreaterThan(0);
  });
});

describe("acceptance case 4 — intake UI only", () => {
  it("selects the intake group", () => {
    const s = sel("app/(app)/clients/[id]/intake/actions.ts");
    expect(s.groups).toContain("intake");
    expect(s.extended).toBe(false);
    expect(specsForGroups(s.groups)).toContain("intake-review-integrity.spec.ts");
  });
});

describe("acceptance case 5 — payment only", () => {
  const p = plan("app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts");
  it("runs the payment lane", () => {
    expect(laneRuns(p, "payment browser")).toBe(true);
  });
  it("does not run Google or mobile", () => {
    expect(laneRuns(p, "google browser")).toBe(false);
    expect(laneRuns(p, "mobile completion")).toBe(false);
  });
});

describe("acceptance case 6 — Google only", () => {
  const p = plan("lib/google-calendar/sync/reconcile.ts");
  it("runs the Google lane and not payment/mobile", () => {
    expect(laneRuns(p, "google browser")).toBe(true);
    expect(laneRuns(p, "payment browser")).toBe(false);
    expect(laneRuns(p, "mobile completion")).toBe(false);
  });
});

describe("acceptance case 7 — shared browser fixture", () => {
  it("forces EXTENDED coverage (sharded), never a narrow group", () => {
    for (const f of ["e2e/helpers/seed.ts", "playwright.config.ts", "lib/supabase/server.ts", "middleware.ts"]) {
      const s = sel(f);
      expect(s.extended, `${f} must force extended coverage`).toBe(true);
      expect(s.groups).toEqual([EXTENDED]);
      expect(s.reason).toMatch(/shared/i);
    }
  });
  it("extended coverage means every spec, and is sharded into four", () => {
    const p = plan("e2e/helpers/seed.ts");
    expect(p.browser.extended).toBe(true);
    expect(p.browser.sharded).toBe(true);
    expect(specsForGroups([EXTENDED])).toBeNull(); // null = run everything
  });

  it("docs-only and migration-only still select NO browser job", () => {
    expect(sel("docs/production/migration-ledger.md").groups).toEqual([]);
    expect(sel("supabase/migrations/0166_x.sql").groups).toEqual([]);
    expect(plan("supabase/migrations/0166_x.sql").browser.groups).toEqual([]);
  });

  it("migration-only still skips payment, Google and mobile", () => {
    const p = plan("supabase/migrations/0166_x.sql");
    expect(laneRuns(p, "payment browser")).toBe(false);
    expect(laneRuns(p, "google browser")).toBe(false);
    expect(laneRuns(p, "mobile completion")).toBe(false);
  });
});

describe("acceptance case 8 — workflow / CI change", () => {
  it("requires the full matrix", () => {
    const p = plan(".github/workflows/ci.yml");
    expect(p.full_matrix_required).toBe(true);
    expect(laneRuns(p, "payment browser")).toBe(true);
    expect(laneRuns(p, "google browser")).toBe(true);
    expect(laneRuns(p, "mobile completion")).toBe(true);
  });
});

describe("acceptance case 9 — unknown shared path fails safe", () => {
  it("unattributable application code falls back to extended coverage", () => {
    const s = sel("app/some-brand-new-surface/page.tsx");
    expect(s.extended).toBe(true);
    expect(s.reason).toMatch(/failing safe/i);
  });
  it("an empty diff falls back to extended coverage", () => {
    const s = sel();
    expect(s.extended).toBe(true);
    expect(s.reason).toMatch(/failing safe/i);
  });
});

describe("acceptance case 10 — superseded PR runs are cancelled", () => {
  it("the PR workflow declares a PR-scoped cancelling concurrency group", async () => {
    const { readFileSync } = await import("node:fs");
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toMatch(/group: hone-pr-ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/);
    expect(ci).toMatch(/cancel-in-progress: true/);
  });
  it("nightly concurrency stays separate from PR concurrency", async () => {
    const { readFileSync } = await import("node:fs");
    const nightly = readFileSync(".github/workflows/nightly.yml", "utf8");
    expect(nightly).toMatch(/group: nightly-/);
    expect(nightly).not.toMatch(/hone-pr-ci-/);
  });
});

describe("ci:plan output contract", () => {
  it("explains every lane decision", () => {
    const p = plan("app/(app)/clients/[id]/sessions/x.ts");
    for (const l of p.lanes as Array<{ lane: string; why: string }>) {
      expect(l.why.length, `${l.lane} must state a reason`).toBeGreaterThan(5);
    }
  });
  it("reports the selected groups and whether the full matrix is required", () => {
    const p = plan("package.json");
    expect(p.full_matrix_required).toBe(true);
    expect(p.browser.groups.length).toBeGreaterThan(0);
  });
});
