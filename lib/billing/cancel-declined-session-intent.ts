import "server-only";
import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { getSessionPaymentStripe } from "@/lib/stripe/session-payment-stripe";
import { recordOpsAlert } from "@/lib/ops/alerts";
import { cancelPaymentIntentConfirmed } from "@/lib/billing/session-payment-charge";
import { thrownErrorClass, stripeErrorFields } from "@/lib/logging/error-class";

// ---------------------------------------------------------------------------
// Close the ORIGINAL Stripe attempt once Hone has recorded a session payment as failed (the owner's decision).
// ---------------------------------------------------------------------------
//
// A card decline leaves the PaymentIntent on Stripe in requires_payment_method, which Stripe can still complete
// (a new method, an out-of-band confirm). Hone has already recorded the attempt failed and staff may prepare a
// replacement payment straight away, so the old intent must not stay live next to it.
//
// This runs ONLY after the attempt is already failed (the failed write is never repeated or undone here), and it does
// exactly one thing: cancel THE intent stored on THIS attempt, through the single cancel site
// (cancelPaymentIntentConfirmed), and record stripe_status='canceled' only from Stripe's own confirmed answer.
// It never reads, writes or cancels any other attempt, so a replacement payment is untouched by construction.
//
// VERIFY FIRST, every time: the row is this studio's failed, uncharged session_payment in this mode; the event's intent
// id is the one stored on the row; Stripe's intent has that id, the row's amount, currency and mode, carries this
// attempt's id in its metadata, has nothing received, and is STILL requires_payment_method. Anything else cancels nothing.
//
// RETRY: a failed cancel is the only thing retried. The caller turns `retry` into a webhook failure so Stripe redelivers
// the same event; the redelivery finds the attempt already failed and runs only this cleanup again. It stops after
// CLEANUP_RETRY_WINDOW_MS from the event's creation with a critical alert, so it is bounded.
export const CLEANUP_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type DeclinedSessionCleanupResult =
  | { outcome: "canceled" | "already_canceled" | "not_applicable" }
  | { outcome: "refused"; reason: string }
  | { outcome: "retry"; reason: string }
  | { outcome: "gave_up"; reason: string };

// The attempt id the intent carries: either key Hone writes, at least one present, and EVERY present one equal to this attempt.
const ATTEMPT_ID_KEYS = ["hone_payment_charge_attempt_id", "hone_session_payment_charge_attempt_id"] as const;
function metadataNamesOnly(metadata: Stripe.Metadata | null | undefined, attemptId: string): boolean {
  const present = ATTEMPT_ID_KEYS.map((k) => (metadata?.[k] ?? "").trim()).filter((v) => v.length > 0);
  return present.length > 0 && present.every((v) => v === attemptId);
}

const ROUTE = "lib/billing/cancel-declined-session-intent:cancelDeclinedSessionIntent";

function logInternal(event: string, detail: unknown) {
  try {
    console.error(JSON.stringify({ event, detail, timestamp: new Date().toISOString() }));
  } catch {
    // logging must never throw into the money path
  }
}

export async function cancelDeclinedSessionIntent(args: {
  attemptId: string;
  studioId: string;
  eventPaymentIntentId: string;
  /** Stripe event.created, in seconds: bounds how long a failing cleanup keeps being retried. */
  eventCreatedSeconds: number;
  now?: () => number;
}): Promise<DeclinedSessionCleanupResult> {
  const admin = createAdminClient();
  const livemode = inferStripeLivemode();
  const now = args.now ?? Date.now;

  const { data: row, error } = await admin
    .from("payment_charge_attempts")
    .select(
      "id, studio_id, client_id, charge_reason, status, amount_cents, currency, stripe_livemode, stripe_account_id, stripe_payment_intent_id, stripe_status, charged_at, stripe_charge_id",
    )
    .eq("id", args.attemptId)
    .eq("studio_id", args.studioId)
    .maybeSingle();

  const base = {
    studioId: args.studioId,
    clientId: (row?.client_id as string | null | undefined) ?? undefined,
    stripePaymentIntentId: args.eventPaymentIntentId,
    route: ROUTE,
  };
  const refuse = async (reason: string): Promise<DeclinedSessionCleanupResult> => {
    await recordOpsAlert({
      ...base,
      severity: "critical",
      event: "session_payment_decline_cleanup_refused",
      message:
        "Hone did not cancel the original PaymentIntent of a failed session payment because it could not prove the intent is this attempt's and still awaiting a payment method.",
      safeDetails: { attempt_id: args.attemptId, reason },
    });
    return { outcome: "refused", reason };
  };
  // EVERY retry path is bounded the same way: past the window it stops with one critical alert instead of retrying on.
  const failed = async (reason: string, cause?: unknown): Promise<DeclinedSessionCleanupResult> => {
    if (cause !== undefined) {
      logInternal("session_payment_decline_cleanup_failed", {
        attemptId: args.attemptId,
        paymentIntentId: args.eventPaymentIntentId,
        reason,
        errorClass: thrownErrorClass(cause),
        ...stripeErrorFields(cause),
      });
    }
    const ageMs = now() - args.eventCreatedSeconds * 1000;
    if (ageMs > CLEANUP_RETRY_WINDOW_MS) {
      await recordOpsAlert({
        ...base,
        severity: "critical",
        event: "session_payment_decline_cleanup_gave_up",
        message:
          "Hone could not cancel the original PaymentIntent of a failed session payment within the retry window. It may still be completable on Stripe and needs a manual cancel.",
        safeDetails: { attempt_id: args.attemptId, reason },
      });
      return { outcome: "gave_up", reason };
    }
    await recordOpsAlert({
      ...base,
      severity: "warning",
      event: "session_payment_decline_cleanup_retrying",
      message: "Hone could not yet cancel the original PaymentIntent of a failed session payment; only the cancel is retried.",
      safeDetails: { attempt_id: args.attemptId, reason },
    });
    return { outcome: "retry", reason };
  };
  if (error) return failed("attempt_read_failed", error);
  if (!row) return { outcome: "not_applicable" };

  const piId = row.stripe_payment_intent_id as string | null;

  // Not a failed, uncharged session payment of this mode and intent: nothing to clean up here.
  if (
    row.charge_reason !== "session_payment" ||
    row.status !== "failed" ||
    row.stripe_livemode !== livemode ||
    row.charged_at ||
    row.stripe_charge_id ||
    !piId ||
    piId !== args.eventPaymentIntentId ||
    !row.stripe_account_id
  ) {
    return { outcome: "not_applicable" };
  }
  if (row.stripe_status === "canceled") return { outcome: "already_canceled" };

  const stripe = getSessionPaymentStripe();
  const account = row.stripe_account_id as string;
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.retrieve(piId, undefined, { stripeAccount: account });
  } catch (err) {
    return failed("retrieve_failed", err);
  }

  const sameIntent =
    pi.id === piId &&
    pi.amount === row.amount_cents &&
    String(pi.currency ?? "").toLowerCase() === String(row.currency ?? "").toLowerCase() &&
    pi.livemode === livemode &&
    metadataNamesOnly(pi.metadata, row.id as string);
  if (!sameIntent) return refuse("identity_mismatch");
  if (typeof pi.amount_received !== "number" || pi.amount_received !== 0) return refuse("amount_received");

  let confirmed: Stripe.PaymentIntent;
  if (pi.status === "canceled") {
    confirmed = pi;
  } else if (pi.status === "requires_payment_method") {
    try {
      confirmed = await cancelPaymentIntentConfirmed(stripe, pi, account);
    } catch (err) {
      return failed("cancel_not_confirmed", err);
    }
  } else {
    // Succeeded, processing, requires_action, requires_capture, ...: money may be moving. Never cancel.
    return refuse("not_awaiting_method");
  }
  if (confirmed.status !== "canceled" || confirmed.amount_received !== 0) {
    return refuse("cancel_unconfirmed");
  }

  // Record the confirmed cancel on THIS row only. The failed status is not touched.
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
    // The intent IS canceled; only the stored fact is missing. A redelivery re-confirms and writes it.
    return failed("persist_failed");
  }
  await recordOpsAlert({
    ...base,
    severity: "info",
    event: "session_payment_declined_intent_canceled",
    message: "Stripe confirmed the original PaymentIntent of a failed session payment canceled with nothing captured.",
    safeDetails: { attempt_id: row.id, stripe_payment_intent_id: piId },
  });
  return { outcome: "canceled" };
}
