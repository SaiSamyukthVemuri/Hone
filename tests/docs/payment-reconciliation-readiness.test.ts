import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #282. Docs-level guardrails for the payment reconciliation +
// controlled live-payment readiness runbook (docs/16 §17). This PR is
// READINESS + RECONCILIATION ONLY — it does not enable live payments,
// change any Stripe key/env, or alter charge/refund/webhook behavior.
//
// These pins prove the runbook documents the safe procedure (forbidden
// actions, rollback, read-only reconciliation queries) and that the
// reconciliation SQL snippets are genuinely SELECT-only. The runtime
// dormancy guards are pinned elsewhere (tests/lib/billing/live-mode-
// blockers.test.ts); the prior readiness pins live in
// tests/docs/live-payments-readiness.test.ts (still green — PR #282 is
// additive).

function readDoc(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
}

const READINESS = readDoc("docs/16_LIVE_PAYMENTS_READINESS.md");
const PAYMENTS = readDoc("docs/06_PAYMENTS_AND_STRIPE.md");
const DEPLOY = readDoc("docs/10_DEPLOYMENT_AND_ENV.md");
const SMOKE = readDoc("docs/12_SMOKE_TESTS.md");
const DECISIONS = readDoc("docs/13_BACKLOG_AND_DECISIONS.md");
const HANDOFF = readDoc("docs/14_AI_HANDOFF.md");

// Extract the §17 runbook block so prose elsewhere in the long doc
// (e.g. "conditional UPDATE" in §4d-style descriptions) cannot satisfy
// or pollute these assertions.
const SECTION_17 = (() => {
  const start = READINESS.indexOf(
    "## 17. Payment reconciliation + controlled live-payment readiness runbook",
  );
  expect(start, "docs/16 §17 must exist").toBeGreaterThan(-1);
  return READINESS.slice(start);
})();

// ---------------------------------------------------------------------------
// Readiness state: live payments still disabled, enablement is separate.
// ---------------------------------------------------------------------------
describe("docs/16 §17: current post-live state (live-capable; Willow still supervised)", () => {
  // Post-live-proof (2026-07-05): live billing was proven on a controlled test
  // studio, so §17 now leads with the current truth. The pre-flip snapshot is
  // retained but clearly labeled historical (2026-07-02). These pins were
  // consciously updated from the old "live payments are disabled" posture.
  it("states the current post-live truth (live-capable, proven on a controlled test studio)", () => {
    expect(SECTION_17).toMatch(/production is now LIVE-CAPABLE/i);
    expect(SECTION_17).toMatch(/Live billing (is|has been) PROVEN on a controlled test studio/i);
    // The pre-flip snapshot is retained but clearly labeled historical.
    expect(SECTION_17).toMatch(/\(historical — 2026-07-02\)/);
  });

  it("keeps Willow's own enablement supervised and does not overclaim broad rollout", () => {
    expect(SECTION_17).toMatch(/Willow still requires her (OWN|own) (live )?onboarding/i);
    expect(SECTION_17).toMatch(/supervised/i);
    expect(SECTION_17).toMatch(/Public booking card collection is OFF/i);
    // The PR #282 historical scope note (enablement was a separate step) is
    // preserved as a record of what that PR did.
    expect(SECTION_17).toMatch(/separate[\s,]*explicit[\s\S]{0,40}owner-approved[\s\S]{0,20}future step/i);
  });

  it("documents that PR #281 success persistence is complete and authoritative", () => {
    expect(SECTION_17).toMatch(/PR #281/);
    expect(SECTION_17).toMatch(/requires?\s+\*?\*?Stripe success/i);
    expect(SECTION_17).toMatch(/ledger (write|persistence)/i);
  });

  it("documents the webhook reconciliation backstop", () => {
    expect(SECTION_17).toMatch(/payment_intent\.succeeded/);
    expect(SECTION_17).toMatch(/backstop/i);
  });

  it("documents operator visibility via the admin Ops alerts page", () => {
    expect(SECTION_17).toMatch(/\/admin\/ops-alerts/);
    expect(SECTION_17).toMatch(/Ops alerts/);
  });
});

// ---------------------------------------------------------------------------
// Forbidden actions + rollback are listed.
// ---------------------------------------------------------------------------
describe("docs/16 §17: forbidden actions without owner approval", () => {
  it("lists the four forbidden live-enablement actions", () => {
    expect(SECTION_17).toMatch(/STRIPE_ALLOW_LIVE_MODE=true/);
    expect(SECTION_17).toMatch(/live Stripe keys|sk_live_/);
    expect(SECTION_17).toMatch(/live charge/i);
    expect(SECTION_17).toMatch(/card-required/i);
  });
});

describe("docs/16 §17: rollback plan is listed", () => {
  it("has an explicit rollback section with the key steps", () => {
    expect(SECTION_17).toMatch(/Rollback plan/i);
    expect(SECTION_17).toMatch(/Disable the live-mode env flag/i);
    expect(SECTION_17).toMatch(/sk_test_/);
    expect(SECTION_17).toMatch(/[Pp]ause the charging path/);
    expect(SECTION_17).toMatch(/Inspect[\s\S]{0,40}ops alerts/i);
    expect(SECTION_17).toMatch(/Stripe dashboard/);
  });
});

describe("docs/16 §17: Before / During / After controlled-payment checklist", () => {
  it("has Before, During, and After sections", () => {
    expect(SECTION_17).toMatch(/Before the first controlled live payment/i);
    expect(SECTION_17).toMatch(/During the first controlled live payment/i);
    expect(SECTION_17).toMatch(/After the first controlled live payment/i);
  });

  it("During: one studio, one operator, one small payment, stop on mismatch", () => {
    expect(SECTION_17).toMatch(/One studio only/i);
    expect(SECTION_17).toMatch(/One operator/i);
    expect(SECTION_17).toMatch(/One small controlled payment/i);
    expect(SECTION_17).toMatch(/Stop immediately on any mismatch/i);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation SQL snippets are READ-ONLY (SELECT only).
// ---------------------------------------------------------------------------
describe("docs/16: reconciliation SQL snippets are read-only", () => {
  // The §17.7 reconciliation snippets must all be SELECT-only. (We scope
  // to §17 deliberately: docs/16 §12.12 contains a FUTURE schema sketch
  // with DDL in ```sql fences that is informational, not a runnable
  // reconciliation query.)
  const sqlBlocks = Array.from(
    SECTION_17.matchAll(/```sql\n([\s\S]*?)```/g),
  ).map((m) => m[1]);

  it("at least the six §17.7 reconciliation queries exist", () => {
    expect(sqlBlocks.length).toBeGreaterThanOrEqual(6);
  });

  it("every sql block begins with a SELECT (after comments)", () => {
    for (const block of sqlBlocks) {
      const firstStatement = block
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("--"))
        .join(" ");
      expect(firstStatement, `block must start with select: ${block.slice(0, 60)}`).toMatch(
        /^select\b/i,
      );
    }
  });

  it("no sql block contains INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE as a statement keyword", () => {
    // Strip SQL comments first so prose like "did not persist" or a
    // "-- ..." note cannot trip the keyword scan.
    for (const block of sqlBlocks) {
      const code = block
        .split("\n")
        .map((l) => l.replace(/--.*$/, ""))
        .join("\n");
      expect(code).not.toMatch(/\b(insert|update|delete|drop|alter|truncate)\b/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Stripe gate expectations remain documented (unchanged by this PR).
// ---------------------------------------------------------------------------
describe("docs/16 §17: Stripe gate expectations unchanged", () => {
  it("documents one paymentIntents.create / one refunds.create / zero charges / zero checkout", () => {
    expect(SECTION_17).toMatch(/\*\*one\*\*\s*`paymentIntents\.create`/i);
    expect(SECTION_17).toMatch(/\*\*one\*\*\s*`refunds\.create`/i);
    expect(SECTION_17).toMatch(/\*\*zero\*\*\s*`charges\.create`/i);
    expect(SECTION_17).toMatch(/\*\*zero\*\*\s*`checkout\.sessions`/i);
  });

  it("the corrected §7.2 names session-payment-charge.ts, not the deleted manual-fee-charge.ts", () => {
    // The stale reference must be gone from the operator command block.
    expect(READINESS).toMatch(
      /1 occurrence in lib\/billing\/session-payment-charge\.ts only/,
    );
  });
});

// ---------------------------------------------------------------------------
// Reconciliation snippets reference the right tables + the #281 events.
// ---------------------------------------------------------------------------
describe("docs/16 §17.7: reconciliation queries cover the essential checks", () => {
  it("queries pending_stripe age, ops_alerts, and stripe_events", () => {
    expect(SECTION_17).toMatch(/status = 'pending_stripe'/);
    expect(SECTION_17).toMatch(/from public\.ops_alerts/);
    expect(SECTION_17).toMatch(/from public\.stripe_events/);
  });

  it("references the PR #281 success-persistence critical events", () => {
    expect(SECTION_17).toContain("session_payment_succeeded_write_failed");
    expect(SECTION_17).toContain("session_payment_succeeded_write_zero_rows");
  });

  it("references refund-review alerts", () => {
    expect(SECTION_17).toMatch(/payment_refund_%/);
  });
});

// ---------------------------------------------------------------------------
// Cross-doc pointers exist and stay consistent (readiness, not enablement).
// ---------------------------------------------------------------------------
describe("supporting docs frame PR #282 as readiness, not enablement", () => {
  it("docs/06 points at the §17 runbook and says no enablement", () => {
    expect(PAYMENTS).toMatch(/PR #282/);
    expect(PAYMENTS).toMatch(/NOT live-payment enablement/i);
  });

  it("docs/10 has the rollback pointer and reaffirms live disabled", () => {
    expect(DEPLOY).toMatch(/PR #282/);
    expect(DEPLOY).toMatch(/rollback/i);
    expect(DEPLOY).toMatch(/STRIPE_ALLOW_LIVE_MODE/);
  });

  it("docs/12 documents the read-only reconciliation checks", () => {
    expect(SMOKE).toMatch(/Payment reconciliation read-only checks \(PR #282\)/);
    expect(SMOKE).toMatch(/`?SELECT`?-only/);
  });

  it("docs/13 has the PR #282 decision entry (docs-only, no migration)", () => {
    expect(DECISIONS).toMatch(/PR #282/);
    expect(DECISIONS).toMatch(/no migration/i);
  });

  it("docs/14 current-status is at PR #282 or later and keeps live payments disabled", () => {
    // The handoff status header rolls forward with each docs PR; assert it is
    // at #282 or higher (so PR #282's contract holds without locking later
    // PRs to back-edit this file — matching live-payments-readiness.test.ts).
    const m = HANDOFF.match(/Current production status \(as of PR #(\d+)\)/);
    expect(m).not.toBeNull();
    if (m) expect(Number(m[1])).toBeGreaterThanOrEqual(282);
    expect(HANDOFF).toMatch(/Live payments remain disabled/i);
  });
});
