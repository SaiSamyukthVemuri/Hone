import "server-only";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe/server";
import { assertFakeStripeNotRequestedInDeployment, isE2eFakeStripeEnabled } from "@/lib/stripe/e2e-fake-guard";
import { createFakeStripe } from "@/lib/stripe/e2e-fake-stripe";

// HON-49: the ONE place Hone reads a charge's refunds from the payment provider.
//
// Why it exists: since API version 2022-11-15 a Charge no longer carries its refund list by default, and expand never applies to a webhook
// payload, so a signed charge.refunded usually arrives WITHOUT the list. The webhook then reads the list itself, here.
//
// Trust: the charge id and the connected account passed in come from the signed event (the caller's rule; this module never looks at a stored
// attempt). The call is authenticated with Hone's own key, scoped to that connected account, and read-only (list). Nothing here writes.
//
// Outcomes: a complete list; or a refusal the caller turns into a critical alert (incomplete after the page cap, an unknown charge, a revoked
// account); or a THROW for anything that may heal on its own (network, rate limit, provider error, timeout), so the webhook answers 5xx and the
// provider redelivers. A partial list is never returned as if it were complete.

/** Refunds per page (the provider's maximum). */
export const REFUND_LIST_PAGE_SIZE = 100;
/** Pages read before the list is declared incomplete. 5 x 100 refunds is far beyond a real charge; the command accepts at most 100 anyway. */
export const REFUND_LIST_MAX_PAGES = 5;
/** Milliseconds one provider request may take before it is abandoned (and the delivery retried). */
export const REFUND_LIST_REQUEST_TIMEOUT_MS = 8000;

export type ChargeRefundListRead =
  | { ok: true; refunds: Stripe.Refund[] }
  | { ok: false; reason: "incomplete" | "provider_refused" };

type StripeLikeError = { type?: string; code?: string; statusCode?: number };

/** Errors that mean "this charge or account is not readable by us", not "try again". Everything else retries. */
function isDefinitiveRefusal(err: unknown): boolean {
  const e = err as StripeLikeError | null;
  if (!e || typeof e !== "object") return false;
  return e.type === "StripePermissionError" || (e.type === "StripeInvalidRequestError" && (e.code === "resource_missing" || e.statusCode === 404));
}

export async function readCompleteChargeRefundList(args: { chargeId: string; stripeAccount: string }): Promise<ChargeRefundListRead> {
  const { chargeId, stripeAccount } = args;
  if (typeof chargeId !== "string" || !chargeId.trim() || typeof stripeAccount !== "string" || !stripeAccount.trim()) {
    return { ok: false, reason: "provider_refused" };
  }
  // The payment browser E2E lane serves this read from its fake processor (read-only, seeded by the runner); everywhere else, and in every
  // deployed runtime, it is the real client (the guard is false there).
  // Fail loud if the fake flag is set in a deployed runtime (the same pair the charge seam uses), then pick the fake only through the guard.
  assertFakeStripeNotRequestedInDeployment();
  const stripe = isE2eFakeStripeEnabled() ? createFakeStripe() : getStripe();
  const refunds: Stripe.Refund[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < REFUND_LIST_MAX_PAGES; page += 1) {
    let result: Stripe.ApiList<Stripe.Refund>;
    try {
      result = await stripe.refunds.list(
        { charge: chargeId, limit: REFUND_LIST_PAGE_SIZE, ...(startingAfter ? { starting_after: startingAfter } : {}) },
        { stripeAccount, timeout: REFUND_LIST_REQUEST_TIMEOUT_MS },
      );
    } catch (err) {
      if (isDefinitiveRefusal(err)) return { ok: false, reason: "provider_refused" };
      throw err; // retryable: the webhook answers 5xx and the event is redelivered
    }
    if (!result || !Array.isArray(result.data)) return { ok: false, reason: "incomplete" };
    refunds.push(...result.data);
    if (result.has_more !== true) return { ok: true, refunds };
    const last = result.data[result.data.length - 1];
    if (!last || typeof last.id !== "string") return { ok: false, reason: "incomplete" };
    startingAfter = last.id;
  }
  return { ok: false, reason: "incomplete" };
}

type IdOrObject = string | { id?: string | null } | null | undefined;
const idOf = (v: IdOrObject): string | null => (typeof v === "string" ? v : v && typeof v === "object" && typeof v.id === "string" ? v.id : null);

/**
 * The read list must describe THIS signed charge: every refund names its charge id and payment intent and carries its currency, all equal to the
 * signed charge's; no refund id repeats; and the list is not BEHIND the signed total (the refunds that succeeded or are still in flight must
 * account for at least the money the charge says went back). A list AHEAD of the signed total is newer truth (a refund made after the event was
 * signed) and is accepted. The database command enforces the same rules; this is the early refusal.
 */
export function refundListDescribesCharge(charge: Stripe.Charge, refunds: Stripe.Refund[]): boolean {
  if (refunds.length === 0 || refunds.length > 100) return false;
  const seen = new Set<string>();
  let succeeded = 0;
  let inflight = 0;
  for (const refund of refunds) {
    if (!refund || typeof refund.id !== "string" || !refund.id || seen.has(refund.id)) return false;
    seen.add(refund.id);
    if (idOf(refund.charge as IdOrObject) !== charge.id) return false;
    if (idOf(refund.payment_intent as IdOrObject) !== idOf(charge.payment_intent as IdOrObject)) return false;
    if (refund.currency !== charge.currency) return false;
    if (!Number.isSafeInteger(refund.amount) || refund.amount <= 0) return false;
    if (refund.status === "succeeded") succeeded += refund.amount;
    else if (refund.status === "pending" || refund.status === "requires_action") inflight += refund.amount;
  }
  return Number.isSafeInteger(charge.amount_refunded) && charge.amount_refunded <= succeeded + inflight;
}

/** The charge exactly as the provider sent it, with the read list set as its refund list. */
export function chargeWithRefundList(charge: Stripe.Charge, refunds: Stripe.Refund[]): Stripe.Charge {
  return { ...charge, refunds: { object: "list", data: refunds, has_more: false, url: `/v1/charges/${charge.id}/refunds` } } as Stripe.Charge;
}

/**
 * True when the signed payload itself carries refunds and does not say the list is cut short (no read is needed then: the event's own list is used
 * exactly as before). A list that is absent, null, empty or marked has_more triggers the authenticated read.
 */
export function payloadHasCompleteRefundList(charge: Stripe.Charge): boolean {
  const list = charge.refunds;
  return !!list && Array.isArray(list.data) && list.data.length > 0 && list.has_more !== true;
}
