import type { SettlementMethod } from "@/lib/billing/settlement-types";

// ===========================================================================
// Outstanding balance of ONE finished appointment, from real payment rows.
// ===========================================================================
//
// PURE. Reads nothing, writes nothing. It invents no new money law: the quote
// is the one `resolveAuthoritativeSessionPaymentAmount` already resolves, card
// money is Hone-verified `payment_charge_attempts`, and collections are the
// practitioner-attested `appointment_settlements`. Card money and settlements
// are kept apart in the schema and are summed only here, once.
//
//   outstanding = quote - card money kept - collected settlements   (floor 0)
//
// What it never does: assume a missing quote is 0, assume a missing currency,
// treat an unreadable refund as a full refund, or count `waived` / `still_owes`
// as money. A dismissal in the dashboard never reaches this function.

export type OutstandingCard = {
  status: string | null;
  amountCents: number | null;
  refundStatus: string | null;
  refundAmountCents: number | null;
  /** The provider's own refund state (payment_charge_attempts.stripe_refund_status), when recorded. */
  providerRefundStatus?: string | null;
  currency: string | null;
};

export type OutstandingSettlement = {
  method: SettlementMethod;
  amountCents: number;
  /** Mirrors the studio currency today; when present and different, the amount is not summed. */
  currency?: string | null;
};

export type OutstandingInput = {
  /** Appointment status; only a completed visit can be outstanding. */
  status: string | null;
  /** ISO end time and "now" (passed in: this function reads no clock). */
  endsAt: string;
  now: string;
  /** Authoritative quote in cents; null when it could not be resolved. */
  quoteCents: number | null;
  /** Currency of the studio's payment jurisdiction; null when unknown. */
  studioCurrency: string | null;
  cards: ReadonlyArray<OutstandingCard>;
  /** LIVE settlements only (superseded rows already removed by the caller). */
  settlements: ReadonlyArray<OutstandingSettlement>;
  /**
   * Money forms Hone records for this appointment that this function does NOT subtract (a fee charge, a booking-time charge, an
   * appointment-level refund, a dispute, a charge on a deleted session, a price recorded on the session). The caller names each
   * one it found; any one makes the amount unavailable, because the owner would otherwise be shown a figure that may be too high.
   */
  unprovenMoney?: ReadonlyArray<string>;
};

export type Outstanding =
  | { kind: "not_applicable" }
  | { kind: "paid" }
  | { kind: "amount_unavailable" }
  | {
      kind: "owed";
      outstandingCents: number;
      /** Always proven (charge row, else studio jurisdiction); otherwise the result is amount_unavailable. */
      currency: string;
      quoteCents: number;
      cardKeptCents: number;
      collectedCents: number;
    };

const COLLECTED: ReadonlySet<SettlementMethod> = new Set([
  "paid_cash",
  "paid_e_transfer",
  "paid_other_external",
]);

/**
 * Money from one succeeded charge that was NOT returned, or null when that cannot be proven. A refund we cannot read is NOT "no
 * refund": a succeeded refund with no readable amount, or one still pending / needing action at the provider, makes the figure
 * unprovable (the visit could read as fully paid, or as owing more, on a guess).
 */
function cardKept(c: OutstandingCard): number | null {
  if (c.status === "pending_stripe") return null; // money may or may not have moved
  if (c.status !== "succeeded") return 0;
  if (typeof c.amountCents !== "number") return null;
  const provider = c.providerRefundStatus ?? null;
  if (provider === "pending" || provider === "requires_action") return null;
  if (c.refundStatus === "pending_stripe") return null;
  if (c.refundStatus !== "succeeded") return Math.max(0, c.amountCents); // none, or a refund that failed: the money stayed
  if (typeof c.refundAmountCents !== "number" || c.refundAmountCents < 0) return null;
  return Math.max(0, c.amountCents - c.refundAmountCents);
}

export function outstandingForAppointment(input: OutstandingInput): Outstanding {
  if (input.status !== "completed") return { kind: "not_applicable" };
  const ends = Date.parse(input.endsAt);
  const now = Date.parse(input.now);
  if (!Number.isFinite(ends) || !Number.isFinite(now) || ends > now) {
    return { kind: "not_applicable" };
  }
  // A waived visit is owner-attested as owing nothing.
  if (input.settlements.some((s) => s.method === "waived")) return { kind: "paid" };
  if (typeof input.quoteCents !== "number" || input.quoteCents < 0) {
    return { kind: "amount_unavailable" };
  }
  if (input.quoteCents === 0) return { kind: "not_applicable" };

  if ((input.unprovenMoney ?? []).length > 0) return { kind: "amount_unavailable" };

  let cardKeptCents = 0;
  for (const c of input.cards) {
    const kept = cardKept(c);
    if (kept === null) return { kind: "amount_unavailable" };
    cardKeptCents += kept;
  }
  const collected = input.settlements.filter((s) => COLLECTED.has(s.method));
  const collectedCents = collected.reduce((n, s) => n + Math.max(0, s.amountCents), 0);

  // One currency or none. Card money in two currencies, or in a currency other than the studio's, is never summed.
  const studio = input.studioCurrency ? input.studioCurrency.toLowerCase() : null;
  const seen = new Set<string>();
  for (const c of input.cards) {
    if (c.status !== "succeeded") continue;
    if (!c.currency) return { kind: "amount_unavailable" };
    seen.add(c.currency.toLowerCase());
  }
  for (const s of collected) if (s.currency) seen.add(s.currency.toLowerCase());
  if (seen.size > 1) return { kind: "amount_unavailable" };
  const only = [...seen][0] ?? null;
  if (only && studio && only !== studio) return { kind: "amount_unavailable" };

  const outstandingCents = Math.max(0, input.quoteCents - cardKeptCents - collectedCents);
  if (outstandingCents === 0) return { kind: "paid" };

  const currency = only ?? studio;
  if (!currency) return { kind: "amount_unavailable" };

  return {
    kind: "owed",
    outstandingCents,
    currency: currency.toUpperCase(),
    quoteCents: input.quoteCents,
    cardKeptCents,
    collectedCents,
  };
}

/**
 * A source that failed to read is "unavailable", never an empty list and never
 * "paid": absence of evidence is not a balance.
 */
export type OutstandingLoad =
  | { ok: true; input: OutstandingInput }
  | { ok: false };

export function outstandingFromLoad(load: OutstandingLoad): Outstanding | { kind: "unavailable" } {
  return load.ok ? outstandingForAppointment(load.input) : { kind: "unavailable" };
}
