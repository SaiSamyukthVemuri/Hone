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

describe('prepare action: "use server" + auth gate', () => {
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
