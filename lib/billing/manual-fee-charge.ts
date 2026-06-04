import "server-only";

import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getStripe, inferStripeLivemode } from "@/lib/stripe/server";
import { getManualFeeChargeEligibility } from "./manual-fee-eligibility";
import type { ManualFeeChargeType } from "./manual-fee-types";

// ===========================================================================
// Manual fee charge: TEST MODE ONLY (PR #146).
// ===========================================================================
//
// What this module does
// ---------------------
// Runs a Stripe PaymentIntent (create + confirm + off_session) against a
// previously-prepared manual_fee_charge_attempts row whose status is
// 'ready'. Recovers a 'pending_stripe' row deterministically without
// double-charging. All state changes go through the
// claim_manual_fee_charge_attempt RPC (migration 0065) so the
// status-transition contract holds across concurrent invocations.
//
// What this module does NOT do
// ----------------------------
// * No live charge. The hard test-mode gate (inferStripeLivemode() ===
//   false) plus the DB CHECK constraint
//   manual_fee_charge_attempts_livemode_false_check make a live row
//   structurally impossible.
// * No refund, no dispute, no invoice, no Checkout, no Charges API.
//   PaymentIntents only.
// * No platform-customer or platform-payment-method use; every Stripe
//   call carries { stripeAccount } so the charge lands on the studio's
//   connected account.
// * No automatic / batch / background flow. The only entry point is
//   the practitioner action that calls runManualFeeCharge.
// * No client_secret persistence. We never read or store it.
// * No raw PaymentIntent JSON or PaymentMethod object. Only the
//   sanitized scalar fields enumerated by the migration.
//
// Concurrency contract
// --------------------
// 1. Caller resolves practitioner + studio from the session.
// 2. We re-run eligibility server-side.
// 3. We claim the attempt via claim_manual_fee_charge_attempt:
//    ready -> pending_stripe atomically, stripe_idempotency_key
//    stamped. The deterministic key is
//    "hone:manual-fee:<attempt.id>:v1".
// 4. We call Stripe with that key and metadata. Stripe idempotency
//    replays the response if the call already ran within the 24h
//    Stripe window; the deterministic key plus the partial unique
//    manual_fee_charge_attempts_idempotency_uniq makes "two
//    PaymentIntents for one attempt" structurally impossible.
// 5. We update the row to succeeded / failed based on the Stripe
//    response. We never write 'succeeded' or 'failed' without a
//    matching Stripe result.
//
// Pending recovery
// ----------------
// claim_manual_fee_charge_attempt returns 'already_pending' when the
// row is already in pending_stripe (a previous click that crashed
// before recording the result). We then:
//   * If stripe_payment_intent_id is set: paymentIntents.retrieve on
//     the connected account, record the final status.
//   * If stripe_payment_intent_id is null AND the claim is recent
//     (<= 1 hour): retry create with the same idempotency key. Stripe
//     replays the original response if it actually landed.
//   * If stripe_payment_intent_id is null AND the claim is old: do
//     NOT retry blindly. Return 'needs_manual_review' so the
//     practitioner sees the calm message and the operator can
//     reconcile by hand. Blindly retrying after the Stripe
//     idempotency window could double-charge.

export type ManualFeeChargeResult =
  | {
      ok: true;
      outcome: "succeeded";
      stripePaymentIntentId: string;
      stripeChargeId: string | null;
    }
  | {
      ok: false;
      outcome:
        | "failed"
        | "needs_manual_review"
        | "blocked"
        | "live_mode_blocked"
        | "lineage_mismatch"
        | "not_found"
        | "not_authorized";
      message: string;
      blockingReasons?: string[];
      failureCode?: string | null;
    };

const RECONCILIATION_WINDOW_MINUTES = 60;
const FAILURE_MESSAGE_MAX = 1000;
const FAILURE_CODE_MAX = 100;
const LIVE_MODE_BLOCKED_MESSAGE =
  "Live charges are not enabled for this test-mode release.";
const NEEDS_MANUAL_REVIEW_MESSAGE =
  "This test charge is pending and needs manual review before retrying.";
const GENERIC_LINEAGE_MISMATCH_MESSAGE =
  "Card or studio details no longer match this fee. Refresh and try again.";
const AUTHENTICATION_REQUIRED_MESSAGE =
  "The saved card requires customer authentication and could not be charged off-session in this test flow.";

function buildIdempotencyKey(attemptId: string): string {
  return `hone:manual-fee:${attemptId}:v1`;
}

function logInternal(event: string, detail: unknown) {
  try {
    console.error(
      JSON.stringify({
        event,
        detail,
        timestamp: new Date().toISOString(),
      }),
    );
  } catch {
    console.error(event, detail);
  }
}

function sanitizeFailureCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.slice(0, FAILURE_CODE_MAX);
}

function sanitizeFailureMessage(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  // Strip newlines so a multi-line Stripe error cannot break out of a
  // single audit line; cap length so a paste-bomb cannot fill the
  // column.
  return raw.replace(/\s+/g, " ").trim().slice(0, FAILURE_MESSAGE_MAX);
}

type ClaimRow = {
  result: string;
  attempt_id: string | null;
  studio_id: string | null;
  appointment_id: string | null;
  client_id: string | null;
  charge_type: string | null;
  amount_cents: number | null;
  currency: string | null;
  client_payment_method_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_idempotency_key: string | null;
  status_before_claim: string | null;
  updated_at: string | null;
};

type CardRow = {
  id: string;
  studio_id: string;
  client_id: string;
  status: string;
  stripe_livemode: boolean;
  stripe_account_id: string;
  stripe_customer_id: string;
  stripe_payment_method_id: string;
  card_authorization_signature_id: string | null;
};

// Re-verifies the card / lineage at charge time. The eligibility
// helper already covered most of this, but we re-check the Stripe-id
// columns here because they were not surfaced in the eligibility
// summary (and because the row could have been deactivated between
// prepare and charge).
async function loadCardAndVerifyLineage(args: {
  attemptId: string;
  studioId: string;
  clientId: string;
  clientPaymentMethodId: string;
  expectedSignatureId: string;
}): Promise<
  | { ok: true; card: CardRow }
  | { ok: false; reasons: string[] }
> {
  const admin = createAdminClient();
  const reasons: string[] = [];

  const { data: cardRow } = await admin
    .from("client_payment_methods")
    .select(
      "id, studio_id, client_id, status, stripe_livemode, stripe_account_id, stripe_customer_id, stripe_payment_method_id, card_authorization_signature_id",
    )
    .eq("id", args.clientPaymentMethodId)
    .maybeSingle();
  const card = cardRow as CardRow | null;
  if (!card) {
    reasons.push("Card on file is missing.");
  } else {
    if (card.studio_id !== args.studioId) {
      reasons.push("Card on file does not belong to this studio.");
    }
    if (card.client_id !== args.clientId) {
      reasons.push("Card on file does not belong to this client.");
    }
    if (card.status !== "active") {
      reasons.push("Card on file is not active.");
    }
    if (card.stripe_livemode !== false) {
      reasons.push("Card on file is not in test mode.");
    }
    if (!card.stripe_account_id) {
      reasons.push("Card on file has no connected account.");
    }
    if (!card.stripe_customer_id) {
      reasons.push("Card on file has no Stripe customer.");
    }
    if (!card.stripe_payment_method_id) {
      reasons.push("Card on file has no Stripe payment method.");
    }
    if (
      card.card_authorization_signature_id !== args.expectedSignatureId
    ) {
      reasons.push(
        "Card authorization signature has changed since the fee was prepared.",
      );
    }
  }

  // The studio's currently-configured connected account must match
  // the card row. The card row's FK already binds it to a
  // studio_payment_settings row, but the studio could in theory
  // re-onboard onto a new account; in that case the prepared fee is
  // stale and should not run against the old account.
  if (card) {
    const { data: settings } = await admin
      .from("studio_payment_settings")
      .select("stripe_account_id, stripe_livemode")
      .eq("studio_id", args.studioId)
      .maybeSingle();
    if (!settings) {
      reasons.push("Studio payment settings are missing.");
    } else {
      if (settings.stripe_account_id !== card.stripe_account_id) {
        reasons.push(
          "Studio is now connected to a different Stripe account.",
        );
      }
      if (settings.stripe_livemode !== false) {
        reasons.push("Studio payment settings are not in test mode.");
      }
    }

    // Customer mapping must still resolve. This catches the unusual
    // case where a client_stripe_customers row was deleted out of
    // band.
    const { data: customer } = await admin
      .from("client_stripe_customers")
      .select("stripe_customer_id")
      .eq("studio_id", args.studioId)
      .eq("client_id", args.clientId)
      .eq("stripe_account_id", card.stripe_account_id)
      .eq("stripe_livemode", false)
      .maybeSingle();
    if (!customer) {
      reasons.push("Stripe customer mapping is missing.");
    } else if (customer.stripe_customer_id !== card.stripe_customer_id) {
      reasons.push("Stripe customer mapping does not match the card.");
    }
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  return { ok: true, card: card! };
}

// Snapshots a successful PaymentIntent back onto the attempt row.
async function writeSucceededOutcome(args: {
  attemptId: string;
  studioId: string;
  pi: Stripe.PaymentIntent;
  stripeAccountId: string;
  stripeCustomerId: string;
  stripePaymentMethodId: string;
}): Promise<void> {
  const admin = createAdminClient();
  const latestCharge =
    typeof args.pi.latest_charge === "string"
      ? args.pi.latest_charge
      : (args.pi.latest_charge?.id ?? null);
  const { error } = await admin
    .from("manual_fee_charge_attempts")
    .update({
      status: "succeeded",
      stripe_account_id: args.stripeAccountId,
      stripe_customer_id: args.stripeCustomerId,
      stripe_payment_method_id: args.stripePaymentMethodId,
      stripe_payment_intent_id: args.pi.id,
      stripe_charge_id: latestCharge,
      stripe_status: args.pi.status,
      charged_at: new Date().toISOString(),
    })
    .eq("id", args.attemptId);
  if (error) {
    logInternal("manual_fee_write_succeeded_failed", {
      code: error.code,
      message: error.message,
      attemptId: args.attemptId,
    });
  }
}

// Snapshots a failed PaymentIntent (or thrown StripeCardError) back
// onto the attempt row.
async function writeFailedOutcome(args: {
  attemptId: string;
  paymentIntentId: string | null;
  stripeStatus: string | null;
  stripeAccountId: string | null;
  stripeCustomerId: string | null;
  stripePaymentMethodId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("manual_fee_charge_attempts")
    .update({
      status: "failed",
      stripe_account_id: args.stripeAccountId,
      stripe_customer_id: args.stripeCustomerId,
      stripe_payment_method_id: args.stripePaymentMethodId,
      stripe_payment_intent_id: args.paymentIntentId,
      stripe_status: args.stripeStatus,
      failed_at: new Date().toISOString(),
      failure_code: sanitizeFailureCode(args.failureCode),
      failure_message: sanitizeFailureMessage(args.failureMessage),
    })
    .eq("id", args.attemptId);
  if (error) {
    logInternal("manual_fee_write_failed_failed", {
      code: error.code,
      message: error.message,
      attemptId: args.attemptId,
    });
  }
}

// Resolves a Stripe PaymentIntent that may already exist for the
// attempt (the pending-reconciliation path) and writes the
// appropriate outcome back to the row. Returns the practitioner-
// facing result.
async function reconcileExistingPaymentIntent(args: {
  attemptId: string;
  stripeAccountId: string;
  stripeCustomerId: string;
  stripePaymentMethodId: string;
  paymentIntentId: string;
}): Promise<ManualFeeChargeResult> {
  const stripe = getStripe();
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.retrieve(args.paymentIntentId, undefined, {
      stripeAccount: args.stripeAccountId,
    });
  } catch (err) {
    logInternal("manual_fee_pi_retrieve_failed", {
      attemptId: args.attemptId,
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      outcome: "needs_manual_review",
      message: NEEDS_MANUAL_REVIEW_MESSAGE,
    };
  }

  if (pi.status === "succeeded") {
    await writeSucceededOutcome({
      attemptId: args.attemptId,
      studioId: "",
      pi,
      stripeAccountId: args.stripeAccountId,
      stripeCustomerId: args.stripeCustomerId,
      stripePaymentMethodId: args.stripePaymentMethodId,
    });
    const latestCharge =
      typeof pi.latest_charge === "string"
        ? pi.latest_charge
        : (pi.latest_charge?.id ?? null);
    return {
      ok: true,
      outcome: "succeeded",
      stripePaymentIntentId: pi.id,
      stripeChargeId: latestCharge,
    };
  }

  // Non-succeeded terminal states: canceled, requires_action,
  // requires_payment_method. All treated as failure for the off-
  // session test flow; the practitioner sees a calm message.
  if (
    pi.status === "canceled" ||
    pi.status === "requires_action" ||
    pi.status === "requires_payment_method"
  ) {
    await writeFailedOutcome({
      attemptId: args.attemptId,
      paymentIntentId: pi.id,
      stripeStatus: pi.status,
      stripeAccountId: args.stripeAccountId,
      stripeCustomerId: args.stripeCustomerId,
      stripePaymentMethodId: args.stripePaymentMethodId,
      failureCode: pi.last_payment_error?.code ?? pi.status,
      failureMessage:
        pi.last_payment_error?.message ??
        `PaymentIntent status: ${pi.status}`,
    });
    return {
      ok: false,
      outcome: "failed",
      message:
        pi.status === "requires_action"
          ? AUTHENTICATION_REQUIRED_MESSAGE
          : (pi.last_payment_error?.message ??
            "Stripe could not charge the saved card."),
      failureCode: pi.last_payment_error?.code ?? pi.status,
    };
  }

  // 'processing': keep pending; Stripe will finalize asynchronously.
  return {
    ok: false,
    outcome: "needs_manual_review",
    message: NEEDS_MANUAL_REVIEW_MESSAGE,
  };
}

// Entry point. Caller MUST already have resolved practitioner +
// studio from the session.
export async function runManualFeeCharge(args: {
  attemptId: string;
  studioId: string;
  practitionerId: string;
}): Promise<ManualFeeChargeResult> {
  // 1. Hard test-mode gate from environment. Belt; the DB CHECK and
  //    Stripe key gate are the braces.
  if (inferStripeLivemode() === true) {
    return {
      ok: false,
      outcome: "live_mode_blocked",
      message: LIVE_MODE_BLOCKED_MESSAGE,
    };
  }

  const admin = createAdminClient();

  // 2. Load the attempt and re-run evidence eligibility for the
  //    matching (status, charge_type). The eligibility helper covers
  //    most of what we need; the lineage helper below covers the
  //    Stripe-id columns the eligibility helper doesn't surface.
  const { data: attemptRow } = await admin
    .from("manual_fee_charge_attempts")
    .select(
      "id, studio_id, appointment_id, client_id, charge_type, amount_cents, currency, status, client_payment_method_id, card_authorization_signature_id, stripe_payment_intent_id, stripe_idempotency_key, updated_at",
    )
    .eq("id", args.attemptId)
    .eq("studio_id", args.studioId)
    .maybeSingle();
  if (!attemptRow) {
    return {
      ok: false,
      outcome: "not_found",
      message: "Fee charge attempt not found.",
    };
  }

  // Already succeeded? Return without touching Stripe. The action
  // surface treats a repeat click on a succeeded row as a no-op.
  if (attemptRow.status === "succeeded") {
    return {
      ok: true,
      outcome: "succeeded",
      stripePaymentIntentId: attemptRow.stripe_payment_intent_id ?? "",
      stripeChargeId: null,
    };
  }

  // Refuse retry of terminal-non-success states. failed/cancelled/
  // blocked rows cannot move forward in this PR.
  if (
    attemptRow.status === "failed" ||
    attemptRow.status === "cancelled" ||
    attemptRow.status === "blocked"
  ) {
    return {
      ok: false,
      outcome: "blocked",
      message: "This fee charge cannot be retried.",
    };
  }

  // Eligibility recheck on 'ready' and 'pending_stripe' branches.
  // We compute the charge_type from the row, NEVER the browser.
  const chargeType = attemptRow.charge_type as ManualFeeChargeType;
  const eligibility = await getManualFeeChargeEligibility({
    studioId: args.studioId,
    appointmentId: attemptRow.appointment_id,
    chargeType,
  });
  if (!eligibility.eligible) {
    // The duplicate-attempt block reason fires whenever an active
    // attempt exists for the same (appointment, charge_type), which
    // is true here by construction. Strip that reason; everything
    // else still has to pass.
    const filtered = eligibility.blockingReasons.filter(
      (r) =>
        r !==
        "An active fee charge attempt already exists for this appointment.",
    );
    if (filtered.length > 0) {
      return {
        ok: false,
        outcome: "blocked",
        message:
          "This appointment is no longer eligible for the prepared fee.",
        blockingReasons: filtered,
      };
    }
  }

  const lineage = await loadCardAndVerifyLineage({
    attemptId: attemptRow.id,
    studioId: attemptRow.studio_id,
    clientId: attemptRow.client_id,
    clientPaymentMethodId: attemptRow.client_payment_method_id,
    expectedSignatureId: attemptRow.card_authorization_signature_id,
  });
  if (!lineage.ok) {
    return {
      ok: false,
      outcome: "lineage_mismatch",
      message: GENERIC_LINEAGE_MISMATCH_MESSAGE,
      blockingReasons: lineage.reasons,
    };
  }
  const card = lineage.card;

  // 3. Atomically claim the attempt. Idempotency key is deterministic
  //    so a retry produces the same key.
  const idempotencyKey = buildIdempotencyKey(attemptRow.id);
  const { data: claimRows, error: claimErr } = await admin.rpc(
    "claim_manual_fee_charge_attempt",
    {
      p_attempt_id: attemptRow.id,
      p_practitioner_id: args.practitionerId,
      p_idempotency_key: idempotencyKey,
    },
  );
  if (claimErr) {
    logInternal("manual_fee_claim_rpc_failed", {
      code: claimErr.code,
      message: claimErr.message,
      attemptId: attemptRow.id,
    });
    return {
      ok: false,
      outcome: "failed",
      message: "We could not start the test charge. Please try again.",
    };
  }
  const claim = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as
    | ClaimRow
    | null;
  if (!claim) {
    return {
      ok: false,
      outcome: "failed",
      message: "We could not start the test charge. Please try again.",
    };
  }

  // 'already_succeeded' was already short-circuited above; the RPC
  // also covers the case where the row succeeded between our read
  // and the claim.
  if (claim.result === "already_succeeded") {
    return {
      ok: true,
      outcome: "succeeded",
      stripePaymentIntentId: claim.stripe_payment_intent_id ?? "",
      stripeChargeId: null,
    };
  }
  if (
    claim.result === "not_found" ||
    claim.result === "not_authorized" ||
    claim.result === "not_ready"
  ) {
    return {
      ok: false,
      outcome:
        claim.result === "not_authorized" ? "not_authorized" : "blocked",
      message:
        claim.result === "not_authorized"
          ? "You don't have permission to charge this fee."
          : "This fee charge is not in a chargeable state.",
    };
  }

  // 4a. Pending reconciliation: row is already pending_stripe.
  if (claim.result === "already_pending") {
    if (claim.stripe_payment_intent_id) {
      return reconcileExistingPaymentIntent({
        attemptId: attemptRow.id,
        stripeAccountId: card.stripe_account_id,
        stripeCustomerId: card.stripe_customer_id,
        stripePaymentMethodId: card.stripe_payment_method_id,
        paymentIntentId: claim.stripe_payment_intent_id,
      });
    }
    // No PI id on the row. Check whether the claim is recent enough
    // to retry-create with the same idempotency key (Stripe will
    // replay the prior response).
    const claimedAt = claim.updated_at
      ? new Date(claim.updated_at).getTime()
      : 0;
    const ageMin = (Date.now() - claimedAt) / 60000;
    if (
      claimedAt > 0 &&
      Number.isFinite(ageMin) &&
      ageMin <= RECONCILIATION_WINDOW_MINUTES
    ) {
      // Fall through to the create-and-confirm path with the same
      // deterministic key.
    } else {
      return {
        ok: false,
        outcome: "needs_manual_review",
        message: NEEDS_MANUAL_REVIEW_MESSAGE,
      };
    }
  }

  // 4b. Create + confirm the PaymentIntent. Off-session because the
  //     practitioner is taking the action, not the cardholder.
  //
  //     metadata: every Hone identity column the future webhook
  //     handler or a manual reconciler needs to bind a leaked-back
  //     PaymentIntent to this attempt.
  const stripe = getStripe();
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create(
      {
        amount: attemptRow.amount_cents,
        currency: attemptRow.currency,
        customer: card.stripe_customer_id,
        payment_method: card.stripe_payment_method_id,
        confirm: true,
        off_session: true,
        description: `Manual fee for appointment ${attemptRow.appointment_id}`,
        metadata: {
          hone_studio_id: attemptRow.studio_id,
          hone_appointment_id: attemptRow.appointment_id,
          hone_client_id: attemptRow.client_id,
          hone_manual_fee_charge_attempt_id: attemptRow.id,
          hone_charge_type: attemptRow.charge_type,
          hone_environment: "test",
        },
      },
      {
        stripeAccount: card.stripe_account_id,
        idempotencyKey,
      },
    );
  } catch (err) {
    // Stripe.errors.StripeCardError covers card_declined,
    // authentication_required, etc. The error often carries
    // payment_intent.{id, status} so we record what we can.
    if (err instanceof Stripe.errors.StripeError) {
      // StripeError carries an optional .payment_intent property on
      // the card / decline subclasses. The SDK's type namespace does
      // not expose it directly, so we read it through a duck-typed
      // structural shape that is safe across SDK minor versions.
      const decline = err as unknown as {
        code?: string;
        type?: string;
        message?: string;
        payment_intent?: { id?: string; status?: string };
      };
      const paymentIntent = decline.payment_intent;
      const piId = paymentIntent?.id ?? null;
      const piStatus = paymentIntent?.status ?? null;
      await writeFailedOutcome({
        attemptId: attemptRow.id,
        paymentIntentId: piId,
        stripeStatus: piStatus,
        stripeAccountId: card.stripe_account_id,
        stripeCustomerId: card.stripe_customer_id,
        stripePaymentMethodId: card.stripe_payment_method_id,
        failureCode: err.code ?? piStatus,
        failureMessage: err.message,
      });
      logInternal("manual_fee_stripe_error", {
        attemptId: attemptRow.id,
        type: err.type,
        code: err.code,
      });
      return {
        ok: false,
        outcome: "failed",
        message:
          err.code === "authentication_required"
            ? AUTHENTICATION_REQUIRED_MESSAGE
            : (err.message || "Stripe could not charge the saved card."),
        failureCode: err.code ?? null,
      };
    }
    // Unknown error AFTER claim: leave row pending_stripe and force
    // manual reconciliation. We must NOT mark failed if we cannot
    // prove no charge happened, because a transient network error
    // after Stripe accepted the request would have already moved
    // money. The next click hits the reconciliation path.
    logInternal("manual_fee_stripe_unknown_error", {
      attemptId: attemptRow.id,
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      outcome: "needs_manual_review",
      message: NEEDS_MANUAL_REVIEW_MESSAGE,
    };
  }

  // 5. Stripe accepted the create+confirm. The PI either succeeded
  //    or sits in requires_action / requires_payment_method.
  if (pi.status === "succeeded") {
    await writeSucceededOutcome({
      attemptId: attemptRow.id,
      studioId: attemptRow.studio_id,
      pi,
      stripeAccountId: card.stripe_account_id,
      stripeCustomerId: card.stripe_customer_id,
      stripePaymentMethodId: card.stripe_payment_method_id,
    });
    const latestCharge =
      typeof pi.latest_charge === "string"
        ? pi.latest_charge
        : (pi.latest_charge?.id ?? null);
    return {
      ok: true,
      outcome: "succeeded",
      stripePaymentIntentId: pi.id,
      stripeChargeId: latestCharge,
    };
  }

  // Off-session SCA hit. Stripe did not throw because the create
  // succeeded structurally, but the PI is in a "needs the
  // cardholder" status.
  await writeFailedOutcome({
    attemptId: attemptRow.id,
    paymentIntentId: pi.id,
    stripeStatus: pi.status,
    stripeAccountId: card.stripe_account_id,
    stripeCustomerId: card.stripe_customer_id,
    stripePaymentMethodId: card.stripe_payment_method_id,
    failureCode: pi.last_payment_error?.code ?? pi.status,
    failureMessage:
      pi.last_payment_error?.message ??
      (pi.status === "requires_action"
        ? AUTHENTICATION_REQUIRED_MESSAGE
        : `PaymentIntent status: ${pi.status}`),
  });
  return {
    ok: false,
    outcome: "failed",
    message:
      pi.status === "requires_action"
        ? AUTHENTICATION_REQUIRED_MESSAGE
        : (pi.last_payment_error?.message ??
          "Stripe could not charge the saved card."),
    failureCode: pi.last_payment_error?.code ?? pi.status,
  };
}
