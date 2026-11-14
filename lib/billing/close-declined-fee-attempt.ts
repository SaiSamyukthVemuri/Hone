import "server-only";
import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { getSessionPaymentStripe } from "@/lib/stripe/session-payment-stripe";
import { recordOpsAlert } from "@/lib/ops/alerts";
import { cancelPaymentIntentConfirmed } from "@/lib/billing/session-payment-charge";
import { thrownErrorClass, stripeErrorFields } from "@/lib/logging/error-class";

function logInternal(event: string, detail: unknown) {
  try {
    console.error(JSON.stringify({ event, detail, timestamp: new Date().toISOString() }));
  } catch {
    // logging must never throw into the money path
  }
}

// ---------------------------------------------------------------------------
// closeDeclinedFeeAttempt (E1, Sam 13 Nov): the owner-only "Close declined attempt" action.
// ---------------------------------------------------------------------------
//
// A FAILED manual-fee attempt blocks its appointment unless the stored provider facts prove nothing
// can collect (feeAttemptState). When the PaymentIntent still exists on Stripe in a state that could
// in principle be completed (requires_payment_method / requires_confirmation / requires_action), the
// owner can ask us to cancel THAT SAME PaymentIntent. This never creates a PaymentIntent: it retrieves
// the one stored on the attempt, verifies it is really this attempt's (id, amount, currency, mode,
// metadata attempt id), cancels it through cancelPaymentIntentConfirmed (the single cancel call site),
// and records stripe_status='canceled' ONLY from Stripe's own confirmed response. Anything unknown,
// uncertain or in a money-bearing state (processing, requires_capture, succeeded) writes nothing and
// the appointment stays blocked ("status unclear").
export const CLOSE_DECLINED_UNCLEAR_MESSAGE =
  "Charge status is unclear. Do not charge again until this is checked.";
export const CLOSE_DECLINED_NOT_ELIGIBLE_MESSAGE =
  "This attempt cannot be closed from here.";

export type CloseDeclinedFeeResult =
  | { ok: true; outcome: "closed" | "already_closed"; appointmentId: string | null }
  | { ok: false; outcome: "not_found" | "not_eligible" | "unclear"; message: string };

const CLOSEABLE_PI_STATUSES = new Set(["requires_payment_method", "requires_confirmation", "requires_action"]);

export async function closeDeclinedFeeAttempt(args: {
  attemptId: string;
  studioId: string;
}): Promise<CloseDeclinedFeeResult> {
  const admin = createAdminClient();
  const livemode = inferStripeLivemode();
  const { data: row, error } = await admin
    .from("payment_charge_attempts")
    .select(
      "id, studio_id, client_id, appointment_id, charge_reason, status, amount_cents, currency, stripe_livemode, stripe_account_id, stripe_payment_intent_id, stripe_status, stripe_charge_id, charged_at",
    )
    .eq("id", args.attemptId)
    .eq("studio_id", args.studioId)
    .maybeSingle();
  if (error || !row) return { ok: false, outcome: "not_found", message: CLOSE_DECLINED_NOT_ELIGIBLE_MESSAGE };

  const piId = row.stripe_payment_intent_id as string | null;
  const unclear = async (reason: string, severity: "warning" | "critical", extra: Record<string, unknown> = {}) => {
    await recordOpsAlert({
      severity,
      event: "payment_charge_close_declined_unclear",
      message: "Close declined attempt could not prove the PaymentIntent is canceled and uncaptured; the appointment stays blocked.",
      studioId: row.studio_id as string,
      clientId: (row.client_id as string | null) ?? undefined,
      stripePaymentIntentId: piId ?? undefined,
      route: "lib/billing/close-declined-fee-attempt:closeDeclinedFeeAttempt",
      safeDetails: { attempt_id: row.id, reason, ...extra },
    });
    return { ok: false as const, outcome: "unclear" as const, message: CLOSE_DECLINED_UNCLEAR_MESSAGE };
  };

  const reason = row.charge_reason as string;
  if (reason !== "no_show_fee" && reason !== "late_cancellation_fee") {
    return { ok: false, outcome: "not_eligible", message: CLOSE_DECLINED_NOT_ELIGIBLE_MESSAGE };
  }
  if (row.status !== "failed" || row.stripe_livemode !== livemode || row.charged_at || row.stripe_charge_id) {
    return { ok: false, outcome: "not_eligible", message: CLOSE_DECLINED_NOT_ELIGIBLE_MESSAGE };
  }
  if (!piId || !row.stripe_account_id) return unclear("no_stored_payment_intent", "warning");
  if (row.stripe_status === "canceled") return { ok: true, outcome: "already_closed", appointmentId: (row.appointment_id as string | null) ?? null };

  const stripe = getSessionPaymentStripe();
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.retrieve(piId, undefined, { stripeAccount: row.stripe_account_id as string });
  } catch {
    return unclear("retrieve_failed", "warning", { stripe_payment_intent_id: piId });
  }
  const currency = String(row.currency ?? "").toLowerCase();
  const sameIntent =
    pi.id === piId &&
    pi.amount === row.amount_cents &&
    String(pi.currency ?? "").toLowerCase() === currency &&
    pi.livemode === livemode &&
    pi.metadata?.hone_session_payment_charge_attempt_id === row.id;
  if (!sameIntent) return unclear("payment_intent_identity_mismatch", "critical", { stripe_payment_intent_id: piId });
  // Money-bearing or in-flight states, or anything captured: never cancel, never free.
  if (typeof pi.amount_received !== "number" || pi.amount_received !== 0) {
    return unclear("amount_received_not_zero", "critical", { stripe_payment_intent_id: piId, stripe_status: pi.status });
  }

  let confirmed: Stripe.PaymentIntent;
  if (pi.status === "canceled") {
    confirmed = pi;
  } else if (CLOSEABLE_PI_STATUSES.has(pi.status)) {
    try {
      confirmed = await cancelPaymentIntentConfirmed(stripe, pi, row.stripe_account_id as string);
    } catch (cancelErr) {
      logInternal("manual_fee_close_declined_cancel_failed", {
        attemptId: row.id as string,
        paymentIntentId: piId,
        errorClass: thrownErrorClass(cancelErr),
        ...stripeErrorFields(cancelErr),
      });
      return unclear("cancel_not_confirmed", "critical", { stripe_payment_intent_id: piId, stripe_status: pi.status });
    }
  } else {
    return unclear("payment_intent_state_not_closeable", "critical", { stripe_payment_intent_id: piId, stripe_status: pi.status });
  }
  if (confirmed.status !== "canceled" || confirmed.amount_received !== 0) {
    return unclear("cancel_response_not_canceled_uncaptured", "critical", { stripe_payment_intent_id: piId });
  }

  const { data: updated, error: writeError } = await admin
    .from("payment_charge_attempts")
    .update({ stripe_status: "canceled" })
    .eq("id", row.id as string)
    .eq("studio_id", row.studio_id as string)
    .eq("stripe_livemode", livemode)
    .eq("status", "failed")
    .eq("stripe_payment_intent_id", piId)
    .is("charged_at", null)
    .is("stripe_charge_id", null)
    .select("id");
  if (writeError || !updated || updated.length !== 1) {
    return unclear("persist_failed", "critical", { stripe_payment_intent_id: piId });
  }
  await recordOpsAlert({
    severity: "info",
    event: "payment_charge_declined_attempt_closed",
    message: "Owner closed a declined manual-fee attempt; Stripe confirmed the PaymentIntent canceled with nothing captured.",
    studioId: row.studio_id as string,
    clientId: (row.client_id as string | null) ?? undefined,
    stripePaymentIntentId: piId,
    route: "lib/billing/close-declined-fee-attempt:closeDeclinedFeeAttempt",
    safeDetails: { attempt_id: row.id, appointment_id: row.appointment_id ?? null, stripe_payment_intent_id: piId },
  });
  return { ok: true, outcome: "closed", appointmentId: (row.appointment_id as string | null) ?? null };
}
