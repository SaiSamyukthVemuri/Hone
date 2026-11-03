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
  currency: string | null;
};

export type OutstandingSettlement = {
  method: SettlementMethod;
  amountCents: number;
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

/** Money from one succeeded charge that was NOT returned. Unreadable refund = nothing assumed returned beyond what is stated. */
function cardKept(c: OutstandingCard): number {
  if (c.status !== "succeeded" || typeof c.amountCents !== "number") return 0;
  if (c.refundStatus !== "succeeded") return Math.max(0, c.amountCents);
  if (typeof c.refundAmountCents !== "number") return Math.max(0, c.amountCents);
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

  const cardKeptCents = input.cards.reduce((n, c) => n + cardKept(c), 0);
  const collectedCents = input.settlements.reduce(
    (n, s) => (COLLECTED.has(s.method) ? n + Math.max(0, s.amountCents) : n),
    0,
  );
  const outstandingCents = Math.max(0, input.quoteCents - cardKeptCents - collectedCents);
  if (outstandingCents === 0) return { kind: "paid" };

  const cardCurrency = input.cards.find((c) => c.status === "succeeded" && c.currency)?.currency;
  const currency = cardCurrency ?? input.studioCurrency;
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
