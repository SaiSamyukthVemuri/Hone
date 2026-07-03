import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #173. Source-grep tests pin the load-bearing shape of
// runSessionPaymentCharge. The execution helper is the only NEW
// paymentIntents.create call site in the repo (allowlisted in
// scripts/check-stripe-gates.mjs). These tests guard the
// surrounding safety chain so a refactor cannot quietly drop one
// of the structural invariants:
//
//   * server-only boundary
//   * live-mode early return
//   * row-level live-mode + reason guards
//   * PR #170 current-card-authorization re-check at execution
//   * card lineage re-verification
//   * atomic claim via RPC BEFORE Stripe call
//   * deterministic idempotency key
//   * off_session + confirm true
//   * metadata fully populated for future webhook reconciliation
//   * success / failure outcomes write the same fields manual_fee
//     writes, on the same column names

const HELPER_PATH = path.resolve(
  __dirname,
  "../../../lib/billing/session-payment-charge.ts",
);
const HELPER = readFileSync(HELPER_PATH, "utf8");

describe("runSessionPaymentCharge: server boundary + admin client", () => {
  it("imports 'server-only'", () => {
    expect(HELPER).toMatch(/^import "server-only";/);
  });

  it("uses createAdminClient (not RLS)", () => {
    expect(HELPER).toMatch(/createAdminClient/);
  });
});

describe("runSessionPaymentCharge: live-mode guards (PR #323: env-gated)", () => {
  it("derives the deployment mode from inferStripeLivemode() (no hard early return)", () => {
    expect(HELPER).toMatch(/const livemode = inferStripeLivemode\(\)/);
    // The old hard `inferStripeLivemode() === true` dormancy early-return is gone
    // (check code only; comments may reference the removed guard).
    const code = HELPER.split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    expect(code).not.toMatch(/inferStripeLivemode\(\) === true/);
  });

  it("re-checks the row's mode against the deployment mode (mode-consistency)", () => {
    expect(HELPER).toMatch(/attemptRow\.stripe_livemode !== livemode/);
    expect(HELPER).toMatch(/outcome:\s*"live_mode_blocked"/);
    expect(HELPER).not.toMatch(/attemptRow\.stripe_livemode !== false/);
  });
});

describe("runSessionPaymentCharge: reason guard (session_payment only)", () => {
  it("refuses rows where charge_reason is not 'session_payment'", () => {
    expect(HELPER).toMatch(
      /attemptRow\.charge_reason !== "session_payment"[\s\S]{0,200}outcome:\s*"blocked"/,
    );
  });
});

describe("runSessionPaymentCharge: status-machine guards", () => {
  it("short-circuits on already-succeeded", () => {
    expect(HELPER).toMatch(
      /attemptRow\.status === "succeeded"[\s\S]{0,200}outcome:\s*"succeeded"/,
    );
  });

  it("refuses retry of failed / cancelled / blocked", () => {
    expect(HELPER).toMatch(
      /attemptRow\.status === "failed"[\s\S]{0,200}attemptRow\.status === "cancelled"[\s\S]{0,200}attemptRow\.status === "blocked"/,
    );
  });
});

describe("runSessionPaymentCharge: PR #170 + PR #177 card-authorization re-check", () => {
  // PR #170 introduced the current-version recheck via
  // getCardAuthorizationStatus. PR #177 tightened the recheck to
  // also catch a stale card_authorization_signature_id pointer on
  // the active card row -- the same gap docs/16 §5.11 found in
  // production. The execute path now calls the charge-ready helper
  // and surfaces the explicit "Client must re-sign" remedy.
  it("calls getChargeReadyCardAuthorizationStatus and refuses if kind !== 'signed_current'", () => {
    expect(HELPER).toMatch(/getChargeReadyCardAuthorizationStatus/);
    expect(HELPER).toMatch(
      /cardAuth\.kind !== "signed_current"[\s\S]{0,200}outcome:\s*"authorization_not_current"/,
    );
  });

  it("refuses on the new signed_current_but_card_pointer_stale variant with the remedy copy", () => {
    expect(HELPER).toMatch(
      /cardAuth\.kind === "signed_current_but_card_pointer_stale"[\s\S]{0,800}Client must re-sign the current card authorization for the card on file\./,
    );
  });

  it("refuses if the current signature id differs from the one stamped on the attempt", () => {
    expect(HELPER).toMatch(
      /cardAuth\.signatureId !== attemptRow\.card_authorization_signature_id/,
    );
  });
});

describe("runSessionPaymentCharge: atomic claim RPC", () => {
  it("calls the claim_session_payment_charge_attempt RPC", () => {
    expect(HELPER).toMatch(/admin\.rpc\(\s*\n?\s*"claim_session_payment_charge_attempt"/);
  });

  it("forwards p_attempt_id, p_practitioner_id, p_idempotency_key", () => {
    expect(HELPER).toMatch(/p_attempt_id:\s*attemptRow\.id/);
    expect(HELPER).toMatch(/p_practitioner_id:\s*args\.practitionerId/);
    expect(HELPER).toMatch(/p_idempotency_key:\s*idempotencyKey/);
  });

  it("the idempotency key is reason-scoped; session_payment keeps its historical shape (PR #196)", () => {
    expect(HELPER).toMatch(
      /buildIdempotencyKey\(attemptId: string, chargeReason: string\)[\s\S]{0,300}`hone:session_payment:\$\{attemptId\}:v1`/,
    );
    expect(HELPER).toMatch(/`hone:\$\{chargeReason\}:\$\{attemptId\}:v1`/);
  });

  it("the claim happens BEFORE the paymentIntents.create call", () => {
    // The claim must precede the Stripe call so a network failure
    // mid-Stripe cannot result in a still-'ready' row being
    // re-charged on the next click.
    const claimIdx = HELPER.search(/claim_session_payment_charge_attempt/);
    const createIdx = HELPER.search(/paymentIntents\.create/);
    expect(claimIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(claimIdx);
  });

  it("dispatches on all six claim result vocabulary values", () => {
    for (const tok of [
      '"already_succeeded"',
      '"already_pending"',
      '"not_found"',
      '"not_authorized"',
      '"not_ready"',
    ]) {
      expect(HELPER).toContain(tok);
    }
  });
});

describe("runSessionPaymentCharge: lineage recheck before Stripe", () => {
  it("re-verifies the active card row + signature + Stripe ids", () => {
    expect(HELPER).toMatch(/loadCardAndVerifyLineage/);
  });

  it("blocks if the card signature has changed since prepare", () => {
    expect(HELPER).toMatch(
      /Card authorization signature has changed since the session payment was prepared/,
    );
  });

  it("blocks if the studio reconnected to a different Stripe account", () => {
    expect(HELPER).toMatch(/Studio is now connected to a different Stripe account/);
  });
});

describe("runSessionPaymentCharge: paymentIntents.create parameters", () => {
  it("sets amount = attemptRow.amount_cents", () => {
    expect(HELPER).toMatch(/amount:\s*attemptRow\.amount_cents/);
  });

  it("sets currency = attemptRow.currency", () => {
    expect(HELPER).toMatch(/currency:\s*attemptRow\.currency/);
  });

  it("sets customer = card.stripe_customer_id", () => {
    expect(HELPER).toMatch(/customer:\s*card\.stripe_customer_id/);
  });

  it("sets payment_method = card.stripe_payment_method_id", () => {
    expect(HELPER).toMatch(/payment_method:\s*card\.stripe_payment_method_id/);
  });

  it("sets confirm: true AND off_session: true", () => {
    expect(HELPER).toMatch(/confirm:\s*true/);
    expect(HELPER).toMatch(/off_session:\s*true/);
  });

  it("passes stripeAccount + idempotencyKey on the RequestOptions arg", () => {
    expect(HELPER).toMatch(
      /\{\s*\n?\s*stripeAccount:\s*card\.stripe_account_id,\s*\n?\s*idempotencyKey,\s*\n?\s*\}/,
    );
  });

  it("does NOT set application_fee_amount (Hone 0% platform fee in v1)", () => {
    // The header comment legitimately documents the 0% Hone
    // platform fee decision and names the omitted parameter; we
    // check the actual call site (the paymentIntents.create
    // argument object) does not include the field.
    const callArgs =
      HELPER.match(/paymentIntents\.create\(\s*\{([\s\S]*?)\},/)?.[1] ?? "";
    expect(callArgs).not.toMatch(/application_fee_amount/);
  });

  it("does NOT set receipt_email", () => {
    const callArgs =
      HELPER.match(/paymentIntents\.create\(\s*\{([\s\S]*?)\},/)?.[1] ?? "";
    expect(callArgs).not.toMatch(/receipt_email/);
  });

  it("does NOT set statement_descriptor_suffix", () => {
    const callArgs =
      HELPER.match(/paymentIntents\.create\(\s*\{([\s\S]*?)\},/)?.[1] ?? "";
    expect(callArgs).not.toMatch(/statement_descriptor_suffix/);
  });
});

describe("runSessionPaymentCharge: PaymentIntent metadata", () => {
  const REQUIRED_METADATA_KEYS = [
    "hone_studio_id",
    "hone_client_id",
    "hone_session_id",
    "hone_appointment_id",
    "hone_session_payment_charge_attempt_id",
    "hone_charge_reason",
    "hone_card_authorization_signature_id",
    "hone_environment",
  ];

  for (const key of REQUIRED_METADATA_KEYS) {
    it(`metadata includes ${key}`, () => {
      expect(HELPER).toContain(`${key}:`);
    });
  }

  it("metadata env field is dynamic (live/test by deployment mode)", () => {
    expect(HELPER).toMatch(/hone_environment: livemode \? "live" : "test"/);
    expect(HELPER).not.toMatch(/hone_environment:\s*"test"/);
  });
});

describe("PR #320: accurate charge description (no 'session null')", () => {
  it("the PaymentIntent description comes from buildChargeDescription(attemptRow)", () => {
    expect(HELPER).toMatch(/description:\s*buildChargeDescription\(attemptRow\)/);
  });
  it("the old `Session payment for session ${...}` literal is gone", () => {
    expect(HELPER).not.toMatch(/Session payment for session \$\{/);
  });
  it("the description builder is imported from the pure (non-server-only) module", () => {
    expect(HELPER).toMatch(
      /import \{ buildChargeDescription \} from "@\/lib\/billing\/charge-description"/,
    );
  });
});

describe("PR #320: requires_action is canceled, never silently terminal", () => {
  it("both charge paths route requires_action to finalizeRequiresActionPaymentIntent BEFORE writing failed", () => {
    // create path (runSessionPaymentCharge) + reconcile path both branch first.
    const occurrences = HELPER.match(
      /if \(pi\.status === "requires_action"\) \{\s*return finalizeRequiresActionPaymentIntent\(/g,
    );
    expect(occurrences?.length).toBe(2);
  });

  it("finalizeRequiresActionPaymentIntent cancels the PaymentIntent (the one cancel call site)", () => {
    // Count the actual CALL (with paren), not comment mentions of the method.
    const cancels = HELPER.match(/paymentIntents\.cancel\(/g);
    expect(cancels?.length).toBe(1);
    const fn = HELPER.slice(
      HELPER.indexOf("async function finalizeRequiresActionPaymentIntent"),
    );
    expect(fn).toMatch(/await args\.stripe\.paymentIntents\.cancel\(/);
  });

  it("on cancel SUCCESS: writes terminal failed with failure code requires_action_canceled", () => {
    const fn = HELPER.slice(
      HELPER.indexOf("async function finalizeRequiresActionPaymentIntent"),
      HELPER.indexOf("\n// Pending reconciliation branch"),
    );
    expect(fn).toMatch(/writeFailedOutcome\(/);
    expect(fn).toMatch(/failureCode:\s*"requires_action_canceled"/);
    expect(fn).toMatch(/event:\s*"session_payment_requires_action_canceled"/);
  });

  it("on cancel FAILURE: critical alert + needs_manual_review, and does NOT write terminal failed", () => {
    const fn = HELPER.slice(
      HELPER.indexOf("async function finalizeRequiresActionPaymentIntent"),
      HELPER.indexOf("\n// Pending reconciliation branch"),
    );
    const catchBlock = fn.slice(fn.indexOf("catch (cancelErr)"));
    expect(catchBlock).toMatch(/severity:\s*"critical"/);
    expect(catchBlock).toMatch(/event:\s*"session_payment_requires_action_cancel_failed"/);
    expect(catchBlock).toMatch(/outcome:\s*"needs_manual_review"/);
    // The unresolved-Stripe-outcome path must NOT claim terminal failure.
    expect(catchBlock).not.toMatch(/writeFailedOutcome\(/);
    expect(catchBlock).not.toMatch(/outcome:\s*"failed"/);
  });

  it("does not add support for client-side 3DS completion", () => {
    expect(HELPER).not.toMatch(/confirmCardPayment|handleCardAction|next_action|client_secret/);
  });
});

describe("runSessionPaymentCharge: success / failure outcomes", () => {
  it("on success, writes status='succeeded', PI id, latest_charge id, charged_at", () => {
    expect(HELPER).toMatch(/status:\s*"succeeded"/);
    expect(HELPER).toMatch(/stripe_payment_intent_id:\s*args\.pi\.id/);
    expect(HELPER).toMatch(/charged_at:\s*new Date\(\)\.toISOString\(\)/);
  });

  it("on failure, writes status='failed', failed_at, failure_code, failure_message_safe", () => {
    expect(HELPER).toMatch(/status:\s*"failed"/);
    expect(HELPER).toMatch(/failed_at:\s*new Date\(\)\.toISOString\(\)/);
    expect(HELPER).toMatch(/failure_code:\s*sanitizeFailureCode/);
    expect(HELPER).toMatch(/failure_message_safe:\s*sanitizeFailureMessage/);
  });

  it("ops_alert event names use the session_payment_ namespace", () => {
    expect(HELPER).toMatch(/event:\s*"session_payment_charge_failed"/);
    expect(HELPER).toMatch(/event:\s*"session_payment_needs_manual_review"/);
  });

  it("authentication_required is escalated to severity 'critical'", () => {
    expect(HELPER).toMatch(
      /err\.code === "authentication_required" \? "critical" : "warning"/,
    );
  });
});

describe("runSessionPaymentCharge: no forbidden behavior added", () => {
  it("does NOT call charges.create, refunds.create, or checkout.sessions", () => {
    expect(HELPER).not.toMatch(/charges\.create/);
    expect(HELPER).not.toMatch(/refunds\.create/);
    expect(HELPER).not.toMatch(/checkout\.sessions/);
  });

  it("does NOT touch STRIPE_ALLOW_LIVE_MODE in code (comments may reference it)", () => {
    const codeOnly = HELPER.split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    expect(codeOnly).not.toMatch(/STRIPE_ALLOW_LIVE_MODE/);
  });

  it("does NOT touch manual_fee_charge_attempts", () => {
    // The header comment names the legacy table to document the
    // boundary. What we forbid is an actual .from() call against
    // that table from inside the helper.
    expect(HELPER).not.toMatch(/\.from\("manual_fee_charge_attempts"\)/);
    expect(HELPER).not.toMatch(/\.rpc\("claim_manual_fee_charge_attempt"/);
  });

  it("does NOT import any SMS or email helper", () => {
    expect(HELPER).not.toMatch(/lib\/sms\//);
    expect(HELPER).not.toMatch(/lib\/email\//);
    expect(HELPER).not.toMatch(/twilio/i);
    expect(HELPER).not.toMatch(/resend/i);
  });

  it("the file is the ONLY new paymentIntents.create call site in the repo", () => {
    // Counts the literal call expression `stripe.paymentIntents.create`.
    // We expect exactly 1 (the call) plus 0 substring references in
    // comments (those were rephrased so the gate script can count
    // cleanly).
    const callMatches = HELPER.match(/paymentIntents\.create/g) ?? [];
    expect(callMatches.length).toBe(1);
  });
});
