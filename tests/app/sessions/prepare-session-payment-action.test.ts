import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #172. Source-grep tests for the practitioner-side prepare
// action. The action writes one payment_charge_attempts row with
// charge_reason='session_payment' and status='ready'. It calls
// NO Stripe API. It does NOT touch manual_fee_charge_attempts.
// It does NOT add SMS / email / webhook behavior.

const ACTION_PATH = path.resolve(
  __dirname,
  "../../../app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts",
);
const ACTION = readFileSync(ACTION_PATH, "utf8");

const PAGE_PATH = path.resolve(
  __dirname,
  "../../../app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
);
const PAGE = readFileSync(PAGE_PATH, "utf8");

const CARD_PATH = path.resolve(
  __dirname,
  "../../../components/session-payment-prepare-card.tsx",
);
const CARD = readFileSync(CARD_PATH, "utf8");

describe('prepare action: "use server" + auth gate', () => {
  it('declares "use server" at the top so it is a server action', () => {
    expect(ACTION).toMatch(/^"use server";/);
  });

  it("resolves practitioner + studio via getCurrentPractitionerWithStudio", () => {
    expect(ACTION).toMatch(
      /import \{ getCurrentPractitionerWithStudio \} from "@\/lib\/supabase\/queries"/,
    );
    expect(ACTION).toMatch(/await getCurrentPractitionerWithStudio\(\)/);
  });

  it("does NOT accept studio_id or practitioner_id from the form", () => {
    // Server-resolved scope. A browser-supplied studio_id would
    // be a privilege escalation.
    expect(ACTION).not.toMatch(/formData\.get\("studio_id"\)/);
    expect(ACTION).not.toMatch(/formData\.get\("practitioner_id"\)/);
    expect(ACTION).not.toMatch(/formData\.get\("created_by_practitioner_id"\)/);
  });

  it("does NOT accept client_id from the form (resolved from eligibility)", () => {
    // PR #173 added an execute action to the same file that reads
    // client_id from the form for revalidatePath context only.
    // Scope this assertion to the prepare action body.
    const prepareBlock =
      ACTION.match(
        /export async function prepareSessionPaymentChargeAction[\s\S]*?\n\}/,
      )?.[0] ?? "";
    expect(prepareBlock).not.toMatch(/formData\.get\("client_id"\)/);
  });
});

describe("prepare action: amount + note validation", () => {
  it("does no money parsing of its own, and delegates to the strict parser", () => {
    // The old parser lived HERE and did `Number(trimmed)` then
    // `Math.round(asNumber * 100)`, which accepted "1e2" and rounded "10.999"
    // up into a real charge. It is gone, so asserting its absence in this file
    // is nearly free — the assertion that carries weight is that the action
    // reaches the strict parser through the decision module, and that the
    // parser itself contains no float arithmetic (pinned in
    // tests/lib/billing/cad-amount.test.ts).
    const code = ACTION.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/Math\.round\(/);
    expect(code).not.toMatch(/Math\.min\(/);
    expect(code).not.toMatch(/parseFloat\(/);
    expect(code).not.toMatch(/Number\(/);
    expect(code).toMatch(/decideCheckoutFinalAmount\(/);
    const DECISION = readFileSync(
      path.resolve(__dirname, "../../../lib/billing/checkout-final-amount.ts"),
      "utf8",
    );
    expect(DECISION).toMatch(
      /import \{[\s\S]{0,120}parseCadAmountToCents[\s\S]{0,80}\} from "@\/lib\/billing\/cad-amount"/,
    );
    expect(DECISION).toMatch(/parseCadAmountToCents\(requestedFinalRaw, ceilingCents\)/);
  });

  it("rejects amount > 200000 cents (matches table CHECK and SESSION_PAYMENT_AMOUNT_CEILING_CENTS)", () => {
    expect(ACTION).toMatch(/SESSION_PAYMENT_AMOUNT_CEILING_CENTS/);
    expect(ACTION).toMatch(/AUTHORITATIVE_AMOUNT_TOO_LARGE_ERROR/);
    // The authored total's ceiling is the parser's, exercised in
    // tests/lib/billing/cad-amount.test.ts.
    expect(ACTION).toMatch(/ceilingCents: SESSION_PAYMENT_AMOUNT_CEILING_CENTS/);
  });

  it("owner-gates a CHANGED total and logs the denial with safe IDs only", () => {
    expect(ACTION).toMatch(/actorIsOwner = practitioner\.role === "owner"/);
    expect(ACTION).toMatch(/actorIsOwner,/);
    expect(ACTION).toMatch(
      /logInternal\("session_payment_amount_change_denied_not_owner", \{\s*studioId,\s*practitionerId,\s*\}\)/,
    );
  });

  it("still bounds internal note length to the constant from session-payment-types", () => {
    // Max-length validation is RETAINED; only the required-ness is relaxed.
    expect(ACTION).toMatch(/SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH/);
    expect(ACTION).toMatch(/NOTE_TOO_LONG_ERROR/);
  });
});

describe("prepare action: delegates the eligibility decision", () => {
  it("calls getSessionPaymentEligibility before any insert", () => {
    expect(ACTION).toMatch(
      /import \{[\s\S]{0,100}getSessionPaymentEligibility/,
    );
    expect(ACTION).toMatch(/await getSessionPaymentEligibility/);
  });

  it("returns blockingReasons to the UI when ineligible", () => {
    expect(ACTION).toMatch(/blockingReasons:\s*eligibility\.blockingReasons/);
  });
});

describe("prepare action: the inserted row shape", () => {
  it("inserts into payment_charge_attempts (NOT manual_fee_charge_attempts)", () => {
    expect(ACTION).toMatch(/\.from\("payment_charge_attempts"\)/);
    expect(ACTION).not.toMatch(/\.from\("manual_fee_charge_attempts"\)/);
  });

  it("stamps stripe_livemode from the deployment mode (PR #323; false in test env)", () => {
    expect(ACTION).toMatch(/stripe_livemode: inferStripeLivemode\(\)/);
    expect(ACTION).not.toMatch(/stripe_livemode:\s*false/);
  });

  it("stamps session_id (required for session_payment per reason_shape_check)", () => {
    expect(ACTION).toMatch(/session_id:\s*sessionId/);
  });
});

describe("prepare action: duplicate-race protection (23505 catch)", () => {
  it("catches Postgres unique violation code 23505 and returns the duplicate message", () => {
    expect(ACTION).toMatch(/insertErr\.code === "23505"/);
    expect(ACTION).toMatch(/DUPLICATE_ATTEMPT_ERROR/);
  });

  it("never surfaces raw DB error text to the practitioner", () => {
    expect(ACTION).toMatch(/GENERIC_PRACTITIONER_ERROR/);
    expect(ACTION).toMatch(/logInternal/);
  });
});

describe("prepare action: no payment / live-mode / SMS behavior added", () => {
  it("does NOT call paymentIntents.create", () => {
    expect(ACTION).not.toMatch(/paymentIntents\.create/);
  });

  it("does NOT call charges.create or refunds.create or checkout.sessions", () => {
    expect(ACTION).not.toMatch(/charges\.create/);
    expect(ACTION).not.toMatch(/refunds\.create/);
    expect(ACTION).not.toMatch(/checkout\.sessions/);
  });

  it("does NOT touch manual_fee_charge_attempts (the proven runtime stays untouched)", () => {
    expect(ACTION).not.toMatch(/manual_fee_charge_attempts/);
  });

  it("does NOT import any SMS or email helper", () => {
    expect(ACTION).not.toMatch(/lib\/sms\//);
    expect(ACTION).not.toMatch(/lib\/email\//);
    expect(ACTION).not.toMatch(/twilio/i);
    expect(ACTION).not.toMatch(/resend/i);
  });

  it("does NOT reference STRIPE_ALLOW_LIVE_MODE", () => {
    expect(ACTION).not.toMatch(/STRIPE_ALLOW_LIVE_MODE/);
  });
});

describe("session detail page wires the new card after the performer line", () => {
  it("imports SessionPaymentPrepareCard + the eligibility helper + the action", () => {
    expect(PAGE).toMatch(/SessionPaymentPrepareCard/);
    expect(PAGE).toMatch(/getSessionPaymentEligibility/);
    expect(PAGE).toMatch(/prepareSessionPaymentChargeAction/);
  });

  it("renders the card after the inline performer line (PR #199)", () => {
    // Pin the relative order: SessionPerformerLine then
    // SessionPaymentPrepareCard. A refactor that hides the
    // session payment card or moves it below the entries
    // section is caught here.
    const performerIdx = PAGE.search(/<SessionPerformerLine/);
    const paymentIdx = PAGE.search(/<SessionPaymentPrepareCard/);
    expect(performerIdx).toBeGreaterThan(-1);
    expect(paymentIdx).toBeGreaterThan(performerIdx);
  });
});

describe("SessionPaymentPrepareCard UI invariants", () => {
  it("declares 'use client' so the form transition is interactive", () => {
    expect(CARD).toMatch(/^"use client";/);
  });

  it("renders the neutral prepare disclaimer prominently", () => {
    // The disclaimer is rendered in the header and may wrap across
    // two lines in the JSX; allow the regex to bridge whitespace.
    expect(CARD).toMatch(
      /This prepares a payment record\.\s*The client is not charged until you\s*run the charge\./,
    );
  });

  it("does NOT render a 'Pay now' or 'Charge card' button", () => {
    // The file header comment explicitly documents what we are NOT
    // building (Pay now affordance / Charge card affordance). The
    // load-bearing check is that no button or JSX label uses those
    // strings; we look at the source with the leading block comment
    // stripped so the documentation does not trip the assertion.
    const headerStart = CARD.indexOf("// PR #172");
    const headerEnd = CARD.indexOf("export function ");
    const afterHeader =
      headerStart > -1 && headerEnd > headerStart
        ? CARD.slice(0, headerStart) + CARD.slice(headerEnd)
        : CARD;
    expect(afterHeader).not.toMatch(/Pay now/);
    expect(afterHeader).not.toMatch(/Charge card/);
  });

  it("does NOT import Stripe Elements or PaymentIntent helpers", () => {
    expect(CARD).not.toMatch(/@stripe\/stripe-js/);
    expect(CARD).not.toMatch(/@stripe\/react-stripe-js/);
    expect(CARD).not.toMatch(/paymentIntents/);
  });

  it("the submit button copy is neutral (no test-mode suffix)", () => {
    expect(CARD).toMatch(/Prepare session payment/);
    expect(CARD).not.toMatch(/Prepare session payment \(test mode\)/);
  });

  it("renders blocking reasons via a list", () => {
    expect(CARD).toMatch(/blockingReasons\.map/);
  });

  it("surfaces the existing-active-attempt state with a status panel (PR #174)", () => {
    // PR #174 refactor: the existing-attempt branch is now driven
    // by AttemptStatusPanel which dispatches on status. For a
    // 'ready' row the ReadyPanel renders "Session payment prepared"
    // -- the calm heading the practitioner sees on first render.
    expect(CARD).toMatch(/function ReadyPanel/);
    expect(CARD).toMatch(/Session payment prepared/);
  });

  it("shows the test-mode-only success state with the post-prepare action copy (PR #181 update)", () => {
    // PR #172 originally exposed the local "Attempt id: <uuid>" banner
    // as the just-prepared confirmation. PR #181 replaced that with a
    // cleaner "You can now run the charge." line + a
    // router.refresh() call so the persisted ReadyPanel (which says
    // "Session payment prepared") immediately becomes the single
    // source of truth. The ReadyPanel's "Session payment prepared"
    // heading is unchanged; only the local banner copy is updated.
    expect(CARD).toMatch(/Session payment prepared/);
    expect(CARD).toMatch(/You can now run the charge\./);
  });
});
