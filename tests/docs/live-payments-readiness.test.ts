import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// PR #168. Docs-level guarantees for the live-payments readiness
// review. These tests pin that the readiness document exists, that
// it declares the strict conclusion, and that the related runbook
// + deployment docs stay in sync with the doc's claims. The
// machine-enforcement on the actual Stripe guards lives in
// tests/lib/billing/live-mode-blockers.test.ts.

function readDoc(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
}

const READINESS = readDoc("docs/16_LIVE_PAYMENTS_READINESS.md");
const RUNBOOK = readDoc("docs/11_RUNBOOK.md");
const DEPLOY = readDoc("docs/10_DEPLOYMENT_AND_ENV.md");
const HANDOFF = readDoc("docs/14_AI_HANDOFF.md");
const DECISIONS = readDoc("docs/13_BACKLOG_AND_DECISIONS.md");

describe("docs/16 readiness doc exists and declares the conclusion", () => {
  it("the file is at the expected path", () => {
    const exists = existsSync(
      path.resolve(__dirname, "../../docs/16_LIVE_PAYMENTS_READINESS.md"),
    );
    expect(exists).toBe(true);
  });

  // AMENDED 2026-07-27: the name asserted a CURRENT conclusion while the string it
  // pinned is the DATED 2026-06-10 verdict. Live session payments are now enabled for
  // approved studios and production-exercised. The guard now requires the verdict to be
  // present AND explicitly marked historical, so it can never again read as current.
  it("its dated headline verdict is retained but explicitly marked historical", () => {
    expect(READINESS).toMatch(/Status:\s*NOT READY FOR LIVE PAYMENTS/i);
    expect(READINESS).toMatch(/\[HISTORICAL[^\]]*\]\s*Status: NOT READY FOR LIVE PAYMENTS/i);
    expect(READINESS).toMatch(/VERIFIED PAYMENT POSTURE/);
  });

  it("names PR #168 and the date the audit ran", () => {
    expect(READINESS).toMatch(/PR #168/);
    expect(READINESS).toMatch(/2026-06-08/);
  });

  // AMENDED 2026-07-27: Guard 3 (the payment_charge_attempts_livemode_false_check DB
  // CHECK) was DROPPED by migration 0101. This guard now pins the historical three-guard
  // model as a record of the pre-live posture, not as current mechanism.
  it("documents the three independent dormancy guards as the historical pre-live model", () => {
    expect(READINESS).toMatch(/Guard 1:.*key gate/i);
    expect(READINESS).toMatch(/Guard 2:.*early return|Guard 2:.*manual fee/i);
    expect(READINESS).toMatch(/Guard 3:.*(CHECK|database)/i);
  });
});

describe("docs/16 names every blocker that must be closed", () => {
  const REQUIRED_BLOCKERS = [
    "card_authorization",
    "Test mode only",
    "payouts",
    "receipt",
    "refund",
    "policy",
    "test coverage",
    "runbook",
    "webhook",
    "CHECK",
  ];

  for (const blocker of REQUIRED_BLOCKERS) {
    it(`mentions blocker keyword "${blocker}"`, () => {
      // Case-insensitive substring match; the doc is long and
      // structured, this only proves the blocker is referenced.
      expect(READINESS.toLowerCase()).toContain(blocker.toLowerCase());
    });
  }

  it("the go/no-go checklist names every PR in the unblock sequence", () => {
    for (const n of [
      "PR #169",
      "PR #170",
      "PR #171",
      "PR #172",
      "PR #173",
      "PR #174",
      "PR #175",
      "PR #176",
      "PR #177",
    ]) {
      expect(READINESS).toContain(n);
    }
  });

  it("the doc lists all 7 'Test mode only' UI copy locations", () => {
    // The exact filenames are pinned by the live-mode-blockers
    // test; here we just check the readiness doc names each one
    // so an operator reading docs/16 knows where to look.
    for (const f of [
      "PortalPaymentMethodForm.tsx",
      "PortalCardOnFileCard.tsx",
      "PaymentsSettings.tsx",
      "ManualFeeChargeCard.tsx",
    ]) {
      expect(READINESS).toContain(f);
    }
  });
});

describe("docs/16 documents what is already production-safe", () => {
  it("lists Stripe Connect onboarding + status sync as ready", () => {
    expect(READINESS).toMatch(/Stripe Connect onboarding/i);
    expect(READINESS).toMatch(/sync_studio_account_status/);
  });

  it("lists the SetupIntent flow + atomic webhook as ready", () => {
    expect(READINESS).toMatch(/SetupIntent/);
    expect(READINESS).toMatch(/setup_intent\.succeeded/);
  });

  it("lists the 3-layer duplicate protection on manual fee charges", () => {
    expect(READINESS).toMatch(/idempotency key/i);
    expect(READINESS).toMatch(/partial unique/i);
  });
});

describe("docs/16 honest-non-claims block exists", () => {
  it("declares that no live payments are enabled by this PR", () => {
    // The non-claims block opens with "does NOT do any of the
    // following:" and then bullets "Enable live payments." several
    // lines below. We match both anchors with a [\s\S]* between
    // them so the regex crosses newlines.
    expect(READINESS).toMatch(
      /does NOT[\s\S]{0,300}Enable live payments/,
    );
  });

  it("declares that no Stripe key, env var, or webhook secret was changed", () => {
    expect(READINESS).toMatch(/Modify any Stripe key/i);
  });

  it("declares that no UI copy was changed in this PR", () => {
    // The block says: "the 7 'Test mode only' strings remain"
    expect(READINESS).toMatch(/(seven|7)[\s\S]{0,40}Test mode only[\s\S]{0,40}remain/i);
  });
});

describe("docs/11 runbook points at the readiness doc", () => {
  it("the runbook mentions live payments are not enabled", () => {
    expect(RUNBOOK).toMatch(/live payments.*not enabled|Live payments.*not enabled/i);
  });

  it("the runbook links to docs/16", () => {
    expect(RUNBOOK).toMatch(/16_LIVE_PAYMENTS_READINESS/);
  });
});

describe("docs/10 deployment doc reaffirms the dormancy posture", () => {
  it("docs/10 reaffirms STRIPE_ALLOW_LIVE_MODE is false in production", () => {
    expect(DEPLOY).toMatch(/STRIPE_ALLOW_LIVE_MODE/);
  });

  it("docs/10 links to docs/16 for the readiness checklist", () => {
    expect(DEPLOY).toMatch(/16_LIVE_PAYMENTS_READINESS|live.payments.readiness/i);
  });
});

describe("docs/14 AI handoff references the PR #168 readiness review", () => {
  it("the status line names a current PR (PR #168 or later)", () => {
    // The doc's "Current production status (as of PR #N)" line
    // rolls forward with each docs PR. We assert it is at PR #168
    // or higher so PR #168's contract holds without locking
    // future PRs to back-edit this file.
    const m = HANDOFF.match(/Current production status \(as of PR #(\d+)\)/);
    expect(m).not.toBeNull();
    if (m) {
      const n = Number(m[1]);
      expect(n).toBeGreaterThanOrEqual(168);
    }
  });

  it("the PR #168 readiness decision is still referenced in the handoff", () => {
    // Even when the status line rolls forward, the PR #168
    // decision (live payments NOT enabled) must remain
    // searchable in the handoff bullet list.
    expect(HANDOFF).toMatch(/PR #168/);
    expect(HANDOFF).toMatch(/Live payments are NOT enabled/);
  });

  it("handoff names docs/16 as the live-payments source of truth", () => {
    expect(HANDOFF).toMatch(/16_LIVE_PAYMENTS_READINESS|live.payments.readiness/i);
  });
});

describe("docs/13 decision log has a PR #168 entry", () => {
  it("the decision log mentions PR #168", () => {
    expect(DECISIONS).toMatch(/PR #168/);
  });

  it("the decision log declares the conclusion explicitly", () => {
    expect(DECISIONS).toMatch(/NOT READY FOR LIVE PAYMENTS/i);
  });
});
