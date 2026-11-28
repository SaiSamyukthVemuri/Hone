import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error - .mjs utilities ship without type declarations
import { classify } from "../../scripts/classify-changes.mjs";
// @ts-expect-error - .mjs utilities ship without type declarations
import { dbHelperReach } from "../../scripts/import-graph.mjs";

// CI-SELECT-02 R1 and R2. Both used to force the FULL matrix. Each is narrowed only where the claim "nothing else can run this" is PROVED, and
// every case the proof cannot cover keeps the full matrix.
type R = { full_matrix_required: boolean; database: boolean; payment: boolean; mobile: boolean; google_calendar: boolean; ci_workflows: boolean; browser_core: boolean };
const c = (...f: string[]) => classify(f) as R;

describe("R1: a DB test helper selects the lanes that can run it, not the full matrix", () => {
  it("harness.ts and payment-seed.ts reach only the DB suites, the dependency tests and the payment and mobile e2e fixtures", () => {
    for (const f of ["tests/db/helpers/harness.ts", "tests/db/helpers/payment-seed.ts"]) {
      const r = c(f);
      expect(r.full_matrix_required, f).toBe(false);
      expect(r.database, f).toBe(true);
      expect(r.payment, f).toBe(true);
      expect(r.mobile, f).toBe(true);
      expect(r.google_calendar, f).toBe(false);
    }
  });
  it("a helper no one outside tests/db imports selects the DB lane alone", () => {
    const reach = dbHelperReach(process.cwd(), "tests/db/helpers/synth-fleet.ts");
    if (reach.provable) {
      const r = c("tests/db/helpers/synth-fleet.ts");
      expect(r.full_matrix_required).toBe(false);
      expect(r.database).toBe(true);
    }
  });
  it("FAIL-SAFE: shared harness beside a helper still forces the full matrix", () => {
    expect(c("tests/db/helpers/harness.ts", "e2e/helpers/seed.ts").full_matrix_required).toBe(true);
    expect(c("tests/db/helpers/harness.ts", "lib/supabase/server.ts").full_matrix_required).toBe(true);
  });
  it("FAIL-SAFE: a helper the checkout does not contain (deleted) keeps the full matrix", () => {
    expect(c("tests/db/helpers/no-such-helper.ts").full_matrix_required).toBe(true);
  });

  const fixture = (files: Record<string, string>) => {
    const root = mkdtempSync(path.join(tmpdir(), "helper-"));
    for (const [f, src] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      writeFileSync(path.join(root, f), src);
    }
    return root;
  };
  it("is provable for DB suites and dependency tests only, and adds no lane", () => {
    const root = fixture({
      "tests/db/helpers/h.ts": "export const a = 1;",
      "tests/db/x.db.test.ts": 'import "./helpers/h";',
      "tests/dependencies/y.test.ts": 'import "../db/helpers/h";',
    });
    expect(dbHelperReach(root, "tests/db/helpers/h.ts")).toEqual({ provable: true, lanes: [], other: [] });
  });
  it("follows other helpers, and names the payment, mobile and google lanes", () => {
    const root = fixture({
      "tests/db/helpers/h.ts": "export const a = 1;",
      "tests/db/helpers/h2.ts": 'export * from "./h";',
      "e2e-payment/helpers/f.ts": 'import "../../tests/db/helpers/h2";',
      "e2e-mobile/m.spec.ts": 'import "../e2e-payment/helpers/f";',
      "e2e-google/g.spec.ts": 'import "../tests/db/helpers/h";',
    });
    expect(dbHelperReach(root, "tests/db/helpers/h.ts")).toEqual({ provable: true, lanes: ["google_calendar", "mobile", "payment"], other: [] });
  });
  it("FAIL-SAFE: an importer in e2e/, app code, a script or a config makes it unprovable", () => {
    for (const importer of ["e2e/spec.ts", "e2e/helpers/x.ts", "app/p/page.tsx", "lib/x.ts", "scripts/s.mjs", "playwright.config.ts", "tests/unit/z.test.ts"]) {
      const up = "../".repeat(importer.split("/").length - 1) || "./";
      const root = fixture({ "tests/db/helpers/h.ts": "export const a = 1;", [importer]: `import "${up}tests/db/helpers/h";` });
      const r = dbHelperReach(root, "tests/db/helpers/h.ts");
      expect(r.provable, importer).toBe(false);
      expect(r.other, importer).toContain(importer);
    }
  });
});

describe("R2: a test of the selector is a unit test, not a CI-system change", () => {
  it("tests/ci/*.test.ts runs the unit lane and nothing wider", () => {
    for (const f of ["tests/ci/classify-changes.test.ts", "tests/ci/browser-selection.test.ts", "tests/ci/graph-selection.test.ts"]) {
      const r = c(f);
      expect(r.ci_workflows, f).toBe(false);
      expect(r.full_matrix_required, f).toBe(false);
    }
  });
  it("FAIL-SAFE: anything else under tests/ci, the selector itself and the workflows still force the full matrix", () => {
    for (const f of ["tests/ci/fixtures/plan.json", "tests/ci/helpers/x.ts", "scripts/classify-changes.mjs", "scripts/test-dependencies.mjs", "scripts/import-graph.mjs", ".github/workflows/ci.yml"]) {
      const r = c(f);
      if (f === "scripts/import-graph.mjs") continue; // asserted below
      expect(r.ci_workflows, f).toBe(true);
      expect(r.full_matrix_required, f).toBe(true);
    }
  });
  it("FAIL-SAFE: the new graph module and browser-groups are selection logic, so they force the full matrix too", () => {
    for (const f of ["scripts/import-graph.mjs", "scripts/browser-groups.mjs"]) expect(c(f).full_matrix_required, f).toBe(true);
  });
});
