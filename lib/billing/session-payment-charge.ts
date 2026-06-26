import "server-only";
import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getStripe, inferStripeLivemode } from "@/lib/stripe/server";
import { recordOpsAlert } from "@/lib/ops/alerts";
import { getChargeReadyCardAuthorizationStatus } from "@/lib/consent/current-card-authorization";

// ---------------------------------------------------------------------------
// runSessionPaymentCharge (PR #173).
// ---------------------------------------------------------------------------
//
// Test-mode-only execution helper for a prepared session_payment
// payment_charge_attempts row. Faithful port of
// lib/billing/the (removed, PR #218) legacy manual-fee executor:runManualFeeCharge (PR #146)
// adapted for the canonical payment_charge_attempts ledger
// (migration 0073 + 0074 + the PR #173 claim RPC migration 0075).
//
// What this helper does:
//   1. Refuses to run in live mode (inferStripeLivemode() === true
//      short-circuit; mirrors the manual fee belt; the DB CHECK +
//      Stripe key gate are the braces).
//   2. Loads the attempt row + re-runs eligibility checks. Card
//      lineage (active, livemode=false, signature matches the
//      stamped id), studio Stripe settings, customer mapping, and
//      crucially a PR #170-style current-card-authorization recheck
//      so a freshly-stale signature blocks the charge.
//   3. Calls the claim_session_payment_charge_attempt RPC. The RPC
//      atomically transitions status='ready' -> 'pending_stripe'
//      and stamps the deterministic idempotency key
//      hone:session_payment:<attemptId>:v1. Caller never bypasses
//      the RPC to claim the row directly.
//   4. Calls the Stripe PaymentIntent create API with
//      confirm=true. The connected account context is the studio's
//      stripe_account_id. The idempotency key is the deterministic
//      shape; Stripe's 24-hour replay covers the network-error
//      retry path.
//   5. Writes the success outcome (status='succeeded', PI id, PI
//      latest_charge id, stripe_status, charged_at) OR the failure
//      outcome (status='failed', failure_code, failure_message_safe,
//      failed_at) on the same row. Records ops_alerts on failure
//      paths with severity matching the manual fee precedent.
//
// What this helper deliberately does NOT do:
//   * Does NOT charge a live card. Three structural guards block
//     it (inferStripeLivemode() early return; payment_charge_attempts
//     _livemode_false_check DB CHECK; key-format gate in lib/stripe
//     /server.ts).
//   * Does NOT send a receipt email. Receipt path is PR #172's
//     follow-up.
//   * Does NOT refund or retry a failed/cancelled row. PR #173
//     refuses to re-execute any non-'ready' row except the
//     reconciliation path on a stale pending_stripe.
//   * Does NOT set application_fee_amount. PR #169 / docs/16 §12.7
//     pinned 0% Hone platform fee in v1.
//   * Does NOT set statement_descriptor_suffix or receipt_email.
//   * Does NOT touch manual_fee_charge_attempts.
//   * Does NOT add any SMS / email / webhook side effects beyond
//     the existing ops_alert + structured-log surface.

const RECONCILIATION_WINDOW_MINUTES = 60;
const FAILURE_MESSAGE_MAX = 1000;
const FAILURE_CODE_MAX = 100;
const LIVE_MODE_BLOCKED_MESSAGE =
  "Live charges are not enabled for this test-mode release.";
const NEEDS_MANUAL_REVIEW_MESSAGE =
  "This test charge is pending and needs manual review before retrying.";
const GENERIC_LINEAGE_MISMATCH_MESSAGE =
  "Card or studio details no longer match this session payment. Refresh and try again.";
const AUTHENTICATION_REQUIRED_MESSAGE =
  "The saved card requires customer authentication and could not be charged off-session in this test flow.";

// PR #196: reason-scoped deterministic key. session_payment keeps its
// historical format so in-flight rows replay identically; fee reasons
// get their own namespace.
function buildIdempotencyKey(attemptId: string, chargeReason: string): string {
  if (chargeReason === "session_payment") {
    return `hone:session_payment:${attemptId}:v1`;
  }
  return `hone:${chargeReason}:${attemptId}:v1`;
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

export type SessionPaymentChargeResult =
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
        | "authorization_not_current"
        | "not_found"
        | "not_authorized";
      message: string;
      blockingReasons?: string[];
      failureCode?: string | null;
    };

type ClaimRow = {
  result: string;
  attempt_id: string | null;
  studio_id: string | null;
  client_id: string | null;
  session_id: string | null;
  appointment_id: string | null;
  charge_reason: string | null;
  amount_cents: number | null;
  currency: string | null;
  client_payment_method_id: string | null;
  card_authorization_signature_id: string | null;
  stripe_account_id: string | null;
  stripe_customer_id: string | null;
  stripe_payment_method_id: string | null;
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
// helper already covered most of this at prepare time, but the
// row could have changed between prepare and charge.
async function loadCardAndVerifyLineage(args: {
  studioId: string;
  clientId: string;
  clientPaymentMethodId: string;
  expectedSignatureId: string;
  expectedStripeAccountId: string;
  expectedStripeCustomerId: string;
  expectedStripePaymentMethodId: string;
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
        "Card authorization signature has changed since the session payment was prepared.",
      );
    }
    if (card.stripe_account_id !== args.expectedStripeAccountId) {
      reasons.push(
        "Stripe connected account on the card no longer matches the prepared attempt.",
      );
    }
    if (card.stripe_customer_id !== args.expectedStripeCustomerId) {
      reasons.push(
        "Stripe customer on the card no longer matches the prepared attempt.",
      );
    }
    if (card.stripe_payment_method_id !== args.expectedStripePaymentMethodId) {
      reasons.push(
        "Stripe payment method on the card no longer matches the prepared attempt.",
      );
    }
  }

  // The studio's currently-configured connected account must match
  // the card row.
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
  pi: Stripe.PaymentIntent;
}): Promise<void> {
  const admin = createAdminClient();
  const latestCharge =
    typeof args.pi.latest_charge === "string"
      ? args.pi.latest_charge
      : (args.pi.latest_charge?.id ?? null);
  const { data: updatedRows, error } = await admin
    .from("payment_charge_attempts")
    .update({
      status: "succeeded",
      stripe_payment_intent_id: args.pi.id,
      stripe_charge_id: latestCharge,
      stripe_status: args.pi.status,
      charged_at: new Date().toISOString(),
      failed_at: null,
      failure_code: null,
      failure_message_safe: null,
    })
    .eq("id", args.attemptId)
    .eq("status", "pending_stripe")
    .select("id");
  if (error) {
    logInternal("session_payment_succeeded_write_failed", {
      code: error.code,
      message: error.message,
      attemptId: args.attemptId,
    });
    return;
  }
  // PR #263: zero-row detection. A status-conditional UPDATE that
  // matches no row (the attempt left 'pending_stripe' before this
  // write) returns no error but persists nothing. The PaymentIntent
  // already succeeded at Stripe, so a silent no-op would leave the
  // ledger row unstamped while real money moved. Surface for manual
  // reconciliation instead of continuing as if the outcome was recorded.
  if (!updatedRows || updatedRows.length === 0) {
    logInternal("session_payment_succeeded_write_zero_rows", {
      attemptId: args.attemptId,
    });
    await recordOpsAlert({
      severity: "critical",
      event: "session_payment_succeeded_write_zero_rows",
      message:
        "PaymentIntent succeeded but the succeeded-outcome update affected zero rows (the attempt was no longer 'pending_stripe'). The ledger row may be unstamped while the charge is real on Stripe. Manual reconciliation required.",
      stripePaymentIntentId: args.pi.id,
      route: "lib/billing/session-payment-charge:writeSucceededOutcome",
      safeDetails: {
        attempt_id: args.attemptId,
        attempted_status: "succeeded",
      },
    });
  }
}

async function writeFailedOutcome(args: {
  attemptId: string;
  paymentIntentId: string | null;
  stripeStatus: string | null;
  failureCode: string | null | undefined;
  failureMessage: string | null | undefined;
}): Promise<void> {
  const admin = createAdminClient();
  const { data: updatedRows, error } = await admin
    .from("payment_charge_attempts")
    .update({
      status: "failed",
      stripe_payment_intent_id: args.paymentIntentId,
      stripe_status: args.stripeStatus,
      failed_at: new Date().toISOString(),
      failure_code: sanitizeFailureCode(args.failureCode),
      failure_message_safe: sanitizeFailureMessage(args.failureMessage),
    })
    .eq("id", args.attemptId)
    .eq("status", "pending_stripe")
    .select("id");
  if (error) {
    logInternal("session_payment_failed_write_failed", {
      code: error.code,
      message: error.message,
      attemptId: args.attemptId,
    });
    return;
  }
  // PR #263: zero-row detection. A failed-outcome update that matches no
  // 'pending_stripe' row persisted nothing; the row may be stuck in
  // 'pending_stripe' (or was already moved by a concurrent writer) while
  // the caller reports 'failed'. Surface for manual review rather than
  // silently diverging the stored row from the reported outcome.
  if (!updatedRows || updatedRows.length === 0) {
    logInternal("session_payment_failed_write_zero_rows", {
      attemptId: args.attemptId,
    });
    await recordOpsAlert({
      severity: "warning",
      event: "session_payment_failed_write_zero_rows",
      message:
        "A failed-outcome update affected zero rows (the attempt was no longer 'pending_stripe'). The attempt row may not reflect the reported failure. Manual review may be required.",
      stripePaymentIntentId: args.paymentIntentId,
      route: "lib/billing/session-payment-charge:writeFailedOutcome",
      safeDetails: {
        attempt_id: args.attemptId,
        attempted_status: "failed",
      },
    });
  }
}

// Pending reconciliation branch. Stale pending_stripe rows with a
// known PaymentIntent id: read the PI back from Stripe to recover
// the true status without re-creating.
async function reconcileExistingPaymentIntent(args: {
  attemptId: string;
  studioId: string;
  clientId: string;
  sessionId: string;
  appointmentId: string | null;
  stripeAccountId: string;
  paymentIntentId: string;
}): Promise<SessionPaymentChargeResult> {
  const stripe = getStripe();
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.retrieve(
      args.paymentIntentId,
      undefined,
      { stripeAccount: args.stripeAccountId },
    );
  } catch (err) {
    logInternal("session_payment_reconcile_retrieve_failed", {
      attemptId: args.attemptId,
      paymentIntentId: args.paymentIntentId,
      message: err instanceof Error ? err.message : String(err),
    });
    await recordOpsAlert({
      severity: "critical",
      event: "session_payment_needs_manual_review",
      message:
        "Stripe PaymentIntent retrieve failed during reconciliation; row stays pending_stripe.",
      studioId: args.studioId,
      clientId: args.clientId,
      route: "lib/billing/session-payment-charge:reconcileExistingPaymentIntent",
      safeDetails: {
        attempt_id: args.attemptId,
        session_id: args.sessionId,
        appointment_id: args.appointmentId,
        stripe_payment_intent_id: args.paymentIntentId,
        reason: "retrieve_failed",
      },
    });
    return {
      ok: false,
      outcome: "needs_manual_review",
      message: NEEDS_MANUAL_REVIEW_MESSAGE,
    };
  }
  if (pi.status === "succeeded") {
    await writeSucceededOutcome({ attemptId: args.attemptId, pi });
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
  await writeFailedOutcome({
    attemptId: args.attemptId,
    paymentIntentId: pi.id,
    stripeStatus: pi.status,
    failureCode: pi.last_payment_error?.code ?? pi.status,
    failureMessage:
      pi.last_payment_error?.message ?? `PaymentIntent status: ${pi.status}`,
  });
  await recordOpsAlert({
    severity: "warning",
    event: "session_payment_charge_failed",
    message: `Reconciled PaymentIntent status: ${pi.status}`,
    studioId: args.studioId,
    clientId: args.clientId,
    route: "lib/billing/session-payment-charge:reconcileExistingPaymentIntent",
    safeDetails: {
      attempt_id: args.attemptId,
      session_id: args.sessionId,
      appointment_id: args.appointmentId,
      stripe_payment_intent_id: pi.id,
      stripe_status: pi.status,
      failure_code: pi.last_payment_error?.code ?? pi.status,
    },
  });
  return {
    ok: false,
    outcome: "failed",
    message:
      pi.status === "requires_action"
        ? AUTHENTICATION_REQUIRED_MESSAGE
        : pi.last_payment_error?.message ?? "PaymentIntent did not succeed.",
    failureCode: pi.last_payment_error?.code ?? pi.status,
  };
}

// Entry point. Caller MUST already have resolved practitioner +
// studio from the session.
export async function runSessionPaymentCharge(args: {
  attemptId: string;
  studioId: string;
  practitionerId: string;
}): Promise<SessionPaymentChargeResult> {
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

  // 2. Load the attempt row scoped by studio_id. The row carries
  //    everything we need to validate lineage + call Stripe.
  const { data: attemptRow } = await admin
    .from("payment_charge_attempts")
    .select(
      "id, studio_id, charge_reason, client_id, session_id, appointment_id, amount_cents, currency, status, stripe_livemode, client_payment_method_id, card_authorization_signature_id, stripe_account_id, stripe_customer_id, stripe_payment_method_id, stripe_payment_intent_id, stripe_idempotency_key, updated_at",
    )
    .eq("id", args.attemptId)
    .eq("studio_id", args.studioId)
    .maybeSingle();
  if (!attemptRow) {
    return {
      ok: false,
      outcome: "not_found",
      message: "Session payment attempt not found.",
    };
  }
  // Reason guard (PR #196 unification): the three canonical charge
  // reasons execute through this one audited path. Anything else
  // refuses.
  if (
    attemptRow.charge_reason !== "session_payment" &&
    attemptRow.charge_reason !== "no_show_fee" &&
    attemptRow.charge_reason !== "late_cancellation_fee"
  ) {
    return {
      ok: false,
      outcome: "blocked",
      message: "This attempt has an unsupported charge reason.",
    };
  }
  // Row-level live-mode guard (mirror of the RPC guard).
  if (attemptRow.stripe_livemode !== false) {
    return {
      ok: false,
      outcome: "live_mode_blocked",
      message: LIVE_MODE_BLOCKED_MESSAGE,
    };
  }

  // Already-succeeded short-circuit. Repeat clicks on a succeeded
  // row are a no-op.
  if (attemptRow.status === "succeeded") {
    return {
      ok: true,
      outcome: "succeeded",
      stripePaymentIntentId: attemptRow.stripe_payment_intent_id ?? "",
      stripeChargeId: null,
    };
  }
  // Refuse retry of terminal-non-success states.
  if (
    attemptRow.status === "failed" ||
    attemptRow.status === "cancelled" ||
    attemptRow.status === "blocked"
  ) {
    return {
      ok: false,
      outcome: "blocked",
      message: "This session payment cannot be retried.",
    };
  }

  // 3. PR #170 + PR #177 current-card-authorization recheck. The
  //    signature stamped at prepare time may have been the current
  //    version then but the template could have been re-edited
  //    (version bumped) between prepare and execute, OR the active
  //    card row's pointer could have drifted in that window (a
  //    card replacement / restore path). The charge-ready helper
  //    is stricter than the base PR #170 helper: it ALSO verifies
  //    that the active card row's card_authorization_signature_id
  //    equals the current signed_current signature. The execute
  //    invariant is the AND of all three:
  //
  //      cardAuth.signatureId == active_card.card_authorization_signature_id
  //      cardAuth.signatureId == attemptRow.card_authorization_signature_id
  //      active_card.card_authorization_signature_id == attemptRow.card_authorization_signature_id
  //
  //    The first equality is enforced by the charge-ready helper.
  //    The second is enforced here. The third is enforced by
  //    loadCardAndVerifyLineage below (step 4).
  const cardAuth = await getChargeReadyCardAuthorizationStatus({
    studioId: attemptRow.studio_id,
    clientId: attemptRow.client_id,
  });
  if (cardAuth.kind === "signed_current_but_card_pointer_stale") {
    return {
      ok: false,
      outcome: "authorization_not_current",
      message:
        "Client must re-sign the current card authorization for the card on file.",
    };
  }
  if (cardAuth.kind !== "signed_current") {
    return {
      ok: false,
      outcome: "authorization_not_current",
      message:
        "Card authorization is no longer current. Ask the client to re-sign the updated card authorization before charging this session.",
    };
  }
  if (cardAuth.signatureId !== attemptRow.card_authorization_signature_id) {
    return {
      ok: false,
      outcome: "authorization_not_current",
      message:
        "Card authorization signature has changed since the session payment was prepared. Prepare a new attempt against the current signature.",
    };
  }

  // 4. Lineage recheck. The card row + studio settings + customer
  //    mapping must all still resolve consistently with the values
  //    stamped on the attempt.
  if (
    !attemptRow.client_payment_method_id ||
    !attemptRow.card_authorization_signature_id ||
    !attemptRow.stripe_account_id ||
    !attemptRow.stripe_customer_id ||
    !attemptRow.stripe_payment_method_id
  ) {
    return {
      ok: false,
      outcome: "blocked",
      message: "Session payment attempt is missing required card lineage.",
    };
  }
  const lineage = await loadCardAndVerifyLineage({
    studioId: attemptRow.studio_id,
    clientId: attemptRow.client_id,
    clientPaymentMethodId: attemptRow.client_payment_method_id,
    expectedSignatureId: attemptRow.card_authorization_signature_id,
    expectedStripeAccountId: attemptRow.stripe_account_id,
    expectedStripeCustomerId: attemptRow.stripe_customer_id,
    expectedStripePaymentMethodId: attemptRow.stripe_payment_method_id,
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

  // 5. Atomically claim the attempt. Idempotency key is deterministic
  //    so a retry produces the same key.
  const idempotencyKey = buildIdempotencyKey(attemptRow.id, attemptRow.charge_reason ?? "session_payment");
  const { data: claimRows, error: claimErr } = await admin.rpc(
    "claim_session_payment_charge_attempt",
    {
      p_attempt_id: attemptRow.id,
      p_practitioner_id: args.practitionerId,
      p_idempotency_key: idempotencyKey,
    },
  );
  if (claimErr) {
    logInternal("session_payment_claim_rpc_failed", {
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
          ? "You don't have permission to charge this session payment."
          : "This session payment is not in a chargeable state.",
    };
  }

  // 6a. Pending reconciliation: row is already pending_stripe.
  if (claim.result === "already_pending") {
    if (claim.stripe_payment_intent_id) {
      return reconcileExistingPaymentIntent({
        attemptId: attemptRow.id,
        studioId: attemptRow.studio_id,
        clientId: attemptRow.client_id,
        sessionId: attemptRow.session_id,
        appointmentId: attemptRow.appointment_id,
        stripeAccountId: card.stripe_account_id,
        paymentIntentId: claim.stripe_payment_intent_id,
      });
    }
    // No PI id on the row. Check whether the claim is recent enough
    // to retry-create with the same idempotency key.
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
      await recordOpsAlert({
        severity: "critical",
        event: "session_payment_needs_manual_review",
        message:
          "Pending claim is older than the reconciliation window and has no PaymentIntent id.",
        studioId: attemptRow.studio_id,
        clientId: attemptRow.client_id,
        route: "lib/billing/session-payment-charge:runSessionPaymentCharge",
        safeDetails: {
          attempt_id: attemptRow.id,
          session_id: attemptRow.session_id,
          appointment_id: attemptRow.appointment_id,
          reason: "stale_pending_no_pi",
          age_minutes_floor: Math.floor(ageMin),
        },
      });
      return {
        ok: false,
        outcome: "needs_manual_review",
        message: NEEDS_MANUAL_REVIEW_MESSAGE,
      };
    }
  }

  // 6b. Create + confirm the PaymentIntent. Off-session because the
  //     practitioner is taking the action, not the cardholder. The
  //     metadata block carries every Hone identity column the future
  //     webhook handler or a manual reconciler needs to bind a
  //     leaked-back PaymentIntent to this attempt.
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
        description: `Session payment for session ${attemptRow.session_id}`,
        metadata: {
          hone_studio_id: attemptRow.studio_id,
          hone_client_id: attemptRow.client_id,
          hone_session_id: attemptRow.session_id,
          hone_appointment_id: attemptRow.appointment_id ?? "",
          hone_session_payment_charge_attempt_id: attemptRow.id,
          hone_charge_reason: attemptRow.charge_reason,
          hone_card_authorization_signature_id:
            attemptRow.card_authorization_signature_id,
          hone_environment: "test",
        },
      },
      {
        stripeAccount: card.stripe_account_id,
        idempotencyKey,
      },
    );
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
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
        failureCode: err.code ?? piStatus,
        failureMessage: err.message,
      });
      logInternal("session_payment_stripe_error", {
        attemptId: attemptRow.id,
        type: err.type,
        code: err.code,
      });
      await recordOpsAlert({
        severity:
          err.code === "authentication_required" ? "critical" : "warning",
        event: "session_payment_charge_failed",
        message: err.message || "Stripe error during PaymentIntent create.",
        studioId: attemptRow.studio_id,
        clientId: attemptRow.client_id,
        route: "lib/billing/session-payment-charge:runSessionPaymentCharge",
        safeDetails: {
          attempt_id: attemptRow.id,
          session_id: attemptRow.session_id,
          appointment_id: attemptRow.appointment_id,
          stripe_payment_intent_id: piId,
          failure_code: err.code ?? null,
          stripe_status: piStatus,
          stripe_error_type: err.type,
        },
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
    // manual reconciliation. Same logic as manual fee: a transient
    // network error after Stripe accepted the request could have
    // already moved money.
    logInternal("session_payment_stripe_unknown_error", {
      attemptId: attemptRow.id,
      message: err instanceof Error ? err.message : String(err),
    });
    await recordOpsAlert({
      severity: "critical",
      event: "session_payment_needs_manual_review",
      message:
        "Unknown error after claim; row stays pending_stripe. Reconcile via Stripe dashboard.",
      studioId: attemptRow.studio_id,
      clientId: attemptRow.client_id,
      route: "lib/billing/session-payment-charge:runSessionPaymentCharge",
      safeDetails: {
        attempt_id: attemptRow.id,
        session_id: attemptRow.session_id,
        appointment_id: attemptRow.appointment_id,
        reason: "unknown_error_after_claim",
      },
    });
    return {
      ok: false,
      outcome: "needs_manual_review",
      message: NEEDS_MANUAL_REVIEW_MESSAGE,
    };
  }

  // 7. Stripe accepted the create+confirm. The PI either succeeded
  //    or sits in requires_action / requires_payment_method.
  if (pi.status === "succeeded") {
    await writeSucceededOutcome({ attemptId: attemptRow.id, pi });
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

  // Off-session SCA hit or other non-success status.
  await writeFailedOutcome({
    attemptId: attemptRow.id,
    paymentIntentId: pi.id,
    stripeStatus: pi.status,
    failureCode: pi.last_payment_error?.code ?? pi.status,
    failureMessage:
      pi.last_payment_error?.message ??
      (pi.status === "requires_action"
        ? AUTHENTICATION_REQUIRED_MESSAGE
        : `PaymentIntent status: ${pi.status}`),
  });
  await recordOpsAlert({
    severity: pi.status === "requires_action" ? "critical" : "warning",
    event: "session_payment_charge_failed",
    message: `PaymentIntent status post-create: ${pi.status}`,
    studioId: attemptRow.studio_id,
    clientId: attemptRow.client_id,
    route: "lib/billing/session-payment-charge:runSessionPaymentCharge",
    safeDetails: {
      attempt_id: attemptRow.id,
      session_id: attemptRow.session_id,
      appointment_id: attemptRow.appointment_id,
      stripe_payment_intent_id: pi.id,
      stripe_status: pi.status,
      failure_code: pi.last_payment_error?.code ?? pi.status,
    },
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
