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
// SEC-ADAPTER-01 — the security-guidance adapter is a SECURITY path
// ---------------------------------------------------------------------------
// `.claude/claude-security-guidance.md` is markdown, and DOCS carries a bare
// /\.md$/, so before this carve-out the file classified docs_only -> T0 -> docs
// lane. A file whose entire purpose is to steer a security reviewer would have
// shipped under documentation CI, and a wrong rule in it has no runtime symptom
// to catch it later.
//
// The carve-out is deliberately ONE file (plus its .local sibling). The last two
// cases here are the controls that keep it that way: ordinary markdown, and the
// rest of the tracked `.claude/` tree, must still route to docs.
describe("classifier — the security-guidance adapter (SEC-ADAPTER-01)", () => {
  it("the adapter alone is a security path at T3, not documentation", () => {
    const r = c(".claude/claude-security-guidance.md");
    expect(r.docs_only).toBe(false);
    expect(r.security).toBe(true);
    expect(r.baselineRiskTier).toBe("T3");
    expect(r.riskReasons).toContain("security or privilege boundary path changed");
  });

  it("the .local sibling routes identically", () => {
    const r = c(".claude/claude-security-guidance.local.md");
    expect(r.docs_only).toBe(false);
    expect(r.security).toBe(true);
    expect(r.baselineRiskTier).toBe("T3");
  });

  it("its parity test routes to the security lane too", () => {
    const r = c("tests/security/security-guidance-parity.test.ts");
    expect(r.security).toBe(true);
    expect(r.docs_only).toBe(false);
    expect(r.baselineRiskTier).toBe("T3");
  });

  it("the adapter alongside docs is still not docs_only", () => {
    // One exception file is enough to defeat the `every` — the point of routing
    // it out of DOCS rather than merely adding it to the security rule.
    const r = c("docs/03_SECURITY_AND_PRIVACY.md", ".claude/claude-security-guidance.md");
    expect(r.docs_only).toBe(false);
    expect(r.security).toBe(true);
  });

  it("the whole SEC-ADAPTER-01 change set forces the full matrix", () => {
    const r = c(
      ".claude/claude-security-guidance.md",
      "tests/security/security-guidance-parity.test.ts",
      "scripts/classify-changes.mjs",
      "tests/ci/classify-changes.test.ts",
    );
    expect(r.security).toBe(true);
    expect(r.ci_workflows).toBe(true);
    expect(r.docs_only).toBe(false);
    expect(r.baselineRiskTier).toBe("T3");
    expect(r.full_matrix_required).toBe(true);
  });

  // Controls: the input set must not promote markdown generally. The four
  // canonical sources are deliberately NOT in this list any more — they are
  // inputs to the control and are asserted security-bearing below.
  it("ordinary markdown still routes to the docs lane", () => {
    for (const f of [
      "README.md",
      "docs/production/current-state.md",
      "docs/09_DATABASE_AND_RLS.md",
      "docs/00_PRODUCT_OVERVIEW.md",
    ]) {
      const r = c(f);
      expect(r.docs_only, `${f} must stay docs_only`).toBe(true);
      expect(r.security, `${f} must not become a security path`).toBe(false);
      expect(r.baselineRiskTier, `${f} must stay T0`).toBe("T0");
    }
  });

  it("the rest of the tracked .claude tree is untouched by the carve-out", () => {
    // `.claude/skills/**` is tracked and also markdown. It is prompts, not
    // security rules, and is deliberately NOT promoted here.
    const r = c(".claude/skills/prototype/SKILL.md");
    expect(r.docs_only).toBe(true);
    expect(r.security).toBe(false);
    expect(r.baselineRiskTier).toBe("T0");
  });

  it("a near-miss filename does not inherit the carve-out", () => {
    for (const f of [
      ".claude/claude-security-guidance.md.bak",
      ".claude/claude-security-guidance-notes.md",
      ".claude/nested/claude-security-guidance.md",
    ]) {
      const r = c(f);
      expect(r.security, `${f} must not match the exception`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// SEC-ADAPTER-01 — the whole INPUT SET of the security-guidance control
// ---------------------------------------------------------------------------
// The parity guard proves the adapter and its canonical sources AGREE, so it has
// to run when EITHER side moves. Routing only the adapter to the security lane
// guarded half of it: with CONTRIBUTING.md, CLAUDE.md, ENGINEERING_STANDARDS.md
// and docs/03 all routing docs-only, a PR could delete the very sentence an
// adapter rule quotes, CI would pick the docs lane, and the parity test that
// exists to catch exactly that would never execute.
//
// The guarded thing is the RELATIONSHIP, so all six inputs route together.
describe("classifier — the security-guidance INPUT SET (SEC-ADAPTER-01)", () => {
  const INPUTS = [
    ".claude/claude-security-guidance.md",
    ".claude/claude-security-guidance.local.md",
    "CONTRIBUTING.md",
    "CLAUDE.md",
    "ENGINEERING_STANDARDS.md",
    "docs/03_SECURITY_AND_PRIVACY.md",
  ];

  it("every input individually selects the security lane at T3", () => {
    for (const f of INPUTS) {
      const r = c(f);
      expect(r.security, `${f} must select the security lane`).toBe(true);
      expect(r.docs_only, `${f} must not be docs_only`).toBe(false);
      expect(r.baselineRiskTier, `${f} must be T3`).toBe("T3");
      expect(r.riskReasons).toContain("security or privilege boundary path changed");
    }
  });

  it("changing ANY canonical source alone selects the lane the parity test runs in", () => {
    // The parity test lives in tests/security/, which the security lane runs.
    // This is the property the guard depends on, asserted per source rather than
    // for the set: one source moving must be enough.
    for (const f of [
      "CONTRIBUTING.md",
      "CLAUDE.md",
      "ENGINEERING_STANDARDS.md",
      "docs/03_SECURITY_AND_PRIVACY.md",
    ]) {
      expect(c(f).security, `${f} alone must run the parity lane`).toBe(true);
      expect(c(f, "tests/security/security-guidance-parity.test.ts").security).toBe(true);
    }
  });

  it("one canonical source alongside ordinary docs is still not docs_only", () => {
    const r = c("README.md", "docs/production/release-changelog.md", "CONTRIBUTING.md");
    expect(r.docs_only).toBe(false);
    expect(r.security).toBe(true);
  });

  it("the set does not make markdown security-bearing in general", () => {
    for (const f of [
      "README.md",
      "docs/production/current-state.md",
      "docs/09_DATABASE_AND_RLS.md",
      "docs/13_DECISIONS.md",
      ".claude/skills/prototype/SKILL.md",
    ]) {
      const r = c(f);
      expect(r.security, `${f} must not be security-bearing`).toBe(false);
      expect(r.docs_only, `${f} must stay docs_only`).toBe(true);
    }
  });

  it("a near-miss filename does not join the set", () => {
    for (const f of [
      "docs/CONTRIBUTING.md",
      "ENGINEERING_STANDARDS.md.bak",
      "docs/03_SECURITY_AND_PRIVACY.md.orig",
      "sub/CLAUDE.md",
      ".claude/nested/claude-security-guidance.md",
    ]) {
      expect(c(f).security, `${f} must not match the input set`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// SEC-ADAPTER-01 — a renamed canonical source is still a security change
// ---------------------------------------------------------------------------
// A rename is the one change shape that can REMOVE a path while looking like an
// ordinary addition. Git's default rename detection reports an R100 as the
// DESTINATION only, so `CONTRIBUTING.md -> CONTRIBUTING-old.md` reached the
// classifier as a single unremarkable `.md` path: docs_only, T0, and the
// security lane that proves the security-guidance adapter still matches its
// sources never ran — while a source it is pinned to had just disappeared.
//
// ci.yml now collects with --no-renames, so both sides arrive. These fixtures
// pin the classification half of that contract: given both sides, the removal
// of a canonical source is visible and selects the security lane.
describe("classifier — renamed canonical security sources (SEC-ADAPTER-01)", () => {
  const CANONICAL = [
    "CONTRIBUTING.md",
    "CLAUDE.md",
    "ENGINEERING_STANDARDS.md",
    "docs/03_SECURITY_AND_PRIVACY.md",
  ];

  it("each canonical source renamed away still selects security at T3", () => {
    for (const source of CANONICAL) {
      const destination = source.replace(/\.md$/, "-old.md");
      // Both sides, as --no-renames produces them.
      const r = c(destination, source);
      expect(r.security, `renaming ${source} must stay a security change`).toBe(true);
      expect(r.docs_only, `renaming ${source} must not be docs_only`).toBe(false);
      expect(r.baselineRiskTier, `renaming ${source} must be T3`).toBe("T3");
    }
  });

  it("the destination ALONE is what the defect looked like", () => {
    // Documents the pre-fix behaviour so the collection-site fix cannot be
    // reverted without this reading as an obvious regression.
    for (const source of CANONICAL) {
      const destination = source.replace(/\.md$/, "-old.md");
      const r = c(destination);
      expect(r.security, `${destination} alone is not recognisable as security`).toBe(false);
      expect(r.docs_only).toBe(true);
    }
  });

  it("the adapter renamed away is still a security change", () => {
    const r = c(".claude/claude-security-guidance-old.md", ".claude/claude-security-guidance.md");
    expect(r.security).toBe(true);
    expect(r.docs_only).toBe(false);
    expect(r.baselineRiskTier).toBe("T3");
  });

  it("an ordinary markdown rename does NOT become security", () => {
    for (const [from, to] of [
      ["README.md", "README-new.md"],
      ["docs/00_PRODUCT_OVERVIEW.md", "docs/00_PRODUCT_OVERVIEW-old.md"],
      ["docs/production/current-state.md", "docs/production/current-state-old.md"],
    ]) {
      const r = c(to, from);
      expect(r.security, `renaming ${from} must not become security`).toBe(false);
      expect(r.docs_only, `renaming ${from} must stay docs_only`).toBe(true);
      expect(r.baselineRiskTier).toBe("T0");
    }
  });

  it("plain addition, modification and deletion are unchanged", () => {
    // --no-renames only affects renames; every other shape must behave as before.
    expect(c("CONTRIBUTING.md").security).toBe(true);
    expect(c("README.md").docs_only).toBe(true);
    expect(c("app/(app)/dashboard/page.tsx").application).toBe(true);
    expect(c("supabase/migrations/0190_x.sql").database).toBe(true);
  });

  it("a duplicated path does not change any decision", () => {
    // Neither collection site can emit a duplicate today — the PR site diffs two
    // commits and the push site shows one — but the guarantee is asserted rather
    // than assumed, because --no-renames changes what the list contains.
    //
    // Every DECISION field is identical. `changed_file_count` is the one field
    // that moves, and it is purely informational: scripts/ci-plan.mjs prints it,
    // and no lane, tier or gate reads it. Asserting that precisely beats forcing
    // deep equality by deduping a number nothing consumes.
    for (const file of ["CONTRIBUTING.md", "README.md", "app/(app)/dashboard/page.tsx"]) {
      const once = c(file);
      const twice = c(file, file);
      const decisions = (r: Result) => {
        const { changed_file_count: _ignored, ...rest } = r;
        return rest;
      };
      expect(decisions(twice), `${file} duplicated must decide identically`).toEqual(decisions(once));
      expect(twice.changed_file_count, "only the informational count reflects the raw list").toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// SEC-ADAPTER-01 — markdown under public/ is SERVED, not documentation
// ---------------------------------------------------------------------------
// Next serves everything in public/ verbatim, so `public/help.md` is deployed
// content. The bare /\.md$/ docs pattern called it documentation, which routed a
// served file to the docs lane and — combined with the matching non-shipping
// exemption in the production-facts guard — would have let it change without
// invalidating the production runtime pin.
describe("classifier — markdown under public/ (SEC-ADAPTER-01)", () => {
  it("public markdown is not documentation", () => {
    for (const f of ["public/help.md", "public/docs/guide.md", "public/a/b/c.md"]) {
      const r = c(f);
      expect(r.docs_only, `${f} is served by Next and must not be docs_only`).toBe(false);
    }
  });

  it("markdown everywhere else is still documentation", () => {
    for (const f of [
      "README.md",
      "docs/03_SECURITY_AND_PRIVACY.md",
      "docs/production/current-state.md",
      "publicity/notes.md", // a near-miss: the prefix must be exactly `public/`
      "app/public/notes.md", // not the served root either
    ]) {
      const r = c(f);
      // docs/03 and CONTRIBUTING are security-guidance INPUTS, so they are not
      // docs_only for a different and deliberate reason; every other one is.
      if (f === "docs/03_SECURITY_AND_PRIVACY.md") {
        expect(r.security, `${f} is a security-guidance input`).toBe(true);
      } else {
        expect(r.docs_only, `${f} must stay docs_only`).toBe(true);
      }
    }
  });

  it("non-markdown public assets are unchanged", () => {
    for (const f of ["public/favicon.ico", "public/robots.txt", "public/img/logo.svg"]) {
      expect(c(f).docs_only, `${f} was never docs_only`).toBe(false);
    }
  });
});
