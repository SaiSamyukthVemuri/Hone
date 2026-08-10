import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs utility ships without type declarations
import { classify, highestTier } from "../../scripts/classify-changes.mjs";

// Path-classification is proved here rather than by pushing fake commits to
// trigger every CI lane. These cases ARE the acceptance criteria.

type Result = Record<string, boolean | number | string | string[]>;
const c = (...files: string[]) => classify(files) as Result;
const tier = (...files: string[]) => c(...files).baselineRiskTier;
const reasons = (...files: string[]) => c(...files).riskReasons as string[];

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

// ---------------------------------------------------------------------------
// Baseline risk tier — ENGINEERING_STANDARDS.md.
//
// These cases pin DETERMINISTIC PATH EVIDENCE only. They deliberately prove
// nothing about semantics: a T1 verdict here is a starting point for review,
// never a licence to skip it.
// ---------------------------------------------------------------------------

describe("classifier — baseline risk tier", () => {
  it("a docs-only diff is T0", () => {
    expect(tier("docs/production/migration-ledger.md", "README.md")).toBe("T0");
  });

  it("ordinary presentational UI is T1", () => {
    expect(tier("components/client-form.tsx")).toBe("T1");
  });

  it("a business workflow change is T2", () => {
    expect(tier("lib/booking/slots.ts")).toBe("T2");
  });

  it("a migration is T3", () => {
    expect(tier("supabase/migrations/0177_example.sql")).toBe("T3");
  });

  for (const [label, file] of [
    ["payment authority", "lib/billing/session-payment-charge.ts"],
    ["security boundary", "lib/security/rls-helpers.ts"],
    ["authentication", "app/(auth)/login/page.tsx"],
    ["service-role client", "lib/supabase/admin.ts"],
    ["public token route", "app/book/[slug]/page.tsx"],
  ] as const) {
    it(`a ${label} change is T3`, () => {
      expect(tier(file)).toBe("T3");
    });
  }

  it("resolves the highest tier regardless of the order rules matched in", () => {
    // Path fixtures alone CANNOT prove this: every T3 rule currently precedes
    // every T2 rule, so "first match wins" would satisfy each case below and
    // only break when a T3 rule is later appended under the T2 block. Proving
    // the max rule needs the ordering the fixtures cannot produce.
    const h = highestTier as (t: string[]) => string;
    expect(h(["T1", "T3"])).toBe("T3");
    expect(h(["T3", "T1"])).toBe("T3");
    expect(h(["T2", "T3"])).toBe("T3");
    expect(h(["T1", "T2"])).toBe("T2");
    expect(h(["T1", "T1"])).toBe("T1");
  });

  it("T1 + T3 resolves to T3 — the highest deterministic tier wins", () => {
    expect(tier("components/client-form.tsx", "supabase/migrations/0177_example.sql")).toBe("T3");
  });

  it("T2 + T3 resolves to T3 — the highest deterministic tier wins", () => {
    expect(tier("lib/booking/slots.ts", "lib/security/rls-helpers.ts")).toBe("T3");
  });

  it("emits deterministic reasons naming only the winning tier's failure classes", () => {
    const r = reasons("supabase/migrations/0177_example.sql", "lib/billing/session-payment-charge.ts");
    expect(r).toEqual([
      "database migration or DB test surface changed",
      "payment authority path changed",
    ]);
    // Same file set, different order in, identical reasons out.
    expect(reasons("lib/billing/session-payment-charge.ts", "supabase/migrations/0177_example.sql")).toEqual(r);
    // A lower-tier signal never dilutes the explanation of a T3 verdict.
    expect(reasons("lib/booking/slots.ts", "supabase/migrations/0177_example.sql")).toEqual([
      "database migration or DB test surface changed",
    ]);
  });

  it("reasons never contain a character that would corrupt $GITHUB_OUTPUT", () => {
    // The CLI renders riskReasons as `key=a; b` on ONE line, so a newline in a
    // reason would inject a bogus output key. Commas and semicolons would make
    // the joined list ambiguous.
    for (const rule of ["docs/x.md", "components/a.tsx", "lib/booking/a.ts", "supabase/migrations/1_a.sql", "app/api/cron/x/route.ts", "package.json"]) {
      for (const reason of reasons(rule)) {
        expect(reason, `"${reason}" must stay a single unambiguous field`).not.toMatch(/[\n,;]/);
      }
    }
  });

  it("a full-matrix trigger is NOT silently promoted to T3", () => {
    // Regression guard: classify() sets every lane boolean true when the full
    // matrix is forced. Deriving the tier from those expanded lanes instead of
    // the raw path hits would report a dependency bump as a payment + migration
    // + security change, and T3 ceremony would bleed into trivial work.
    const r = c("package.json");
    expect(r.full_matrix_required).toBe(true);
    expect(r.payment).toBe(true);
    expect(r.baselineRiskTier).toBe("T2");
    expect(r.riskReasons).toEqual(["shared build or runtime configuration changed"]);
  });

  it("an undetectable diff fails safe to T3", () => {
    expect(tier()).toBe("T3");
  });
});
