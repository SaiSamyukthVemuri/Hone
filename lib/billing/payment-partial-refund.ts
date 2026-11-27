import "server-only";
import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { getSessionPaymentStripe } from "@/lib/stripe/session-payment-stripe";

// Partial card refunds on a split visit (HON-122). request_payment_refund (0394) has already checked the owner, the amount and what is still
// refundable under the visit's lock and made the pending_stripe row; this sends that ONE row to Stripe and records Stripe's answer once.
const FAILURE_CODE_MAX = 100;
const MODE_MISMATCH_MESSAGE = "This payment's mode does not match the current deployment mode.";
// Privacy: finish_payment_refund stores what we pass. The message is ALWAYS the fixed sentence below (never a Stripe message), and the code is kept only when it has the
// shape of a Stripe code (lowercase letters, digits, underscore); anything else (a sentence, an id, an address) is stored as "unknown".
const FAILURE_MESSAGE_SAFE = "Stripe refused this refund.";
const sanitizeFailureCode = (raw: string | null | undefined) => (raw ? (/^[a-z0-9_]{1,100}$/.test(raw) ? raw.slice(0, FAILURE_CODE_MAX) : "unknown") : null);
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
 * REFUND STATE MACHINE (r2/r4). A row is pending_stripe until Stripe's answer is recorded once with finish_payment_refund (succeeded | failed).
 *   - a row with a STORED Stripe id is settled by RETRIEVING that refund (never created again);
 *   - a row with no stored id, recent (inside Stripe's 24h idempotency window): create with the row id as key (a replay returns the first refund), then
 *     record_refund_sent stores the id;
 *   - the same row older than the window: ask Stripe for the refund this row already made (list by metadata) BEFORE any create;
 *   - a terminal `failed` is recorded ONLY for an explicit allowlist of Stripe error codes that prove no refund exists. Everything else (409, 429, 5xx,
 *     any other 4xx, a connection error, a failed lookup) leaves the row pending (unknown) and a retry is safe.
 * The lookup and the create each have their own error handling: a failed lookup is never read as "nothing found".
 */
export type PendingRefundRow = { id: string; studioId: string; attemptId: string; amountCents: number; status: string; source: string; requestedAt: string; stripeRefundId: string | null };

/** 24h idempotency window, less a margin. */
export const IDEMPOTENCY_SAFE_MS = 23 * 3600 * 1000;

/**
 * Stripe error codes (https://docs.stripe.com/error-codes, read 27 Nov 2026; the page shows no last-updated date) that say Stripe REFUSED the refund
 * because the charge's own state forbids it, so no refund exists for this call: charge_already_refunded, amount_too_large, charge_disputed,
 * refund_disputed_payment. A type (card, invalid request, rate limit...) is NOT enough: only the code. Rate limits and idempotency errors are excluded
 * on purpose (they prove nothing about an earlier call).
 */
export const DEFINITIVE_REFUND_REFUSAL_CODES: ReadonlySet<string> = new Set(["charge_already_refunded", "amount_too_large", "charge_disputed", "refund_disputed_payment"]);
export function isDefinitiveRefundRefusal(err: unknown): boolean {
  return err instanceof Stripe.errors.StripeError && typeof err.code === "string" && DEFINITIVE_REFUND_REFUSAL_CODES.has(err.code);
}

const chargeIdOf = (c: string | Stripe.Charge | null | undefined) => (typeof c === "string" ? c : c?.id ?? null);

/** The refund Stripe already made for this row, found by the metadata the call always carries; null when there is none. Throws when Stripe cannot be asked. */
export async function findExistingStripeRefund(
  stripe: ReturnType<typeof getSessionPaymentStripe>,
  a: { chargeId: string; accountId: string | null; refundRowId: string },
): Promise<Stripe.Refund | null> {
  const list = await stripe.refunds.list({ charge: a.chargeId, limit: 100 }, { stripeAccount: a.accountId ?? undefined });
  // A list that does not show everything cannot prove "nothing found".
  if (list.has_more) throw new Error("refund list incomplete");
  return list.data.find((r) => r.metadata?.hone_payment_refund_id === a.refundRowId) ?? null;
}

export async function refundCardPaymentPartial(args: { row: PendingRefundRow; feeReturnedCents: number | null }): Promise<PartialCardRefundOutcome> {
  // The service role has no grant on payment_refunds (0393 gives the table to owners under RLS only), so the CALLER reads the row as the signed-in
  // owner and passes it in. Everything Stripe is told comes from that row and from the attempt, never from the browser.
  const admin = createAdminClient();
  const livemode = inferStripeLivemode();
  const row = args.row;
  const UNKNOWN: PartialCardRefundOutcome = { outcome: "unknown", message: "Checking refund status" };
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
  const chargeId = attempt.stripe_charge_id as string;
  const accountId = (attempt.stripe_account_id as string | null) ?? null;

  const finish = async (outcome: "succeeded" | "failed", stripeRefundId: string | null, stripeStatus: string | null, code: string | null, fee: number | null) => {
    const { data, error: finErr } = await admin.rpc("finish_payment_refund", {
      p_refund_id: row.id, p_outcome: outcome, p_stripe_refund_id: stripeRefundId, p_stripe_refund_status: stripeStatus,
      p_failure_code: code, p_failure_message_safe: outcome === "failed" ? FAILURE_MESSAGE_SAFE : null, p_platform_fee_returned_cents: fee,
    });
    const r = (Array.isArray(data) ? data[0] : data) as { result?: string } | null;
    return { ok: !finErr && !!r, result: r?.result ?? null };
  };
  const lookup = async (): Promise<{ ok: true; refund: Stripe.Refund | null } | { ok: false }> => {
    try {
      return { ok: true, refund: await findExistingStripeRefund(getSessionPaymentStripe(), { chargeId, accountId, refundRowId: row.id }) };
    } catch (err) {
      logInternal("payment_partial_refund_lookup_failed", { refundId: row.id, errorName: err instanceof Error ? err.name : typeof err });
      return { ok: false };
    }
  };
  const settle = async (refund: Stripe.Refund): Promise<PartialCardRefundOutcome> => {
    if (refund.status === "succeeded") {
      const f = await finish("succeeded", refund.id, refund.status, null, args.feeReturnedCents);
      return f.ok ? { outcome: f.result === "already_settled" ? "already_settled" : "succeeded", message: "Refund recorded." } : UNKNOWN;
    }
    if (refund.status === "failed" || refund.status === "canceled") {
      const f = await finish("failed", refund.id, refund.status, sanitizeFailureCode(refund.failure_reason ?? refund.status), null);
      return f.ok ? { outcome: "failed", message: "Stripe could not complete this refund. Nothing was returned." } : UNKNOWN;
    }
    // pending / requires_action: Stripe has it but has not finished. Not a recorded outcome yet.
    return UNKNOWN;
  };

  // 1. A stored Stripe id: retrieve that refund, never create again.
  if (row.stripeRefundId) {
    let refund: Stripe.Refund;
    try {
      refund = await getSessionPaymentStripe().refunds.retrieve(row.stripeRefundId, undefined, { stripeAccount: accountId ?? undefined });
    } catch (err) {
      logInternal("payment_partial_refund_retrieve_failed", { refundId: row.id, errorName: err instanceof Error ? err.name : typeof err });
      return UNKNOWN;
    }
    if (refund.id !== row.stripeRefundId || chargeIdOf(refund.charge) !== chargeId) {
      logInternal("payment_partial_refund_blocked", { refundId: row.id, why: "stored_refund_mismatch" });
      return UNKNOWN;
    }
    return settle(refund);
  }

  // 2. No stored id and the idempotency window may have closed: ask Stripe for the refund this row already made BEFORE any create.
  const ageMs = Date.now() - Date.parse(row.requestedAt);
  if (!Number.isFinite(ageMs) || ageMs >= IDEMPOTENCY_SAFE_MS) {
    const found = await lookup();
    if (!found.ok) return UNKNOWN;
    if (found.refund) return settle(found.refund);
  }

  // 3. Create (the key is the row id: a replay inside the window returns the first refund).
  let refund: Stripe.Refund;
  try {
    refund = await createStripeRefund(getSessionPaymentStripe(), {
      chargeId, amountCents: row.amountCents, accountId, idempotencyKey: buildPartialRefundIdempotencyKey(row.id),
      metadata: {
        hone_payment_refund_id: row.id,
        hone_payment_charge_attempt_id: attempt.id as string,
        hone_studio_id: attempt.studio_id as string,
        hone_charge_reason: String(attempt.charge_reason),
        hone_environment: livemode ? "live" : "test",
      },
    });
  } catch (err) {
    if (isDefinitiveRefundRefusal(err)) {
      // One lookup before a terminal fail: a refusal like charge_already_refunded can mean THIS row's refund already exists.
      const found = await lookup();
      if (!found.ok) return UNKNOWN;
      if (found.refund) return settle(found.refund);
      const code = err instanceof Stripe.errors.StripeError ? err.code : null;
      const f = await finish("failed", null, null, sanitizeFailureCode(code), null);
      return f.ok ? { outcome: "failed", message: "Stripe refused this refund. Nothing was returned." } : UNKNOWN;
    }
    // Connection error, 409, 429, 5xx or any other error: Stripe may have refunded. The row stays pending_stripe; checking again is safe.
    logInternal("payment_partial_refund_unknown_outcome", { refundId: row.id, errorName: err instanceof Error ? err.name : typeof err });
    return UNKNOWN;
  }
  // Store Stripe's id now (before the outcome is known) so a retry retrieves it. Best effort: finish_payment_refund stores it too.
  const sent = await admin.rpc("record_refund_sent", { p_refund_id: row.id, p_stripe_refund_id: refund.id });
  if (sent.error) logInternal("payment_partial_refund_record_sent_failed", { refundId: row.id });
  return settle(refund);
}
