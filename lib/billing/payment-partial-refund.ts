import "server-only";
import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { getSessionPaymentStripe } from "@/lib/stripe/session-payment-stripe";
import { isDefinitiveStripeRefusal } from "@/lib/billing/stripe-error-outcome";

// Partial card refunds on a split visit (HON-122). request_payment_refund (0394) has already checked the owner, the amount and what is still
// refundable under the visit's lock and made the pending_stripe row; this sends that ONE row to Stripe and records Stripe's answer once.
const FAILURE_CODE_MAX = 100;
const MODE_MISMATCH_MESSAGE = "This payment's mode does not match the current deployment mode.";
const sanitizeFailureCode = (raw: string | null | undefined) => (raw ? raw.slice(0, FAILURE_CODE_MAX) : null);
function logInternal(event: string, detail: unknown) {
  try { console.error(JSON.stringify({ event, detail, timestamp: new Date().toISOString() })); } catch { console.error(event); }
}

/**
 * The Stripe refund call for a PARTIAL refund of one payment_refunds row (HON-122). The full refund of a whole attempt stays in payment-refund.ts; this
 * is the second, reviewed call site (scripts/check-stripe-gates). Its idempotency key is the refund row id, so a retry can never make a second refund.
 */
async function createStripeRefund(
  stripe: ReturnType<typeof getSessionPaymentStripe>,
  a: { chargeId: string; amountCents: number; accountId: string | null; idempotencyKey: string; metadata: Record<string, string> },
): Promise<Stripe.Refund> {
  return stripe.refunds.create(
    { charge: a.chargeId, amount: a.amountCents, metadata: a.metadata },
    { stripeAccount: a.accountId ?? undefined, idempotencyKey: a.idempotencyKey },
  );
}

/** One partial card refund: its own key, so each of several refunds on one charge is a distinct Stripe object. */
export function buildPartialRefundIdempotencyKey(refundRowId: string): string {
  return `hone:payment_refund:${refundRowId}`;
}

export type PartialCardRefundOutcome =
  | { outcome: "succeeded" | "failed" | "already_settled" | "unknown" | "blocked"; message: string };

/**
 * Sends ONE pending_stripe payment_refunds row (made by request_payment_refund, which already enforced owner, amount and balance under the
 * visit lock) to Stripe and records Stripe's answer with finish_payment_refund. Safe to call again for the same row: the Stripe key is the row id,
 * and finish_payment_refund records an outcome once. A connection or server error is "unknown": the row stays pending_stripe and nothing is
 * recorded as failed (a retry gets the same Stripe refund back). `feeReturnedCents` is decided by the caller from the charge's platform fee.
 */
export type PendingRefundRow = { id: string; studioId: string; attemptId: string; amountCents: number; status: string; source: string; requestedAt: string };

/** The refund Stripe already made for this row, found by the metadata the call always carries; null when there is none. Throws when Stripe cannot be asked. */
export async function findExistingStripeRefund(
  stripe: ReturnType<typeof getSessionPaymentStripe>,
  a: { chargeId: string; accountId: string | null; refundRowId: string },
): Promise<Stripe.Refund | null> {
  const list = await stripe.refunds.list({ charge: a.chargeId, limit: 100 }, { stripeAccount: a.accountId ?? undefined });
  return list.data.find((r) => r.metadata?.hone_payment_refund_id === a.refundRowId) ?? null;
}

export async function refundCardPaymentPartial(args: { row: PendingRefundRow; feeReturnedCents: number | null }): Promise<PartialCardRefundOutcome> {
  // The service role has no grant on payment_refunds (0393 gives the table to owners under RLS only), so the CALLER reads the row as the signed-in
  // owner and passes it in. Everything Stripe is told comes from that row and from the attempt, never from the browser.
  const admin = createAdminClient();
  const livemode = inferStripeLivemode();
  const row = args.row;
  if (row.source !== "hone") {
    logInternal("payment_partial_refund_blocked", { refundId: row.id, why: "not_hone_source" });
    return { outcome: "blocked", message: "This refund could not be found." };
  }
  if (row.status !== "pending_stripe") return { outcome: "already_settled", message: "This refund was already settled." };
  const { data: attempt } = await admin
    .from("payment_charge_attempts")
    .select("id, studio_id, client_id, status, stripe_charge_id, stripe_account_id, stripe_livemode, charge_reason")
    .eq("id", row.attemptId).eq("studio_id", row.studioId).maybeSingle();
  if (!attempt || attempt.status !== "succeeded" || !attempt.stripe_charge_id) {
    logInternal("payment_partial_refund_blocked", { refundId: row.id, why: "attempt_not_refundable", status: attempt?.status ?? null, hasChargeId: !!attempt?.stripe_charge_id });
    return { outcome: "blocked", message: "Only a succeeded card payment can be refunded." };
  }
  if (attempt.stripe_livemode !== livemode) {
    logInternal("payment_partial_refund_blocked", { refundId: row.id, why: "mode_mismatch" });
    return { outcome: "blocked", message: MODE_MISMATCH_MESSAGE };
  }

  const finish = async (outcome: "succeeded" | "failed", stripeRefundId: string | null, stripeStatus: string | null, code: string | null, fee: number | null) => {
    const { data, error: finErr } = await admin.rpc("finish_payment_refund", {
      p_refund_id: row.id, p_outcome: outcome, p_stripe_refund_id: stripeRefundId, p_stripe_refund_status: stripeStatus,
      p_failure_code: code, p_failure_message_safe: outcome === "failed" ? "Stripe refused this refund." : null, p_platform_fee_returned_cents: fee,
    });
    const r = (Array.isArray(data) ? data[0] : data) as { result?: string } | null;
    return { ok: !finErr && !!r, result: r?.result ?? null };
  };

  let refund: Stripe.Refund;
  try {
    // ALWAYS look for the refund this row already made before creating. Re-calling create with the same idempotency key replays Stripe's SAVED first
    // response (still "pending") for 24 hours, so a recheck through create could never see the refund settle. The list read returns the live object.
    // The key stays on the create below as the guard against a second refund when nothing is found (a first call, or a list that has not caught up).
    const existing = await findExistingStripeRefund(getSessionPaymentStripe(), {
      chargeId: attempt.stripe_charge_id as string, accountId: (attempt.stripe_account_id as string | null) ?? null, refundRowId: row.id,
    });
    refund = existing ?? await createStripeRefund(getSessionPaymentStripe(), {
      chargeId: attempt.stripe_charge_id as string,
      amountCents: row.amountCents,
      accountId: (attempt.stripe_account_id as string | null) ?? null,
      idempotencyKey: buildPartialRefundIdempotencyKey(row.id),
      metadata: {
        hone_payment_refund_id: row.id,
        hone_payment_charge_attempt_id: attempt.id as string,
        hone_studio_id: attempt.studio_id as string,
        hone_charge_reason: String(attempt.charge_reason),
        hone_environment: livemode ? "live" : "test",
      },
    });
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError && isDefinitiveStripeRefusal(err)) {
      const f = await finish("failed", null, null, sanitizeFailureCode(err.code ?? err.type), null);
      return f.ok ? { outcome: "failed", message: "Stripe refused this refund. Nothing was returned." } : { outcome: "unknown", message: "Checking refund status" };
    }
    // Connection or server error: Stripe may have refunded. Leave the row pending_stripe; checking again is safe.
    logInternal("payment_partial_refund_unknown_outcome", { refundId: row.id, errorName: err instanceof Error ? err.name : typeof err });
    return { outcome: "unknown", message: "Checking refund status" };
  }

  if (refund.status === "succeeded") {
    const f = await finish("succeeded", refund.id, refund.status, null, args.feeReturnedCents);
    return f.ok ? { outcome: f.result === "already_settled" ? "already_settled" : "succeeded", message: "Refund recorded." } : { outcome: "unknown", message: "Checking refund status" };
  }
  if (refund.status === "failed" || refund.status === "canceled") {
    const f = await finish("failed", refund.id, refund.status, sanitizeFailureCode(refund.failure_reason ?? refund.status), null);
    return f.ok ? { outcome: "failed", message: "Stripe could not complete this refund. Nothing was returned." } : { outcome: "unknown", message: "Checking refund status" };
  }
  // pending / requires_action: Stripe has it but has not finished. Not a recorded outcome yet.
  return { outcome: "unknown", message: "Checking refund status" };
}
