import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error - .mjs utility ships without type declarations
import { classify, highestTier, NO_TEST_DEPENDENCIES } from "../../scripts/classify-changes.mjs";
// @ts-expect-error - .mjs utility ships without type declarations
import { loadTestDependencies } from "../../scripts/test-dependencies.mjs";
// @ts-expect-error - .mjs utility ships without type declarations
import { buildPlan } from "../../scripts/ci-plan.mjs";

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

  // TRUTH-01A. The export resource registry asserts things about the SCHEMA -
  // that every table has a disposition and every column of an exported table is
  // accounted for - and only the database lane can check them. If a registry
  // edit ever classifies as application-only again, a disposition could be
  // retired without the guard that proves the retirement honest ever running.
  it("an export-registry edit runs the database lane, not application only", () => {
    const r = c("lib/export/resource-registry.ts");
    expect(r.database).toBe(true);
    expect(r.application).toBe(true);
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
      "docs_consistency",
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
    // CONTRIBUTING.md lists app/calendar-feed/[token] among the public token
    // routes. It serves studio calendar data to an unauthenticated bearer, so
    // it must not sit in the workflow tier alongside ordinary calendar code.
    ["calendar feed token route", "app/calendar-feed/[token]/route.ts"],
    ["calendar feed token helper", "lib/calendar-feed/token.ts"],
    // The payment lane matches the literal words "payment"/"stripe" in a path,
    // so these money-moving actions are invisible to it.
    ["manual fee server action", "app/(app)/calendar/[id]/manual-fee-actions.ts"],
    ["quick checkout server action", "app/(app)/quick-checkout-actions.ts"],
    ["billing proof surface", "tests/lib/billing/live-mode-blockers.test.ts"],
  ] as const) {
    it(`a ${label} change is T3`, () => {
      expect(tier(file)).toBe("T3");
    });
  }

  it("escalates money-moving ACTIONS without dragging payment UI to T3", () => {
    // Precision matters both ways: under-classifying charge authority is a
    // safety gap, and promoting a button to T3 is the ceremony bleed this
    // standard exists to stop.
    expect(tier("app/(app)/quick-checkout-actions.ts")).toBe("T3");
    expect(tier("components/checkout-button.tsx")).toBe("T1");
    expect(tier("components/quick-checkout-modal.tsx")).toBe("T1");
    // Ordinary non-money server actions keep their workflow tier.
    expect(tier("app/(app)/clients/[id]/personal-notes-actions.ts")).toBe("T2");
  });

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

// ---------------------------------------------------------------------------
// INDEPENDENT REVIEW — two classifier precision findings.
// ---------------------------------------------------------------------------
describe("classifier — conventional nested server actions (review P1-1)", () => {
  // Hone uses THREE server-action shapes and the rule originally matched two,
  // so a colocated `actions.ts` beside its page fell through to the generic T1
  // application signal. `app/(app)/dashboard/actions.ts` is real, is
  // `"use server"`, and signs the user out.
  it("a colocated app/**/actions.ts is a server-action boundary, not ordinary UI", () => {
    expect(tier("app/(app)/dashboard/actions.ts")).toBe("T2");
    expect(reasons("app/(app)/dashboard/actions.ts")).toEqual([
      "server API or server action boundary changed",
    ]);
    expect(tier("app/(app)/notifications/actions.ts")).toBe("T2");
  });

  it("a higher deterministic boundary still wins over the nested-action rule", () => {
    // Highest-tier-wins is what keeps this rule from DE-escalating anything.
    expect(tier("app/(auth)/login/actions.ts")).toBe("T3");
    expect(tier("app/admin/studios/[id]/actions.ts")).toBe("T3");
    expect(tier("app/manage/[token]/actions.ts")).toBe("T3");
    expect(reasons("app/(auth)/login/actions.ts")).toEqual([
      "authentication or tenancy boundary path changed",
    ]);
    expect(reasons("app/manage/[token]/actions.ts")).toEqual([
      "public or token-authenticated route changed",
    ]);
  });

  it("is anchored to app/ — it does not sweep in fixtures or unrelated modules", () => {
    // An unanchored /actions\.ts$/ would fire on files that are not server
    // boundaries at all, and a rule that cries wolf gets ignored.
    expect(tier("tests/fixtures/b8-base-f2d4a5aa/calendar-actions.ts.txt")).not.toBe("T2");
    expect(reasons("docs/actions.ts.md")).toEqual([
      "documentation and non-runtime files only",
    ]);
  });
});

describe("classifier — payment AUTHORITY vs the broad payment lane (review P1-2)", () => {
  // The CI payment lane matches the bare words payment/stripe anywhere in a
  // path. Correct for selecting tests; wrong for assigning ceremony. The tier
  // now names authority surfaces; the lane is untouched.
  const AUTHORITY = [
    "lib/billing/session-payment-charge.ts",
    "lib/stripe/account.ts",
    "lib/stripe/setup-intent.ts",
    "app/api/stripe/webhook/route.ts",
    "app/(app)/quick-checkout-actions.ts",
    "app/(app)/calendar/[id]/manual-fee-actions.ts",
    "tests/lib/billing/live-mode-blockers.test.ts",
  ];
  const PRESENTATION = [
    "components/payment-method-card.tsx",
    "components/quick-checkout-modal.tsx",
    "components/checkout-button.tsx",
  ];

  it.each(AUTHORITY)("%s is payment authority — T3", (f) => {
    expect(tier(f)).toBe("T3");
    expect(reasons(f)).toContain("payment authority path changed");
  });

  it.each(PRESENTATION)("%s is presentation — T1, not T3 by filename", (f) => {
    expect(tier(f)).toBe("T1");
    expect(reasons(f)).toEqual([
      "application or interface code with no higher-risk path signal",
    ]);
  });

  it("THE REGRESSION: a read-only payment card stays T1 while its CI lane still fires", () => {
    // This single case is the finding. Under `lane: "payment"` this file
    // baselined T3, so a copy tweak on read-only practitioner UI — no Charge,
    // no Replace, no Remove — demanded the heaviest process in the system.
    // Both halves matter: the tier drops AND the lane must not.
    const r = c("components/payment-method-card.tsx");
    expect(r.baselineRiskTier).toBe("T1");
    expect(r.payment, "CI payment lane selection must be unchanged").toBe(true);
  });

  it("money-moving actions are caught by what they DO, not by living under a payment path", () => {
    // `manual-fee` and `quick-checkout` are named for the fee they charge and
    // sit nowhere near lib/billing.
    for (const f of [
      "app/(app)/calendar/[id]/manual-fee-actions.ts",
      "app/(app)/quick-checkout-actions.ts",
      "app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts",
    ]) {
      expect(tier(f), f).toBe("T3");
    }
    // ...while a settings action that configures amounts is an ordinary server
    // boundary, escalated semantically if it ever moves money.
    expect(tier("app/(app)/settings/payments/fee-amounts-actions.ts")).toBe("T2");
  });

  it.each([
    "app/(app)/quick-checkout-actions.ts",
    "app/(app)/calendar/[id]/manual-fee-actions.ts",
    "components/quick-checkout-modal.tsx",
    "components/checkout-button.tsx",
    "tests/app/sessions/quick-checkout.test.ts",
    "tests/app/calendar/manual-fee-endpoint-authority.test.ts",
  ])("%s selects the fake-payment gate independently of its risk tier", (file) => {
    expect(c(file).payment).toBe(true);
  });

  it("does not mistake an unrelated calendar action for payment", () => {
    expect(c("app/(app)/calendar/reschedule-actions.ts").payment).toBe(false);
  });
});

describe("classifier — mixed diffs still take the highest tier", () => {
  it("T1 + T3 => T3, and only the winning tier's reasons are reported", () => {
    const r = c("components/payment-method-card.tsx", "lib/stripe/account.ts");
    expect(r.baselineRiskTier).toBe("T3");
    expect(r.riskReasons).toEqual(["payment authority path changed"]);
  });

  it("T2 + T3 => T3", () => {
    expect(tier("app/(app)/dashboard/actions.ts", "supabase/migrations/0177_x.sql")).toBe("T3");
    expect(tier("lib/booking/slots.ts", "app/api/stripe/webhook/route.ts")).toBe("T3");
  });

  it("reason ordering is deterministic and independent of input order", () => {
    const a = c("supabase/migrations/0177_x.sql", "lib/security/x.ts").riskReasons;
    const b = c("lib/security/x.ts", "supabase/migrations/0177_x.sql").riskReasons;
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// Record batching part 2: dependency-aware selection (G1-G4).
//
// Path-only selection skipped the database lane for a file a tests/db suite
// imports or reads as source (#814), never compared generated DB types on their
// own PR, and ran no test at all for a docs-only change to a doc a unit test
// reads. Every case here uses the REAL scan of this checkout, so they also fail
// if the scan silently goes empty (see the anti-vacuity case). The WIRING cases
// spawn the real CLI, which scans every test file, so they carry an explicit
// timeout: a loaded parallel run must not report a budget as a failure.
// ---------------------------------------------------------------------------

type Deps = { db: Map<string, string[]>; docReaders: Map<string, string[]> };
const REAL = loadTestDependencies() as Deps;
const withDeps = (deps: Deps, ...files: string[]) => classify(files, deps) as Result;
const real = (...files: string[]) => withDeps(REAL, ...files);

describe("classifier — test-dependency selection (record batching part 2)", () => {
  it("G1: a tests/db source-contract target selects the database lane (the #814 regression)", () => {
    const r = real("lib/waitlist/invite-to-book-adapter.ts");
    expect(r.database).toBe(true);
    expect(r.application).toBe(true);
    expect(r.full_matrix_required).toBe(false);
  });

  it("G1: every source-contract target the proposal measured selects the database lane", () => {
    for (const f of [
      "lib/waitlist/invite-to-book-adapter.ts",
      "lib/waitlist/invite-to-book-contract.ts",
      "app/(app)/settings/waitlist/page.tsx",
      "app/(app)/settings/waitlist/invite-actions.ts",
      "app/invitation/[token]/actions.ts",
      "components/profile-tab.ts",
    ]) {
      expect(real(f).database, f).toBe(true);
    }
  });

  it("G2: a module imported by a DB suite selects the database lane", () => {
    expect(real("lib/booking/slots.ts").database).toBe(true);
    expect(real("lib/google-calendar/sync/handler.ts").database).toBe(true);
  });

  it("G3: generated DB types and the drift script select the database lane, with or without the scan", () => {
    for (const f of ["lib/types/database.ts", "scripts/check-db-types.mjs"]) {
      expect(c(f).database, `${f} (path rule)`).toBe(true);
      expect(real(f).database, `${f} (with scan)`).toBe(true);
    }
  });

  it("an unrelated app file still does not select the database lane (no blanket DB lane)", () => {
    expect(REAL.db.has("components/add-pricing-form.tsx")).toBe(false);
    const r = real("components/add-pricing-form.tsx");
    expect(r.database).toBe(false);
    expect(r.application).toBe(true);
  });

  it("the scanner finds the known edges (anti-vacuity)", () => {
    expect(REAL.db.get("lib/waitlist/invite-to-book-adapter.ts")).toContain(
      "tests/db/waitlist-integration-seams.db.test.ts",
    );
    expect(REAL.db.get("components/profile-tab.ts")).toContain("tests/db/client-profile-tab-queries.db.test.ts");
    const edges = [...REAL.db.values()].reduce((n, l) => n + l.length, 0);
    expect(edges).toBeGreaterThanOrEqual(40);
    expect(REAL.docReaders.get("docs/production/migration-ledger.md")?.length ?? 0).toBeGreaterThanOrEqual(10);
  });

  it("the scanner sees a path built by path.join/resolve from literal segments", () => {
    // This test reads the doc through join(..., "docs", "integrations", ...),
    // never as one literal, so only the joined-literal pass finds it.
    expect(REAL.docReaders.get("docs/integrations/google-calendar-sync.md")).toContain(
      "tests/app/google-calendar/b2-3-c-worker-activation-gate.test.ts",
    );
  });

  it("the scan lists only real files, DB suites as DB readers and unit tests as doc readers", () => {
    for (const [target, suites] of REAL.db) {
      expect(target, "a path-selected database file is not listed").not.toMatch(/^(tests\/(db|migrations)|supabase)\//);
      for (const s of suites) expect(s).toMatch(/^tests\/db\/.*\.db\.test\.ts$/);
    }
    for (const [doc, readers] of REAL.docReaders) {
      expect(doc).toMatch(/\.md$/);
      for (const t of readers) {
        expect(t).toMatch(/^tests\/.*\.test\.ts$/);
        expect(t.startsWith("tests/db/"), `${t} needs a database and cannot run docs-only`).toBe(false);
      }
    }
  });

  it("the dependency edges come from the injected scan, not from the path map", () => {
    const fixture: Deps = { db: new Map([["lib/zz/only-in-fixture.ts", ["tests/db/zz.db.test.ts"]]]), docReaders: new Map() };
    expect(withDeps(fixture, "lib/zz/only-in-fixture.ts").database).toBe(true);
    expect(withDeps(NO_TEST_DEPENDENCIES as Deps, "lib/zz/only-in-fixture.ts").database).toBe(false);
    expect(c("lib/waitlist/invite-to-book-adapter.ts").database, "no scan means path-only, as before").toBe(false);
  });

  it("a dependency edge never lowers or raises the baseline tier", () => {
    for (const f of ["lib/waitlist/invite-to-book-adapter.ts", "lib/booking/slots.ts", "components/profile-tab.ts"]) {
      expect(real(f).baselineRiskTier, f).toBe(c(f).baselineRiskTier);
      expect(real(f).riskReasons, f).toEqual(c(f).riskReasons);
    }
  });

  it("the scan only ever ADDS lanes", () => {
    const lanes = ["application", "database", "security", "payment", "google_calendar", "browser_core", "mobile", "ci_workflows", "full_matrix_required"];
    for (const f of [
      "app/(app)/dashboard/page.tsx",
      "lib/booking/slots.ts",
      "lib/billing/session-payment-amount.ts",
      "lib/google-calendar/sync/handler.ts",
      "package.json",
      "supabase/migrations/0166_example.sql",
      "docs/production/migration-ledger.md",
    ]) {
      const before = c(f);
      const after = real(f);
      for (const k of lanes) if (before[k] === true) expect(after[k], `${f}: ${k}`).toBe(true);
    }
  });

  it("G4: a docs-only change to a doc read by a unit test selects docs consistency", () => {
    const r = real("AGENTS.md");
    expect(r.docs_only).toBe(true);
    expect(r.docs_consistency).toBe(true);
    expect(r.docs_consistency_tests).toContain("tests/openwiki/");

    const ledger = real("docs/production/migration-ledger.md");
    expect(ledger.docs_consistency).toBe(true);
    expect((ledger.docs_consistency_tests as string).split(" ")).toContain(
      "tests/migrations/0179-actor-fk-integrity.test.ts",
    );
    // Still cheap: docs consistency is unit-only.
    for (const k of ["application", "database", "browser_core", "full_matrix_required"]) {
      expect(ledger[k], k).toBe(false);
    }
  });

  it("G4: the selected readers are exactly the union for the changed docs, sorted and de-duplicated", () => {
    const r = real("AGENTS.md", "CLAUDE.md");
    const expected = [...new Set([...(REAL.docReaders.get("AGENTS.md") ?? []), ...(REAL.docReaders.get("CLAUDE.md") ?? [])])].sort();
    expect((r.docs_consistency_tests as string).split(" ")).toEqual(expected);
  });

  it("G4: an unread doc stays cheap", () => {
    const r = real("docs/zz-never-read-by-any-test.md");
    expect(r.docs_only).toBe(true);
    expect(r.docs_consistency).toBe(false);
    expect(r.docs_consistency_tests).toBe("");
    for (const k of ["application", "database", "security", "browser_core", "full_matrix_required"]) {
      expect(r[k], k).toBe(false);
    }
  });

  it("G4: docs consistency is only for docs-only diffs (validate already runs every unit test otherwise)", () => {
    const r = real("AGENTS.md", "app/page.tsx");
    expect(r.docs_only).toBe(false);
    expect(r.docs_consistency).toBe(false);
  });

  it("every selected reader path is safe as an unquoted `npx vitest run` argument", () => {
    for (const readers of REAL.docReaders.values()) {
      for (const t of readers) expect(t).toMatch(/^[A-Za-z0-9._/-]+$/);
    }
  });

  it("the scanner is a CI control file: changing it forces the full matrix", () => {
    const r = c("scripts/test-dependencies.mjs");
    expect(r.ci_workflows).toBe(true);
    expect(r.full_matrix_required).toBe(true);
  });

  it("WIRING: the CLI that ci.yml runs passes the real scan", () => {
    const out = execFileSync("node", ["scripts/classify-changes.mjs", "--files", "lib/waitlist/invite-to-book-adapter.ts"], {
      encoding: "utf8",
    });
    expect(out).toMatch(/^database=true$/m);
    const docs = execFileSync("node", ["scripts/classify-changes.mjs", "--files", "AGENTS.md"], { encoding: "utf8" });
    expect(docs).toMatch(/^docs_consistency=true$/m);
    expect(docs).toMatch(/^docs_consistency_tests=.*\btests\/openwiki\//m);
  }, 30_000);

  it("WIRING: the scan reads the script's own repository, whatever the cwd", () => {
    const out = execFileSync("node", [path.resolve("scripts/classify-changes.mjs"), "--files", "lib/booking/slots.ts"], {
      cwd: tmpdir(),
      encoding: "utf8",
    });
    expect(out).toMatch(/^database=true$/m);
  }, 30_000);

  it("WIRING: ci:plan (and so verify:changed) uses the same scan", () => {
    const plan = buildPlan(["lib/waitlist/invite-to-book-adapter.ts"]);
    const db = plan.lanes.find((l: { lane: string }) => l.lane === "db integration (local supabase)");
    expect(db.run).toBe(true);
  });
});
