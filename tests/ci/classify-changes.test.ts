import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs utility ships without type declarations
import { classify } from "../../scripts/classify-changes.mjs";

// Path-classification is proved here rather than by pushing fake commits to
// trigger every CI lane. These cases ARE the acceptance criteria.

type Result = Record<string, boolean | number>;
const c = (...files: string[]) => classify(files) as Result;

describe("classifier — docs-only PRs", () => {
  it("a docs + apply-record change is docs_only and triggers nothing expensive", () => {
    const r = c(
      "docs/production/migration-ledger.md",
      "docs/production/known-limitations.md",
      "README.md",
    );
    expect(r.docs_only).toBe(true);
    expect(r.application).toBe(false);
    expect(r.database).toBe(false);
    expect(r.payment).toBe(false);
    expect(r.google_calendar).toBe(false);
    expect(r.mobile).toBe(false);
    expect(r.browser_core).toBe(false);
    expect(r.full_matrix_required).toBe(false);
  });

  it("an apply-record-only change is NEVER a full-matrix trigger", () => {
    const r = c("docs/production/migration-ledger.md");
    expect(r.full_matrix_required).toBe(false);
    expect(r.docs_only).toBe(true);
  });

  it("docs plus one code file is NOT docs_only", () => {
    const r = c("docs/x.md", "app/(app)/dashboard/page.tsx");
    expect(r.docs_only).toBe(false);
    expect(r.application).toBe(true);
  });
});

describe("classifier — database / migration PRs", () => {
  it("a migration runs database + security, not payment/google/mobile", () => {
    const r = c(
      "supabase/migrations/0166_example.sql",
      "tests/migrations/0166-example.test.ts",
    );
    expect(r.database).toBe(true);
    expect(r.payment).toBe(false);
    expect(r.google_calendar).toBe(false);
    expect(r.mobile).toBe(false);
    expect(r.full_matrix_required).toBe(false);
  });

  it("a DB integration test counts as database", () => {
    expect(c("tests/db/entry-create-commands.db.test.ts").database).toBe(true);
  });

  it("a security guard counts as security", () => {
    expect(c("tests/security/entry-direct-dml-guard.test.ts").security).toBe(true);
  });
});

describe("classifier — lane-specific PRs", () => {
  it("a payment change runs the payment lane", () => {
    const r = c("app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts");
    expect(r.payment).toBe(true);
    expect(r.google_calendar).toBe(false);
  });

  it("a Google Calendar change runs the Google lane", () => {
    const r = c("lib/google-calendar/sync/reconcile.ts");
    expect(r.google_calendar).toBe(true);
    expect(r.payment).toBe(false);
  });

  it("a mobile spec runs the mobile lane", () => {
    const r = c("e2e-mobile/completion.spec.ts");
    expect(r.mobile).toBe(true);
    expect(r.payment).toBe(false);
  });

  it("an ordinary UI change runs application + browser_core only", () => {
    const r = c("components/sessions/SimplifiedEntryForm.tsx");
    expect(r.application).toBe(true);
    expect(r.browser_core).toBe(true);
    expect(r.payment).toBe(false);
    expect(r.google_calendar).toBe(false);
    expect(r.mobile).toBe(false);
    expect(r.database).toBe(false);
    expect(r.full_matrix_required).toBe(false);
  });
});

describe("classifier — full matrix", () => {
  for (const f of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "next.config.ts",
    "middleware.ts",
    "lib/supabase/server.ts",
    "e2e/helpers/seed.ts",
    "tests/db/helpers/harness.ts",
  ]) {
    it(`${f} forces the full matrix`, () => {
      const r = c(f);
      expect(r.full_matrix_required).toBe(true);
      expect(r.payment).toBe(true);
      expect(r.google_calendar).toBe(true);
      expect(r.mobile).toBe(true);
    });
  }

  it("changing CI itself forces the full matrix", () => {
    const r = c(".github/workflows/ci.yml");
    expect(r.ci_workflows).toBe(true);
    expect(r.full_matrix_required).toBe(true);
  });

  it("an undetectable diff falls back to the full matrix (fail safe)", () => {
    const r = c();
    expect(r.full_matrix_required).toBe(true);
  });
});

describe("classifier — output contract", () => {
  it("always emits every documented boolean key", () => {
    const r = c("app/page.tsx");
    for (const k of [
      "docs_only",
      "application",
      "database",
      "security",
      "payment",
      "google_calendar",
      "browser_core",
      "mobile",
      "ci_workflows",
      "full_matrix_required",
    ]) {
      expect(typeof r[k], `${k} must be boolean`).toBe("boolean");
    }
    expect(typeof r.changed_file_count).toBe("number");
  });
});
