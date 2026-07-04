import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPaymentReceiptEmail } from "@/lib/email/templates/payment-receipt";

// PR #201: Live Payments Gate Preparation. NO live enablement.
//
// 1. Receipt copy readiness: the template can render a cautious
//    live-mode receipt, but the test branch is unchanged and the
//    sender keeps the live branch structurally unreachable.
// 2. Payment UI copy map: test-mode strings stay present while live
//    mode is disabled.
// 3. Refund permission: owner-only, consistently across session
//    payments and fees.
// 4. Stale pending_stripe recovery: already shipped; pinned here.
// 5. Live mode stays blocked everywhere.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const FIXTURE = {
  studioName: "Willow Electrolysis",
  studioContactEmail: "studio@example.com",
  clientName: "Chloe Testing",
  chargeReasonLabel: "Session payment",
  amountCents: 12000,
  currencyCode: "cad",
  chargedAt: new Date("2026-06-12T15:00:00Z"),
  stripePaymentIntentId: "pi_test_123",
  stripeChargeId: "ch_test_123",
};

const RISKY_LIVE_PHRASES = [
  /tax receipt/i,
  /official invoice/i,
  /charitable receipt/i,
  /pay now/i,
  /send invoice/i,
];

describe("receipt template: test-mode branch unchanged", () => {
  it("default (no livemode) renders the exact pre-#201 test-mode receipt", () => {
    const out = buildPaymentReceiptEmail(FIXTURE);
    expect(out.subject).toBe(
      "TEST MODE receipt from Willow Electrolysis: Session payment $120.00 CAD",
    );
    expect(out.text).toContain(
      "This is a Stripe test-mode receipt. No live card was charged.",
    );
    expect(out.text).toContain(
      "No tax calculation is included on this receipt.",
    );
    expect(out.text).toContain(
      "If this test payment needs to be refunded, the practitioner can issue a test-mode refund in Hone.",
    );
  });

  it("livemode: false is byte-identical to the default", () => {
    const a = buildPaymentReceiptEmail(FIXTURE);
    const b = buildPaymentReceiptEmail({ ...FIXTURE, livemode: false });
    expect(b.subject).toBe(a.subject);
    expect(b.text).toBe(a.text);
    expect(b.html).toBe(a.html);
  });
});

describe("receipt template: live branch (copy readiness only; unreachable at runtime)", () => {
  const live = buildPaymentReceiptEmail({ ...FIXTURE, livemode: true });

  it("contains no TEST MODE language anywhere", () => {
    for (const part of [live.subject, live.text, live.html]) {
      expect(part).not.toMatch(/test.mode/i);
      expect(part).not.toMatch(/TEST MODE/);
      expect(part).not.toMatch(/no live card was charged/i);
    }
  });

  it("uses the LAWYER-APPROVED live wording (2026-07-04), sign-off complete", () => {
    expect(live.subject).toBe(
      "Receipt from Willow Electrolysis: Session payment $120.00 CAD",
    );
    expect(live.text).toContain(
      "This receipt confirms that a card payment was processed by Willow Electrolysis.",
    );
    expect(live.text).toContain(
      "This receipt confirms payment only. It is not a tax invoice unless Willow Electrolysis separately states that tax is included or provides a separate tax invoice.",
    );
    expect(live.text).toContain(
      "For questions about this payment, refund eligibility, cancellation fees, no-show fees, or services provided, please contact Willow Electrolysis directly.",
    );
    // Platform note: Hone is not the merchant of record.
    expect(live.text).toContain(
      "Hone is the software platform used by the studio and is not the treatment provider or merchant of record.",
    );
    expect(live.html).toContain("not the treatment provider or merchant of record");
    // Sign-off complete — the PENDING marker is gone.
    const TEMPLATE = read("lib/email/templates/payment-receipt.ts");
    expect(TEMPLATE).not.toMatch(/PENDING legal\/accounting review/);
  });

  it("never claims tax receipt / official invoice / charitable receipt / pay now / send invoice", () => {
    for (const part of [live.subject, live.text, live.html]) {
      for (const phrase of RISKY_LIVE_PHRASES) {
        expect(part).not.toMatch(phrase);
      }
    }
  });

  it("carries the factual details but NOT the Stripe PI/Charge ids (live)", () => {
    expect(live.text).toContain("Studio: Willow Electrolysis");
    expect(live.text).toContain("Amount: $120.00 CAD");
    expect(live.text).toContain("Reason: Session payment");
    expect(live.text).toContain("Date: ");
    // The live receipt omits the internal Stripe ids the test receipt shows.
    expect(live.text).not.toContain("PaymentIntent: pi_test_123");
    expect(live.text).not.toContain("Charge: ch_test_123");
  });

  it("renders the card last-4 payment method, with a neutral fallback", () => {
    const withLast4 = buildPaymentReceiptEmail({
      ...FIXTURE,
      livemode: true,
      last4: "4242",
    });
    expect(withLast4.text).toContain("Payment method: Card ending in 4242");
    expect(withLast4.html).toContain("Card ending in 4242");
    // Never a full card number.
    expect(withLast4.text).not.toMatch(/\d{13,19}/);
    // Fallback when last4 is unavailable.
    expect(live.text).toContain("Payment method: Card on file");
  });
});

describe("receipt sender: env-gated + live-capable (PR #323; legal-copy gate pending #324)", () => {
  const SENDER = read("lib/billing/payment-receipt.ts");

  it("refuses only rows whose mode does not match the deployment mode", () => {
    // PR #323: was `!== false` (test-only). Now env-gated: in test env this is
    // still `!== false`; a live row is only sendable after the #324 env flip.
    expect(SENDER).toMatch(/attempt\.stripe_livemode !== inferStripeLivemode\(\)/);
    expect(SENDER).not.toMatch(/attempt\.stripe_livemode !== false/);
  });

  it("passes the row's actual mode to the template (not hardcoded false)", () => {
    expect(SENDER).toMatch(/livemode: attempt\.stripe_livemode/);
    expect(SENDER).not.toMatch(/livemode: false,/);
  });
});

describe("payment UI copy map: neutral, mode-safe strings (copy fast-follow)", () => {
  // Strip // comments: the assertion targets USER-FACING copy, not stale
  // historical comments that still reference the old button names.
  const stripComments = (s: string) =>
    s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const CARD = stripComments(read("components/session-payment-prepare-card.tsx"));
  const FEE_CARD = stripComments(read("app/(app)/calendar/[id]/ManualFeeChargeCard.tsx"));

  it("session payment card uses neutral labels + NO misleading live-mode copy", () => {
    // Neutralized so nothing reads false after the #324 env flip.
    expect(CARD).toMatch(/Run charge/);
    expect(CARD).toMatch(/Charge succeeded\./);
    // The old test-mode framing that would lie in live mode is gone.
    expect(CARD).not.toMatch(/Run test charge/);
    expect(CARD).not.toMatch(/No live card was charged/);
    expect(CARD).not.toMatch(/test-mode payment record/);
    expect(CARD).not.toMatch(/Stripe test-mode charge/);
  });

  it("fee card uses neutral labels + NO misleading live-mode copy", () => {
    expect(FEE_CARD).toMatch(/Run charge/);
    expect(FEE_CARD).toMatch(/Send receipt/);
    expect(FEE_CARD).toMatch(/Refund charge/);
    expect(FEE_CARD).not.toMatch(/Test mode only\. No live card will be charged\./);
    expect(FEE_CARD).not.toMatch(/Run test charge/);
    expect(FEE_CARD).not.toMatch(/Send test receipt/);
  });

  it("the copy map is documented in docs/18 §16", () => {
    const DOCS = read("docs/18_LIVE_PAYMENTS_AUDIT.md");
    expect(DOCS).toMatch(/Payment UI copy map/);
    expect(DOCS).toMatch(/PR #201 gate preparation/);
  });
});

describe("refund permission: owner-only across all charge reasons", () => {
  const SESSION_ACTIONS = read(
    "app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts",
  );
  const FEE_ACTIONS = read("app/(app)/calendar/[id]/manual-fee-actions.ts");

  it("session payment refund re-checks owner role server-side", () => {
    const fn = SESSION_ACTIONS.slice(
      SESSION_ACTIONS.indexOf("export async function refundPaymentChargeAttemptAction"),
    );
    expect(fn).toMatch(/practitioner\.role !== "owner"/);
    expect(fn).toMatch(/OWNER_ONLY_REFUND_ERROR/);
    expect(SESSION_ACTIONS).toMatch(
      /Only the studio owner can issue a refund\./,
    );
  });

  it("fee refund re-checks owner role server-side (same rule, same copy)", () => {
    const fn = FEE_ACTIONS.slice(
      FEE_ACTIONS.indexOf("export async function refundFeeAttemptAction"),
    );
    expect(fn).toMatch(/practitioner\.role !== "owner"/);
    expect(fn).toMatch(/OWNER_ONLY_REFUND_ERROR/);
    expect(FEE_ACTIONS).toMatch(/Only the studio owner can issue a refund\./);
  });

  it("charging and receipts are NOT owner-gated (no silent permission expansion or contraction)", () => {
    const prepare = SESSION_ACTIONS.slice(
      SESSION_ACTIONS.indexOf("export async function prepareSessionPaymentChargeAction"),
      SESSION_ACTIONS.indexOf("export async function refundPaymentChargeAttemptAction"),
    );
    expect(prepare).not.toMatch(/role !== "owner"/);
  });
});

describe("stale pending_stripe recovery (already shipped; pinned)", () => {
  it("the unified executor reconciles pending rows from the stored PaymentIntent", () => {
    // PR #218 removed the dead legacy manual-fee executor; the
    // unified session-payment executor (all three charge reasons
    // since PR #196) is the only charge path.
    const SESSION = read("lib/billing/session-payment-charge.ts");
    expect(SESSION).toMatch(/pending_stripe/);
    expect(SESSION).toMatch(/idempotency/i);
    expect(SESSION).toMatch(
      /row stays pending_stripe\. Reconcile via Stripe dashboard\./,
    );
    expect(() => read("lib/billing/manual-fee-charge.ts")).toThrow();
  });
});

describe("live mode stays blocked", () => {
  it("STRIPE_ALLOW_LIVE_MODE appears in lib/stripe/server.ts only as the error string", () => {
    const STRIPE_SERVER = read("lib/stripe/server.ts");
    expect(STRIPE_SERVER).toMatch(/STRIPE_ALLOW_LIVE_MODE/);
    const RUNTIME_FILES = [
      "lib/billing/session-payment-charge.ts",
      "lib/billing/payment-refund.ts",
      "lib/billing/payment-receipt.ts",
      "lib/email/templates/payment-receipt.ts",
    ];
    // Strip comments: the runtime code must not ASSIGN/compare STRIPE_ALLOW_LIVE_
    // MODE (that lives only in server.ts); PR #323 comments may reference it.
    for (const f of RUNTIME_FILES) {
      const codeOnly = read(f)
        .split("\n")
        .filter((l) => !/^\s*\/\//.test(l))
        .join("\n");
      expect(codeOnly, `${f} must not touch STRIPE_ALLOW_LIVE_MODE in code`).not.toMatch(
        /STRIPE_ALLOW_LIVE_MODE\s*=/,
      );
    }
  });

  it("the livemode_false DB CHECK migrations are untouched", () => {
    const M73 = read("supabase/migrations/0073_payment_charge_attempts.sql");
    expect(M73).toMatch(/stripe_livemode boolean not null default false/);
  });
});
