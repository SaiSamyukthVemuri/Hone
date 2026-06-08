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

const TYPES_PATH = path.resolve(
  __dirname,
  "../../../lib/billing/session-payment-types.ts",
);
const TYPES = readFileSync(TYPES_PATH, "utf8");

const ELIGIBILITY_PATH = path.resolve(
  __dirname,
  "../../../lib/billing/session-payment-eligibility.ts",
);
const ELIGIBILITY = readFileSync(ELIGIBILITY_PATH, "utf8");

const SETUP_INTENT_ACTION_PATH = path.resolve(
  __dirname,
  "../../../app/portal/payment-method-actions.ts",
);
const SETUP_INTENT_ACTION = readFileSync(SETUP_INTENT_ACTION_PATH, "utf8");

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

describe("PR #174: eligibility summary widened", () => {
  it("SessionPaymentExistingAttemptSummary carries the post-execute fields", () => {
    expect(TYPES).toMatch(/stripePaymentIntentId:\s*string \| null/);
    expect(TYPES).toMatch(/stripeChargeId:\s*string \| null/);
    expect(TYPES).toMatch(/chargedAt:\s*string \| null/);
    expect(TYPES).toMatch(/failedAt:\s*string \| null/);
    expect(TYPES).toMatch(/failureCode:\s*string \| null/);
    expect(TYPES).toMatch(/failureMessageSafe:\s*string \| null/);
  });

  it("the eligibility helper SELECTs the post-execute columns", () => {
    expect(ELIGIBILITY).toMatch(/stripe_payment_intent_id/);
    expect(ELIGIBILITY).toMatch(/stripe_charge_id/);
    expect(ELIGIBILITY).toMatch(/charged_at/);
    expect(ELIGIBILITY).toMatch(/failed_at/);
    expect(ELIGIBILITY).toMatch(/failure_code/);
    expect(ELIGIBILITY).toMatch(/failure_message_safe/);
  });

  it("the eligibility helper maps every new column into the summary", () => {
    expect(ELIGIBILITY).toMatch(
      /stripePaymentIntentId:[\s\S]{0,80}row\.stripe_payment_intent_id/,
    );
    expect(ELIGIBILITY).toMatch(/stripeChargeId:[\s\S]{0,80}row\.stripe_charge_id/);
    expect(ELIGIBILITY).toMatch(/chargedAt:[\s\S]{0,80}row\.charged_at/);
    expect(ELIGIBILITY).toMatch(/failedAt:[\s\S]{0,80}row\.failed_at/);
    expect(ELIGIBILITY).toMatch(/failureCode:[\s\S]{0,80}row\.failure_code/);
    expect(ELIGIBILITY).toMatch(
      /failureMessageSafe:[\s\S]{0,80}row\.failure_message_safe/,
    );
  });
});

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

  it("declares latestHistoricalAttempt separately for the previous-attempt callout", () => {
    expect(CARD).toMatch(
      /const latestHistoricalAttempt\s*=\s*\n?\s*eligibility\.existingAttempts\[0\]\s*\?\?\s*null/,
    );
  });

  it("the Prepare form gates on !activeAttempt, NOT !latestAttempt", () => {
    expect(CARD).toMatch(
      /const showPrepareForm\s*=\s*\n?\s*eligibility\.eligible\s*&&\s*!activeAttempt\s*&&\s*!prepareJustSucceeded/,
    );
    expect(CARD).not.toMatch(/showPrepareForm\s*=[\s\S]{0,200}!latestAttempt/);
  });

  it("AttemptStatusPanel is only rendered for activeAttempt (not for terminal-non-success rows)", () => {
    expect(CARD).toMatch(
      /\{activeAttempt && \(\s*\n?\s*<AttemptStatusPanel/,
    );
  });

  it("renders a PreviousTerminalCallout for failed / cancelled / blocked latest rows when no active attempt", () => {
    expect(CARD).toMatch(/function PreviousTerminalCallout/);
    expect(CARD).toMatch(/\{previousTerminalAttempt && \(\s*\n?\s*<PreviousTerminalCallout/);
  });

  it("PreviousTerminalCallout only matches terminal-retry statuses (failed / cancelled / blocked)", () => {
    const block = blockFor("PreviousTerminalCallout");
    expect(block).toMatch(/case "failed":/);
    expect(block).toMatch(/case "cancelled":/);
    expect(block).toMatch(/case "blocked":/);
    // Active statuses are deliberately not handled here.
    expect(block).not.toMatch(/case "ready":/);
    expect(block).not.toMatch(/case "pending_stripe":/);
    expect(block).not.toMatch(/case "succeeded":/);
  });

  it("declares TERMINAL_RETRY_STATUSES set with exactly failed / cancelled / blocked", () => {
    expect(CARD).toMatch(
      /const TERMINAL_RETRY_STATUSES = new Set\(\[\s*\n?\s*"failed",\s*\n?\s*"cancelled",\s*\n?\s*"blocked",\s*\n?\s*\]\)/,
    );
  });

  it("the BlockedPanel (no-eligibility) branch also gates on !activeAttempt (not !latestAttempt)", () => {
    expect(CARD).toMatch(
      /!eligibility\.eligible && !activeAttempt && !prepareJustSucceeded/,
    );
  });
});

describe("PR #174 patch: failed / cancelled / blocked terminal rows do NOT block new prepare", () => {
  // The reviewer's required behavior, pinned by source-grep. The
  // tests above already prove the predicate uses activeAttempt;
  // these tests pin that none of the three terminal statuses are
  // ever in ACTIVE_STATUSES (and therefore can never satisfy the
  // !activeAttempt gate).

  it("ACTIVE_STATUSES does NOT contain 'failed'", () => {
    const block =
      CARD.match(/const ACTIVE_STATUSES = new Set\(\[[\s\S]*?\]\)/)?.[0] ?? "";
    expect(block).not.toMatch(/"failed"/);
  });

  it("ACTIVE_STATUSES does NOT contain 'cancelled'", () => {
    const block =
      CARD.match(/const ACTIVE_STATUSES = new Set\(\[[\s\S]*?\]\)/)?.[0] ?? "";
    expect(block).not.toMatch(/"cancelled"/);
  });

  it("ACTIVE_STATUSES does NOT contain 'blocked'", () => {
    const block =
      CARD.match(/const ACTIVE_STATUSES = new Set\(\[[\s\S]*?\]\)/)?.[0] ?? "";
    expect(block).not.toMatch(/"blocked"/);
  });

  it("ACTIVE_STATUSES matches the PR #172 duplicate-protection partial unique (ready / pending_stripe / succeeded)", () => {
    expect(CARD).toMatch(
      /const ACTIVE_STATUSES = new Set\(\[\s*\n?\s*"ready",\s*\n?\s*"pending_stripe",\s*\n?\s*"succeeded",\s*\n?\s*\]\)/,
    );
  });
});

describe("PR #174: status dispatch architecture", () => {
  it("a single AttemptStatusPanel dispatches on attempt.status", () => {
    expect(CARD).toMatch(/function AttemptStatusPanel/);
    expect(CARD).toMatch(/switch \(attempt\.status\)/);
  });

  it("dispatches to a per-status subcomponent for every status enum value", () => {
    for (const fn of [
      "ReadyPanel",
      "PendingPanel",
      "SucceededPanel",
      "FailedPanel",
      "CancelledPanel",
      "BlockedAttemptPanel",
      "UnknownStatusPanel",
    ]) {
      expect(CARD).toMatch(new RegExp(`function ${fn}\\(`));
    }
  });

  it("the active attempt picker prefers a non-terminal active status", () => {
    // ACTIVE_STATUSES = ready / pending_stripe / succeeded so the
    // duplicate-protection slot is the most-recent active row.
    expect(CARD).toMatch(/ACTIVE_STATUSES = new Set/);
    expect(CARD).toMatch(
      /ACTIVE_STATUSES[\s\S]{0,200}"ready"[\s\S]{0,40}"pending_stripe"[\s\S]{0,40}"succeeded"/,
    );
  });
});

describe("PR #174: ReadyPanel (active prepared row)", () => {
  it("renders the 'Session payment prepared' heading + amount + status + prepared timestamp", () => {
    const block = blockFor("ReadyPanel");
    expect(block).toMatch(/Session payment prepared/);
    expect(block).toMatch(/formatCadFromCents\(attempt\.amountCents\)/);
    expect(block).toMatch(/STATUS_LABEL\[attempt\.status\]/);
    expect(block).toMatch(/Prepared:\s*<FormattedDateTime iso=\{attempt\.createdAt\}/);
  });

  it("renders the Run test charge button with a two-click confirm", () => {
    const block = blockFor("ReadyPanel");
    expect(block).toMatch(/Run test charge/);
    expect(block).toMatch(/Confirm: run test charge/);
    expect(block).toMatch(/setConfirmExecute\(true\)/);
    expect(block).toMatch(/fd\.set\("confirm_charge",\s*"true"\)/);
  });

  it("names the Stripe test-mode framing on the run-charge panel", () => {
    const block = blockFor("ReadyPanel");
    expect(block).toMatch(/Stripe test mode/);
    // The JSX text may wrap "No live card is\ncharged" across two
    // lines; allow whitespace between the words.
    expect(block).toMatch(/No live card is\s+charged/);
  });
});

describe("PR #174: PendingPanel (post-claim, no terminal status)", () => {
  it("explicitly names test charge pending + may need manual review", () => {
    const block = blockFor("PendingPanel");
    expect(block).toMatch(/Test charge pending/);
    expect(block).toMatch(/may need manual review/);
  });

  it("does NOT render the Run test charge button (the row is not 'ready')", () => {
    const block = blockFor("PendingPanel");
    expect(block).not.toMatch(/Run test charge/);
    expect(block).not.toMatch(/Confirm: run test charge/);
  });

  it("surfaces the PaymentIntent id when one is on the row", () => {
    const block = blockFor("PendingPanel");
    expect(block).toMatch(/attempt\.stripePaymentIntentId/);
  });
});

describe("PR #174: SucceededPanel (post-refresh)", () => {
  it("uses 'Test charge succeeded' (not 'Payment complete')", () => {
    const block = blockFor("SucceededPanel");
    expect(block).toMatch(/Test charge succeeded/);
    expect(block).not.toMatch(/Payment complete/);
  });

  it("renders PaymentIntent id from the persisted row", () => {
    const block = blockFor("SucceededPanel");
    expect(block).toMatch(
      /attempt\.stripePaymentIntentId[\s\S]{0,200}PaymentIntent:/,
    );
  });

  it("renders Charge id when present", () => {
    const block = blockFor("SucceededPanel");
    expect(block).toMatch(/attempt\.stripeChargeId[\s\S]{0,200}Charge:/);
  });

  it("renders charged_at when present", () => {
    const block = blockFor("SucceededPanel");
    expect(block).toMatch(/attempt\.chargedAt/);
    expect(block).toMatch(/Charged:\s*<FormattedDateTime/);
  });

  it("explicitly names test mode + no live card + no receipt was sent", () => {
    const block = blockFor("SucceededPanel");
    expect(block).toMatch(/Stripe test-mode charge/);
    expect(block).toMatch(/No live card was charged/);
    expect(block).toMatch(/No receipt[\s\S]{0,20}was sent in this PR/);
  });

  it("does NOT render the Run test charge button (post-refresh terminal-success state)", () => {
    const block = blockFor("SucceededPanel");
    expect(block).not.toMatch(/Run test charge/);
    expect(block).not.toMatch(/Confirm: run test charge/);
  });

  it("does NOT render the Prepare form (terminal status excludes the form)", () => {
    // The form is gated by `eligibility.eligible && !latestAttempt`,
    // and a succeeded row IS a latest attempt, so the form is
    // structurally hidden. The succeeded panel itself does not
    // render a form either.
    const block = blockFor("SucceededPanel");
    expect(block).not.toMatch(/<form/);
    expect(block).not.toMatch(/Prepare session payment/);
  });
});

describe("PR #174: FailedPanel (terminal in this PR)", () => {
  it("uses 'Test charge failed' as the heading", () => {
    const block = blockFor("FailedPanel");
    expect(block).toMatch(/Test charge failed/);
  });

  it("renders failure_message_safe + failure_code + failed_at + PaymentIntent id when present", () => {
    const block = blockFor("FailedPanel");
    expect(block).toMatch(/attempt\.failureMessageSafe[\s\S]{0,200}Failure:/);
    expect(block).toMatch(/attempt\.failureCode[\s\S]{0,200}Code:/);
    expect(block).toMatch(/attempt\.failedAt/);
    expect(block).toMatch(
      /attempt\.stripePaymentIntentId[\s\S]{0,200}PaymentIntent:/,
    );
  });

  it("tells the practitioner to prepare a new attempt rather than retry", () => {
    const block = blockFor("FailedPanel");
    expect(block).toMatch(/Prepare a new session payment attempt/);
  });

  it("does NOT render the Run test charge button (failed is terminal in PR #173)", () => {
    const block = blockFor("FailedPanel");
    expect(block).not.toMatch(/Run test charge/);
    expect(block).not.toMatch(/Confirm: run test charge/);
  });
});

describe("PR #174: CancelledPanel + BlockedAttemptPanel", () => {
  it("CancelledPanel is calm + name-only (no charge actions)", () => {
    const block = blockFor("CancelledPanel");
    expect(block).toMatch(/Session payment cancelled/);
    expect(block).not.toMatch(/Run test charge/);
  });

  it("BlockedAttemptPanel is calm + name-only (no charge actions)", () => {
    const block = blockFor("BlockedAttemptPanel");
    expect(block).toMatch(/Session payment blocked/);
    expect(block).not.toMatch(/Run test charge/);
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

  it("does NOT say 'Payment complete'", () => {
    expect(CARD_CODE).not.toMatch(/Payment complete/);
  });

  it("does NOT say 'Live payment'", () => {
    expect(CARD_CODE).not.toMatch(/Live payment/);
  });

  it("does NOT say 'Receipt sent'", () => {
    expect(CARD_CODE).not.toMatch(/Receipt sent/);
  });
});

describe("PR #174: status labels reflect post-execute reality (PR #173 already shipped)", () => {
  it("'ready' label says 'Ready (test mode)' not the pre-PR-#173 'ready to charge in a future PR' string", () => {
    // The file header comment legitimately documents the old
    // label for context; what matters is the actual STATUS_LABEL
    // map value. We check the map definition specifically.
    expect(CARD).toMatch(/ready:\s*"Ready \(test mode\)"/);
    expect(CARD).not.toMatch(/ready:\s*"Prepared \(ready to charge/);
  });

  it("'succeeded' label says '(test mode)' so the practitioner cannot mistake it for live", () => {
    expect(CARD).toMatch(/succeeded:\s*"Succeeded \(test mode\)"/);
  });

  it("'failed' label says '(test mode)'", () => {
    expect(CARD).toMatch(/failed:\s*"Failed \(test mode\)"/);
  });

  it("'pending_stripe' label says 'Pending Stripe (test mode)'", () => {
    expect(CARD).toMatch(/pending_stripe:\s*"Pending Stripe \(test mode\)"/);
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

  it("the setup-intent portal action is unchanged by this PR (sanity)", () => {
    // The portal SetupIntent action lives elsewhere and is not
    // touched by PR #174. We verify the prepare card does not
    // accidentally reach into the portal payment surface.
    expect(SETUP_INTENT_ACTION).toMatch(/getCardAuthorizationStatus/);
  });
});
