import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #174. Practitioner UX hardening for session payment states.
// PR #173 shipped the prepare + execute flow but the post-refresh
// rendering of succeeded / failed / pending rows fell through to a
// bare existing-attempt panel: no PaymentIntent id, no charge id,
// no failure message, no test-mode disclaimer. PR #174 widens the
// eligibility helper's SELECT to carry every persisted field and
// refactors the card to dispatch on attempt.status with dedicated
// per-status subcomponents. These tests pin each state's contract.

const CARD_PATH = path.resolve(
  __dirname,
  "../../../components/session-payment-prepare-card.tsx",
);
const CARD = readFileSync(CARD_PATH, "utf8");

const ELIGIBILITY_PATH = path.resolve(
  __dirname,
  "../../../lib/billing/session-payment-eligibility.ts",
);
const ELIGIBILITY = readFileSync(ELIGIBILITY_PATH, "utf8");

// Strip every single-line // comment so doc-only copy is not
// matched as if it were rendered text. The file header documents
// what we are NOT building (Pay now / Charge card / etc.); the
// load-bearing checks are against the JSX-shape strings.
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const CARD_CODE = codeOnly(CARD);

// Extract the source of one top-level function from CARD by
// scanning from `function <name>(` to the next top-level
// `function <other>(` declaration. Returns the empty string if
// the function is not present. This is more robust than the
// lazy [\s\S]*?\n\} pattern, which only captures up to the first
// nested closing brace (typically the destructured parameter).
function blockFor(name: string): string {
  const startIdx = CARD.indexOf(`function ${name}(`);
  if (startIdx === -1) return "";
  const after = startIdx + 1;
  const rel = CARD.slice(after).search(/^function \w+\(/m);
  return rel === -1 ? CARD.slice(startIdx) : CARD.slice(startIdx, after + rel);
}

describe("PR #174 patch: activeAttempt vs latestHistoricalAttempt", () => {
  // Bug fixed by the patch: under PR #174 initial, a failed /
  // cancelled / blocked latest row was treated as the active
  // attempt (because the fallback `?? existingAttempts[0]` did not
  // discriminate). That hid the Prepare form and left the
  // practitioner with no way to try again. The patch separates
  // "active attempt (drives main panel + blocks new prepare)"
  // from "latest historical attempt (context)" and limits the
  // active set to the duplicate-protection statuses that PR #172
  // pinned in the partial-unique index
  // payment_charge_attempts_active_session_payment_uniq.

  it("declares an activeAttempt computed from ACTIVE_STATUSES only", () => {
    expect(CARD).toMatch(
      /const activeAttempt\s*=\s*\n?\s*eligibility\.existingAttempts\.find\(\(a\) =>\s*\n?\s*ACTIVE_STATUSES\.has\(a\.status\),?\s*\n?\s*\)\s*\?\?\s*null/,
    );
  });

  it("the activeAttempt finder does NOT fall back to existingAttempts[0]", () => {
    // The pre-patch shape had `?? eligibility.existingAttempts[0]
    // ?? null` which is exactly the bug. Pin the absence of that
    // fallback on the active-attempt expression.
    const activeBlock =
      CARD.match(
        /const activeAttempt\s*=[\s\S]*?\n[ \t]*const [a-zA-Z]/,
      )?.[0] ?? "";
    expect(activeBlock).not.toMatch(/existingAttempts\[0\]/);
  });

  it("the Prepare form gates on !activeAttempt, NOT !latestAttempt", () => {
    expect(CARD).toMatch(
      /const showPrepareForm\s*=\s*\n?\s*eligibility\.eligible\s*&&\s*!activeAttempt\s*&&\s*!prepareJustSucceeded/,
    );
    expect(CARD).not.toMatch(/showPrepareForm\s*=[\s\S]{0,200}!latestAttempt/);
  });
});

describe("PR #174 patch: failed / cancelled / blocked terminal rows do NOT block new prepare", () => {
  // The reviewer's required behavior, pinned by source-grep. The
  // tests above already prove the predicate uses activeAttempt;
  // these tests pin that none of the three terminal statuses are
  // ever in ACTIVE_STATUSES (and therefore can never satisfy the
  // !activeAttempt gate).

  it("ACTIVE_STATUSES matches the PR #172 duplicate-protection partial unique (ready / pending_stripe / succeeded)", () => {
    expect(CARD).toMatch(
      /const ACTIVE_STATUSES = new Set\(\[\s*\n?\s*"ready",\s*\n?\s*"pending_stripe",\s*\n?\s*"succeeded",\s*\n?\s*\]\)/,
    );
  });
});

describe("PR #174: PendingPanel (post-claim, no terminal status)", () => {
  it("does NOT render the Run charge button (the row is not 'ready')", () => {
    const block = blockFor("PendingPanel");
    expect(block).not.toMatch(/Run charge/);
    expect(block).not.toMatch(/Confirm: run charge/);
  });
});

describe("compact SucceededPanel (post-refresh)", () => {
  it("processor identifiers are OWNER-ONLY (technicalRowsForAttempt), never inline", () => {
    const block = blockFor("SucceededPanel");
    expect(block).toMatch(/<TechnicalPaymentDetails[\s\S]{0,120}technicalRowsForAttempt\(attempt\)/);
    // No inline "PaymentIntent:" / "Charge:" / "Refund:" rows in the face.
    expect(block).not.toMatch(/PaymentIntent:\s*\{?\s*attempt\.stripePaymentIntentId/);
    expect(block).not.toMatch(/Charge:\s*\{?\s*attempt\.stripeChargeId/);
    expect(block).not.toMatch(/Refund:\s*\{?\s*attempt\.stripeRefundId/);
  });

  it("does NOT render the Run charge button (post-refresh terminal-success state)", () => {
    const block = blockFor("SucceededPanel");
    expect(block).not.toMatch(/Run charge/);
    expect(block).not.toMatch(/Confirm: run charge/);
  });
});

describe("PR #174: FailedPanel (terminal in this PR)", () => {
  it("shows a practitioner-friendly failure reason (humanChargeFailure), not the raw code", () => {
    const block = blockFor("FailedPanel");
    expect(block).toMatch(/<PaymentSummaryCard/);
    expect(block).toMatch(/humanChargeFailure\(attempt\.failureCode\)/);
    expect(block).toMatch(/attempt\.failedAt/);
    // Raw code + processor message are NOT inline — they're owner-only.
    expect(block).not.toMatch(/Code:\s*\{?\s*attempt\.failureCode/);
    expect(block).not.toMatch(/Failure:\s*\{?\s*attempt\.failureMessageSafe/);
  });

  it("does NOT render the Run charge button (failed is terminal in PR #173)", () => {
    const block = blockFor("FailedPanel");
    expect(block).not.toMatch(/Run charge/);
    expect(block).not.toMatch(/Confirm: run charge/);
  });
});

describe("PR #174: CancelledPanel + BlockedAttemptPanel", () => {
  it("CancelledPanel is calm + name-only (no charge actions)", () => {
    const block = blockFor("CancelledPanel");
    expect(block).toMatch(/Session payment cancelled/);
    expect(block).not.toMatch(/Run charge/);
  });

  it("BlockedAttemptPanel is calm + name-only (no charge actions)", () => {
    const block = blockFor("BlockedAttemptPanel");
    expect(block).toMatch(/Session payment blocked/);
    expect(block).not.toMatch(/Run charge/);
  });
});

describe("PR #174: forbidden copy not present anywhere in actionable JSX", () => {
  // The spec forbids "Pay now / Charge card / Collect payment /
  // Payment complete / Live payment / Receipt sent" in the
  // practitioner-facing copy. We strip comment lines so the file
  // header documenting what we are NOT building does not trip the
  // assertion (the header legitimately references the forbidden
  // phrases to explain the design choice).
  it("does NOT say 'Pay now'", () => {
    expect(CARD_CODE).not.toMatch(/Pay now/);
  });

  it("does NOT say 'Charge card'", () => {
    expect(CARD_CODE).not.toMatch(/Charge card/);
  });

  it("does NOT say 'Collect payment'", () => {
    expect(CARD_CODE).not.toMatch(/Collect payment/);
  });
});

describe("PR #174: no new Stripe / live-mode / SMS / email behavior", () => {
  it("does NOT import Stripe Elements or any Stripe SDK module in the card", () => {
    // The file header comment legitimately references SDK
    // surface area to explain what is forbidden ("No Stripe call.
    // No PaymentIntent create. No charge. No refund."). Strip
    // comments before asserting so the documentation does not
    // trip the negative.
    expect(CARD_CODE).not.toMatch(/@stripe\/stripe-js/);
    expect(CARD_CODE).not.toMatch(/@stripe\/react-stripe-js/);
    expect(CARD_CODE).not.toMatch(/paymentIntents\./);
    expect(CARD_CODE).not.toMatch(/charges\./);
    expect(CARD_CODE).not.toMatch(/refunds\./);
    expect(CARD_CODE).not.toMatch(/checkout\./);
  });

  it("does NOT reference STRIPE_ALLOW_LIVE_MODE", () => {
    expect(CARD).not.toMatch(/STRIPE_ALLOW_LIVE_MODE/);
  });

  it("does NOT import any SMS or email helper", () => {
    expect(CARD).not.toMatch(/lib\/sms\//);
    expect(CARD).not.toMatch(/lib\/email\//);
    expect(CARD).not.toMatch(/twilio/i);
    expect(CARD).not.toMatch(/resend/i);
  });

  it("does NOT touch manual_fee_charge_attempts", () => {
    expect(CARD).not.toMatch(/manual_fee_charge_attempts/);
    expect(ELIGIBILITY).not.toMatch(/manual_fee_charge_attempts/);
  });
});
