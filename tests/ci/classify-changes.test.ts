import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error - .mjs utility ships without type declarations
import { REPO_ROOT, classify, dependenciesFor, highestTier, isDocsPath } from "../../scripts/classify-changes.mjs";
import {
  selectBrowserGroups,
  specsForGroups,
  EXTENDED,
  BROWSER_GROUPS,
  PUBLIC_BOOKING_SPECS,
  PUBLIC_BOOKING_PATTERNS,
// @ts-expect-error - .mjs utility ships without type declarations
} from "../../scripts/browser-groups.mjs";
// @ts-expect-error - .mjs utility ships without type declarations
import { scanTestDependencies } from "../../scripts/test-dependencies.mjs";

// Real-time bound, intrinsic: these cases spawn real `git`/`node` subprocesses
// and scan the checkout, which measured 5-11 s each on a loaded host against
// vitest's 5 s default (FLAKE-SYSDEPS). Only the ceiling moves; no assertion does.
vi.setConfig({ testTimeout: 60_000 });

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
    expect(Array.isArray(r.docs_reader_tests), "docs_reader_tests must be a list").toBe(true);
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
// DEPENDENCY-AWARE SELECTION (RECORD-BATCHING-PROPOSAL.md part 2).
//
// A path rule cannot see that a TEST reads or imports a file elsewhere in the
// tree. Each gap below shipped a real hole: the file changed, the lane that
// tests it was skipped, and the guard first ran on the production push.
//
// Every case marked GAP fails on the classifier before this change. Cases
// marked GUARD hold on both and exist so the fix cannot overreach.
// ---------------------------------------------------------------------------

type Deps = {
  db: Record<string, string[]>;
  dbDirs?: Record<string, string[]>;
  docReaders: Record<string, string[]>;
  docReaderDirs?: Record<string, string[]>;
  docWildcard?: string[];
};
const EMPTY = { db: {}, dbDirs: {}, dbRootWalkers: {}, docReaders: {}, docReaderDirs: {}, docWildcard: [] };
// The live scan of this checkout: exactly what classify() uses by default.
const scanned = dependenciesFor() as Deps;
const scan = (root: string) => scanTestDependencies(root, isDocsPath) as Deps;

// Each tree has the repository's real top-level roots, so a missing path is
// judged against roots that exist, as it is in a real checkout.
const tree = (files: Record<string, string>) => {
  const root = mkdtempSync(path.join(tmpdir(), "hone-deps-"));
  const roots = { "docs/README.md": "# docs\n", "lib/keep.ts": "export {};\n", "app/page.tsx": "export {};\n" };
  for (const [file, content] of Object.entries({ ...roots, ...files })) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
};

describe("dependency map — computed from the checkout being classified, never committed (#1053 round 4)", () => {
  // A committed map went stale whenever ANY other PR added a reading test:
  // CI run 39889013435 failed its freshness check on the merge ref, and merged
  // that would have reddened the unit lane of unrelated PRs.
  it("GAP: there is no committed map to go stale", () => {
    expect(existsSync(path.join(REPO_ROOT, "scripts/test-dependencies.json"))).toBe(false);
  });

  it("GAP: classify() uses a scan of this checkout by default", () => {
    expect(scanned).toEqual(scan(REPO_ROOT));
  });

  it("GAP: a reading test added by ANOTHER change is attributed with no regeneration step", () => {
    const root = tree({ "tests/docs/added-elsewhere.test.ts": 'readFileSync("docs/production/current-state.md", "utf8");\n' });
    try {
      expect(scan(root).docReaders["docs/production/current-state.md"]).toEqual(["tests/docs/added-elsewhere.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("GUARD: the real scan finds the known edges, so an empty scan cannot pass quietly", () => {
    // Anti-vacuity. If the scanner broke and found nothing, every GAP case
    // below would fail - but a fixture-only suite would not, so pin real edges.
    expect(scanned.db["lib/waitlist/invite-to-book-adapter.ts"]).toContain(
      "tests/db/waitlist-integration-seams.db.test.ts",
    );
    expect(scanned.db["components/profile-tab.ts"]).toContain("tests/db/client-profile-tab-queries.db.test.ts");
    const edges = Object.values(scanned.db).reduce((n, tests) => n + tests.length, 0);
    expect(edges, "far fewer DB edges than the tree holds").toBeGreaterThanOrEqual(40);
    expect(scanned.docReaders["docs/production/migration-ledger.md"]).toContain(
      "tests/migrations/0179-actor-fk-integrity.test.ts",
    );
  });

  it("GUARD: a path mentioned only in a comment is not an edge", () => {
    // practitioner-identity-boundary.db.test.ts names lib/practitioner-colors.ts
    // in a comment and never reads it. Prose must not widen the DB lane.
    expect(scanned.db["lib/practitioner-colors.ts"]).toBeUndefined();
  });
});

describe("dependency-aware selection — G1: tests/db source contracts", () => {
  // #814. A DB suite reads these files as source contracts. Editing one
  // selected `application` only, so the DB lane was skipped.
  it.each([
    "lib/waitlist/invite-to-book-adapter.ts",
    "lib/waitlist/invite-to-book-contract.ts",
    "app/(app)/settings/waitlist/page.tsx",
    "app/(app)/settings/waitlist/invite-actions.ts",
    "app/invitation/[token]/actions.ts",
    "components/profile-tab.ts",
    // Read through `${process.cwd()}/app/book/[slug]/actions.ts`.
    "app/book/[slug]/actions.ts",
  ])("GAP: %s selects the database lane", (file) => {
    expect(c(file).database).toBe(true);
  });
});

describe("dependency-aware selection — G2: modules DB suites import", () => {
  it.each(["lib/booking/slots.ts", "lib/sessions/charted-session.ts", "lib/google-calendar/sync/operations.ts"])(
    "GAP: %s selects the database lane",
    (file) => {
      expect(scanned.db[file], `${file} is no longer imported by a DB suite`).toBeDefined();
      expect(c(file).database).toBe(true);
    },
  );

  it("GUARD: selecting a lane is not assigning ceremony - the tier is unchanged", () => {
    // The payment rule's distinction, applied here: a DB suite exercising
    // slot maths makes its edit run the DB lane, not a T3 database change.
    expect(tier("lib/booking/slots.ts")).toBe("T2");
    expect(tier("lib/waitlist/invite-to-book-adapter.ts")).toBe("T1");
  });

  it("GAP: the classifier takes the map as data, so the rule is proved without the real tree", () => {
    const deps: Deps = { db: { "lib/x/y.ts": ["tests/db/y.db.test.ts"] }, docReaders: {} };
    expect((classify(["lib/x/y.ts"], deps) as Result).database).toBe(true);
    expect((classify(["lib/x/y.ts"], { db: {}, docReaders: {} }) as Result).database).toBe(false);
  });
});

describe("dependency-aware selection — G3: generated DB types and their drift check", () => {
  // check:db-types runs ONLY in the database lane, so neither file was ever
  // compared against the migrated schema on its own PR.
  it.each(["lib/types/database.ts", "scripts/check-db-types.mjs"])("GAP: %s selects the database lane", (file) => {
    expect(c(file).database).toBe(true);
  });
});

describe("dependency-aware selection — G4: documents read by unit tests", () => {
  it("GAP: a docs-only AGENTS.md change selects docs consistency and names its readers", () => {
    const r = c("AGENTS.md");
    expect(r.docs_only).toBe(true);
    expect(r.docs_consistency).toBe(true);
    // Its named readers, plus the tests that enumerate documentation.
    for (const t of scanned.docReaders["AGENTS.md"]) expect(r.docs_reader_tests).toContain(t);
    expect((r.docs_reader_tests as string[]).some((t) => t.startsWith("tests/openwiki/"))).toBe(true);
  });

  it("GAP: a ledger wording change selects the migration test that pins it", () => {
    const r = c("docs/production/migration-ledger.md");
    expect(r.docs_consistency).toBe(true);
    expect(r.docs_reader_tests).toContain("tests/migrations/0179-actor-fk-integrity.test.ts");
    // ...and stays a cheap docs-only diff in every other respect.
    expect(r.docs_only).toBe(true);
    expect(r.database).toBe(false);
    expect(r.full_matrix_required).toBe(false);
  });

  it("a doc no test names runs only the enumerating readers, and stays cheap", () => {
    // Since #1053 round 4 every document has readers: the tests that enumerate
    // documentation. No test NAMES this one, so those are exactly its readers,
    // and nothing beyond the unit tests runs.
    const r = c("docs/no-test-reads-this-document.md");
    expect(r.docs_only).toBe(true);
    expect(r.docs_consistency).toBe(true);
    expect(r.docs_reader_tests).toEqual([...new Set([...scanned.docWildcard, "tests/ci/pr-release-receipt.test.ts"])].sort());
    expect(r.database).toBe(false);
    expect(r.full_matrix_required).toBe(false);
  });

  it("G1: every docs-only diff runs the receipt check, record or not (Codex #1216 4401470996)", () => {
    for (const f of ["docs/20_NEW_STUDIO_SETUP_RUNBOOK.md", "docs/production/current-state.md", "README.md"]) {
      const r = c(f);
      expect(r.docs_only, f).toBe(true);
      expect(r.docs_consistency, f).toBe(true);
      expect(r.docs_reader_tests, f).toContain("tests/ci/pr-release-receipt.test.ts");
    }
    // Injected deps with no reader at all still select it.
    const empty = classify(["docs/x.md"], { db: {}, dbDirs: {}, docReaders: {}, docReaderDirs: {}, docWildcard: [] }) as Result;
    expect(empty.docs_reader_tests).toEqual(["tests/ci/pr-release-receipt.test.ts"]);
    // A mixed diff is not docs-only: the unit lane runs it, so it is not added here.
    expect(c("docs/20_NEW_STUDIO_SETUP_RUNBOOK.md", "lib/x.ts").docs_only).toBe(false);
  });

  it("a non-document change is never a document-reader selection", () => {
    expect(c("components/sessions/SimplifiedEntryForm.tsx").docs_consistency).toBe(false);
  });

  it("GUARD: the reader list never contains a character that would corrupt $GITHUB_OUTPUT", () => {
    for (const t of Object.values(scanned.docReaders).flat()) {
      expect(t, `"${t}" would break the "; "-joined output`).not.toMatch(/[\n;]/);
    }
  });
});

describe("dependency-aware selection — the selector's own files", () => {
  it.each(["scripts/test-dependencies.mjs", "scripts/docs-paths.mjs"])(
    "GAP: %s is selection logic: full matrix, and extended browser coverage",
    (file) => {
      const r = c(file);
      expect(r.ci_workflows).toBe(true);
      expect(r.full_matrix_required).toBe(true);
      expect(selectBrowserGroups([file]).groups).toEqual([EXTENDED]);
    },
  );

});

describe("dependency-aware selection — file count never narrows a lane", () => {
  // Six hundred presentational files must not drown the one file that needs
  // the DB, payment or browser lane.
  const NOISE = Array.from({ length: 600 }, (_, i) => `components/noise/presentational-${i}.tsx`);

  it("GAP: a DB-dependent file among 600 others still selects the database lane", () => {
    expect(c(...NOISE, "lib/waitlist/invite-to-book-adapter.ts").database).toBe(true);
  });

  it("GUARD: a payment file among 600 others still selects the payment lane", () => {
    expect(c(...NOISE, "lib/stripe/account.ts").payment).toBe(true);
  });

  it("GUARD: unattributable application code among 600 others still fails safe to extended", () => {
    expect(selectBrowserGroups([...NOISE, "app/(app)/dashboard/page.tsx"]).groups).toEqual([EXTENDED]);
  });
});

// ---------------------------------------------------------------------------
// Codex #1053, two P1s against the first scanner.
// ---------------------------------------------------------------------------

describe("dependency-aware selection — a document is whatever the classifier calls docs (4355376845)", () => {
  // The reader map tracked `.md` only, so a unit test reading a JSON manifest
  // under docs/ was invisible: editing that manifest was docs_only with
  // docs_consistency false, and validate and canonical-record both skipped.
  it("GAP: docs/roadmap/CAPABILITY_MANIFEST.json selects the migration test that reads it", () => {
    const r = c("docs/roadmap/CAPABILITY_MANIFEST.json");
    expect(r.docs_only).toBe(true);
    expect(r.docs_consistency).toBe(true);
    expect(r.docs_reader_tests).toContain("tests/migrations/0160-immutable-clinical-lineage.test.ts");
  });

  it("GUARD: every reader-map key is documentation by the classifier's own rule", () => {
    // One definition: a key outside it could never be part of a docs-only diff.
    for (const doc of Object.keys(scanned.docReaders)) {
      expect(c(doc).docs_only, `${doc} is not docs to the classifier`).toBe(true);
    }
  });
});

describe("dependency-aware selection — deleting a file a test still reads (4355376850)", () => {
  // The scanner kept a literal only when it named an EXISTING file, so a PR
  // that deleted a document (or a DB source contract) its readers still read
  // regenerated a map without the edge: the deletion classified docs-only, and
  // the ENOENT first surfaced on the production push.
  it("GAP: a deleted document keeps its reader, and its deletion runs that reader", () => {
    const root = tree({
      "tests/docs/reads-gone.test.ts": 'readFileSync("docs/production/gone.md", "utf8");\n',
      "tests/migrations/reads-gone-manifest.test.ts": 'readFileSync(join(ROOT, "docs", "roadmap", "GONE.json"), "utf8");\n',
    });
    try {
      const deps = scan(root);
      expect(deps.docReaders["docs/production/gone.md"]).toEqual(["tests/docs/reads-gone.test.ts"]);
      expect(deps.docReaders["docs/roadmap/GONE.json"]).toEqual(["tests/migrations/reads-gone-manifest.test.ts"]);
      const r = classify(["docs/production/gone.md"], deps) as Result;
      expect(r.docs_only).toBe(true);
      expect(r.docs_consistency).toBe(true);
      expect(r.docs_reader_tests).toEqual(["tests/ci/pr-release-receipt.test.ts", "tests/docs/reads-gone.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("GAP: a deleted DB source contract keeps its DB suite", () => {
    const root = tree({ "tests/db/reads-gone.db.test.ts": 'readFileSync("lib/waitlist/gone-adapter.ts", "utf8");\n' });
    try {
      const deps = scan(root);
      expect(deps.db["lib/waitlist/gone-adapter.ts"]).toEqual(["tests/db/reads-gone.db.test.ts"]);
      expect((classify(["lib/waitlist/gone-adapter.ts"], deps) as Result).database).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("GUARD: a missing path is kept only when it is path-shaped under an attributable root", () => {
    // Keeping absent paths must not turn every string in a test into an edge.
    const root = tree({
      "tests/docs/noise.test.ts": [
        'expect(x).toBe("see the docs.");',
        'expect(y).toBe("v1.2");',
        'const url = "https://example.com/docs/page.md";',
        'const elsewhere = "tmp/scratch/out.md";',
        'const source = "lib/not-a-doc.ts";',
      ].join("\n"),
      "tests/db/noise.db.test.ts": 'const doc = "docs/not-a-source.md"; const pkg = "node_modules/x/index.js";\n',
    });
    try {
      const deps = scan(root);
      expect(deps).toEqual(EMPTY);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Codex #1053 P1 4355527598: tests that ENUMERATE a directory name no file.
// tests/docs/reminder-cadence-truthfulness.test.ts reads every .md under
// docs/ through readdirSync(ROOT) and a walker over join(ROOT, "docs"); no
// literal names the documents, so a new or edited document selected nothing.
// ---------------------------------------------------------------------------
describe("dependency-aware selection — reads through a DIRECTORY CONSTANT (Codex P1 4362833513)", () => {
  // tests/audits/findings-register-consistency.test.ts reads
  //   const DIR = join(process.cwd(), "docs/audits/2026-07-30");
  //   const read = (f) => readFileSync(join(DIR, f), "utf8");
  //   read("MASTER_FINDINGS_REGISTER.json"); read("MASTER_FINDINGS_REGISTER.csv");
  // No literal names either register, so a docs-only edit that broke their
  // JSON/CSV consistency skipped the one test built to catch it.
  const REGISTER = "tests/audits/findings-register-consistency.test.ts";

  it.each(["docs/audits/2026-07-30/MASTER_FINDINGS_REGISTER.json", "docs/audits/2026-07-30/MASTER_FINDINGS_REGISTER.csv"])(
    "GAP: %s selects the register consistency test",
    (doc) => {
      const r = c(doc);
      expect(r.docs_only).toBe(true);
      expect(r.docs_reader_tests).toContain(REGISTER);
    },
  );

  it("ANTI-OVERREACH: a document outside that directory does not select it", () => {
    expect(c("docs/production/current-state.md").docs_reader_tests).not.toContain(REGISTER);
  });

  it("GAP: a basename that is not statically known makes the test a reader of EVERY file under the directory", () => {
    const root = tree({
      "docs/guides/a.json": "{}\n",
      "tests/docs/reads-guides.test.ts":
        'const DIR = join(process.cwd(), "docs/guides");\nconst read = (f: string) => readFileSync(join(DIR, f), "utf8");\nread(pick());\n',
    });
    try {
      const deps = scan(root);
      expect(deps.docReaderDirs).toEqual({ "docs/guides": ["tests/docs/reads-guides.test.ts"] });
      const r = classify(["docs/guides/brand-new.md"], deps) as Result;
      expect(r.docs_reader_tests).toEqual(["tests/ci/pr-release-receipt.test.ts", "tests/docs/reads-guides.test.ts"]);
      expect((classify(["docs/other/x.md"], deps) as Result).docs_reader_tests ?? []).not.toContain("tests/docs/reads-guides.test.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("GAP: a basename joined as a LITERAL resolves to that file only, not the whole directory", () => {
    const root = tree({
      "docs/guides/a.json": "{}\n",
      "docs/guides/b.json": "{}\n",
      "tests/docs/reads-one.test.ts": 'const DIR = path.join(process.cwd(), "docs", "guides");\nreadFileSync(path.join(DIR, "a.json"), "utf8");\n',
    });
    try {
      const deps = scan(root);
      expect(deps.docReaders?.["docs/guides/a.json"]).toEqual(["tests/docs/reads-one.test.ts"]);
      expect(deps.docReaders?.["docs/guides/b.json"]).toBeUndefined();
      expect(deps.docReaderDirs).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("GAP: a constant relative to __dirname, and a template use, resolve too", () => {
    const root = tree({
      "docs/guides/a.json": "{}\n",
      "tests/docs/rel.test.ts": 'const GUIDES = resolve(__dirname, "../../docs/guides");\nreadFileSync(`${GUIDES}/a.json`, "utf8");\n',
    });
    try {
      expect(scan(root).docReaders?.["docs/guides/a.json"]).toEqual(["tests/docs/rel.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("GUARD: a constant that names no repository directory, or is never used to read, adds nothing", () => {
    const root = tree({
      "tests/docs/none.test.ts": 'const TMP = join(tmpdir(), "scratch");\nconst UNUSED = join(process.cwd(), "docs");\nreadFileSync(join(TMP, f));\n',
    });
    try {
      const deps = scan(root);
      expect(deps.docReaderDirs).toEqual({});
      expect(deps.docReaders).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("GAP (DB lane): a tests/db suite reading lib/ through a directory constant selects the database lane", () => {
    const root = tree({
      "lib/billing/x.ts": "export {};\n",
      "tests/db/reads-billing.db.test.ts": 'const SRC = join(process.cwd(), "lib/billing");\nconst src = (f: string) => readFileSync(join(SRC, f), "utf8");\n',
    });
    try {
      expect(scan(root).dbDirs).toEqual({ "lib/billing": ["tests/db/reads-billing.db.test.ts"] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dependency-aware selection — directory readers (4355527598)", () => {
  it("GAP: a brand-new document selects the test that reads every document under docs/", () => {
    const r = c("docs/brand-new-guide.md");
    expect(r.docs_consistency).toBe(true);
    expect(r.docs_reader_tests).toContain("tests/docs/reminder-cadence-truthfulness.test.ts");
  });

  it("GUARD (operator decision, option b): no DB suite walks a WHOLE source root, so none is silently unselected", () => {
    // tests/db/export-resource-registry.db.test.ts used to walk app/, lib/ and
    // components/ to decide whether application code still references what the
    // registry claims, which no application change could select. That half is
    // now a unit test against supabase/schema-snapshot.json
    // (tests/lib/export/registry-app-references.test.ts), run on every
    // application PR. A NEW whole-root DB walker reappearing here is the same
    // gap again and must be a deliberate decision, not a scan side effect.
    const walkers = (scanned as Deps & { dbRootWalkers?: Record<string, string[]> }).dbRootWalkers ?? {};
    expect(walkers).toEqual({});
    expect(Object.keys(scanned.dbDirs ?? {}).filter((d) => !d.includes("/"))).toEqual([]);
    expect(c("components/brand-new-widget.tsx").database).toBe(false);
    // The schema snapshot that check trusts selects the DB lane, which is
    // where it is compared with the live catalogue.
    expect(c("supabase/schema-snapshot.json").database).toBe(true);
  });

  it("GAP: an enumerated literal directory covers every file beneath it, present or future", () => {
    const root = tree({
      "docs/runbooks/one.md": "# one\n",
      "tests/docs/walks-runbooks.test.ts": 'for (const f of readdirSync(join(ROOT, "docs", "runbooks"))) read(f);\n',
      "lib/billing/keep.ts": "export {};\n",
      "tests/db/walks-billing.db.test.ts": 'for (const f of readdirSync(join("lib", "billing"))) read(f);\n',
    });
    try {
      const deps = scan(root);
      expect(deps.docReaderDirs).toEqual({ "docs/runbooks": ["tests/docs/walks-runbooks.test.ts"] });
      expect(deps.dbDirs).toEqual({ "lib/billing": ["tests/db/walks-billing.db.test.ts"] });
      expect((classify(["docs/runbooks/added-later.md"], deps) as Result).docs_reader_tests).toEqual(["tests/ci/pr-release-receipt.test.ts", "tests/docs/walks-runbooks.test.ts"]);
      expect((classify(["lib/billing/added-later.ts"], deps) as Result).database).toBe(true);
      expect((classify(["lib/elsewhere/added-later.ts"], deps) as Result).database).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("GAP: an enumerating test that touches docs through a VARIABLE reads every document", () => {
    // `readdirSync(ROOT)` + a `.md` filter: the directory is not a literal, so
    // the test is selected conservatively for any document.
    const root = tree({ "tests/docs/root-docs.test.ts": 'readdirSync(ROOT).filter((f) => f.endsWith(".md"));\n' });
    try {
      const deps = scan(root);
      expect(deps.docWildcard).toEqual(["tests/docs/root-docs.test.ts"]);
      expect((classify(["SOMETHING.md"], deps) as Result).docs_reader_tests).toEqual(["tests/ci/pr-release-receipt.test.ts", "tests/docs/root-docs.test.ts"]);
      expect((classify(["lib/keep.ts"], deps) as Result).docs_reader_tests).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("GUARD: naming a directory without enumerating is not a directory read", () => {
    // Elsewhere "lib" and "docs" are words; only an enumerating test reads one.
    const root = tree({
      "tests/db/names-lib.db.test.ts": 'expect(where).toBe("lib");\n',
      "tests/docs/names-docs.test.ts": 'expect(kind).toBe("docs");\n',
      "tests/lib/enumerates-no-docs.test.ts": 'readdirSync(join(ROOT, "lib"));\n',
    });
    try {
      const deps = scan(root);
      expect(deps.dbDirs).toEqual({});
      expect(deps.docReaderDirs).toEqual({});
      expect(deps.docWildcard).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Codex #1053 P2 4355661335. The documented CLI deadlocked: the scanner
// dynamically imported classify-changes.mjs, which statically imports the
// scanner, so its top-level await never settled (exit 13, empty stdout).
describe("the scanner's own CLI", () => {
  it("`node scripts/test-dependencies.mjs` exits 0 and prints the map", () => {
    const run = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts/test-dependencies.mjs")], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(run.status, `exit ${run.status}; stderr: ${run.stderr}`).toBe(0);
    const map = JSON.parse(run.stdout) as Deps;
    expect(map).toEqual(scanned);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 1132-CLASSIFIER-GAP. A change to the public booking surface must select every
// spec that books through the public form, not only the `booking` group's.
// #1132 changed app/book/[slug]/actions.ts and ran 44 specs; three that book
// through that form (two in `portal`, one in `responsive`) were never selected.
// ---------------------------------------------------------------------------
describe("classifier - the public booking surface selects every spec that books through it", () => {
  const specsFor = (...files: string[]): string[] => {
    const r = selectBrowserGroups(files) as { groups: string[]; extended: boolean };
    expect(r.extended, "a targeted selection, so the proof is about groups, not 'everything'").toBe(false);
    return specsForGroups(r.groups) as string[];
  };

  it("a change to the public booking ACTION selects all 21 audited public-booking specs", () => {
    expect(PUBLIC_BOOKING_SPECS).toHaveLength(21);
    const selected = new Set(specsFor("app/book/[slug]/actions.ts"));
    const missing = PUBLIC_BOOKING_SPECS.filter((s: string) => !selected.has(s));
    expect(missing, "public-booking specs not selected for a change to the action").toEqual([]);
  });

  it.each([
    "app/book/[slug]/actions.ts",
    "app/book/[slug]/PublicBookForm.tsx",
    "lib/booking/slots.ts",
    "lib/booking/new-client-admission.ts",
  ])("%s selects the three specs the #1132 run missed", (file) => {
    const selected = new Set(specsFor(file));
    for (const s of ["appointment-token-hash.spec.ts", "public-cancel-policy-change.spec.ts", "mobile-ux.spec.ts"]) {
      expect(selected.has(s), `${s} not selected for ${file}`).toBe(true);
    }
  });

  it("the responsive group is selected, which is where mobile-ux lives", () => {
    const r = selectBrowserGroups(["app/book/[slug]/actions.ts"]) as { groups: string[] };
    expect(r.groups).toContain("responsive");
    expect(r.groups).toContain("portal");
  });

  it("NEGATIVE CONTROL: a path outside the public booking surface does not pull the three in", () => {
    const selected = new Set(specsFor("app/(app)/calendar/DayColumn.tsx"));
    expect(selected.has("appointment-token-hash.spec.ts")).toBe(false);
    expect(selected.has("mobile-ux.spec.ts")).toBe(false);
  });

  it("every listed spec exists and is filed in a group (so naming it selects something real)", () => {
    const filed = new Set(
      Object.values(BROWSER_GROUPS as Record<string, { specs: string[] }>).flatMap((g) => g.specs),
    );
    for (const s of PUBLIC_BOOKING_SPECS as string[]) {
      expect(existsSync(path.join(REPO_ROOT, "e2e", s)), `${s} is not on disk`).toBe(true);
      expect(filed.has(s), `${s} is in no browser group`).toBe(true);
    }
  });

  it("DRIFT GUARD: every spec that books through the public form is listed", () => {
    // The audit's detector, comment lines stripped: the booking helper, a goto to
    // /book or /b/, or the public booking action and commands by name.
    const code = (t: string) =>
      t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const books =
      /(bookAppointment\(|goto\([^)]*(\/book\/|\/b\/)|publicBookAppointmentAction|create_public_appointment|create_waitlist_public_appointment)/;
    const found: string[] = [];
    for (const dir of ["e2e", "e2e-payment"]) {
      for (const f of readdirSync(path.join(REPO_ROOT, dir))) {
        if (!f.endsWith(".spec.ts")) continue;
        if (books.test(code(readFileSync(path.join(REPO_ROOT, dir, f), "utf8")))) found.push(f);
      }
    }
    expect(found.length, "the detector found nothing: it is broken, not clean").toBeGreaterThan(10);
    const listed = new Set(PUBLIC_BOOKING_SPECS as string[]);
    expect(
      found.filter((f) => !listed.has(f)),
      "specs that book through the public form but are not in PUBLIC_BOOKING_SPECS",
    ).toEqual([]);
  });

  it("the patterns are the action and the booking helpers, and nothing broader", () => {
    expect((PUBLIC_BOOKING_PATTERNS as RegExp[]).map(String)).toEqual([String(/^app\/book\//), String(/^lib\/booking\//)]);
  });
});
