// ===========================================================================
// Split payments and partial refunds — the PURE half (HON-123 / HON-122).
// ===========================================================================
// No I/O. The database (0393/0394) decides every money question under its own lock; nothing here is an authority. This module
//   * turns what a person typed into cents, strictly (no rounding, no guessing),
//   * turns the database's refusal codes into plain sentences with a next step,
//   * derives the itemised history and the balance the screens print (the same arithmetic as visit_payment_position, so a
//     screen and the database agree, and a test pins that they do),
//   * names the states of a card payment whose outcome is not yet known, so the screen can never offer a second charge
//     while the first one is unresolved.

import { formatMoney } from "@/lib/billing/payment-jurisdiction";

export type VisitCurrency = "cad" | "usd";
export type ExternalMethod = "paid_cash" | "paid_e_transfer" | "paid_other_external";

/** Dollars as typed ("75", "75.5", "75.50") to whole cents. null for anything else: no sign, no thousands separator, no 3rd decimal. */
export function parseDollarsToCents(raw: unknown, maxCents = 200_000): number | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
  return cents >= 1 && cents <= maxCents ? cents : null;
}

// ---------------------------------------------------------------------------
// The ledger as the screens read it
// ---------------------------------------------------------------------------
export type LedgerBill = { id: string; totalCents: number; currency: VisitCurrency; referenceFeeCents: number | null; feeAdjustmentReason: string | null; createdAt: string };
export type LedgerCard = {
  kind: "card"; id: string; amountCents: number; status: "ready" | "pending_stripe" | "succeeded" | "failed" | string; at: string;
  /** Hone's fee on this charge (0392), owner/admin breakdown only. null = none. */
  platformFeeCents: number | null;
};
export type LedgerExternal = {
  kind: "external"; id: string; method: ExternalMethod; amountCents: number; state: "confirmed" | "pending_confirmation" | "voided"; at: string; note: string | null;
};
export type LedgerRefund = {
  id: string; amountCents: number; kind: "price_reduction" | "payment_reversal"; status: "pending_stripe" | "succeeded" | "failed";
  attemptId: string | null; externalPaymentId: string | null; reason: string; at: string; platformFeeReturnedCents: number | null;
};
export type VisitLedger = { bill: LedgerBill | null; cards: LedgerCard[]; externals: LedgerExternal[]; refunds: LedgerRefund[] };

export type VisitBalance = {
  totalCents: number; confirmedCents: number; pendingCents: number; cardCents: number; refundedCents: number;
  /** Still collectable: what a new tender may take. Pending transfers are NOT in it (they are reserved). */
  collectableCents: number;
  /** Still owed in the sense of "not yet received": collectable plus the pending transfers. */
  owedCents: number;
};

/** Mirrors the database's visit_payment_position (0394). The database is the authority; a test keeps this honest. */
export function visitBalance(l: VisitLedger): VisitBalance | null {
  if (!l.bill) return null;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const confirmedCents = sum(l.externals.filter((e) => e.state === "confirmed").map((e) => e.amountCents));
  const pendingCents = sum(l.externals.filter((e) => e.state === "pending_confirmation").map((e) => e.amountCents));
  const cardCents = sum(l.cards.filter((c) => ["ready", "pending_stripe", "succeeded"].includes(c.status)).map((c) => c.amountCents));
  const refundedCents = sum(l.refunds.filter((r) => r.status !== "failed").map((r) => r.amountCents));
  const collectableCents = Math.max(0, l.bill.totalCents - confirmedCents - pendingCents - cardCents + refundedCents);
  return { totalCents: l.bill.totalCents, confirmedCents, pendingCents, cardCents, refundedCents, collectableCents, owedCents: collectableCents + pendingCents };
}

export type HistoryLine = {
  key: string;
  label: string;
  amountCents: number;
  /** "in" adds to what was received, "out" is money handed back. */
  direction: "in" | "out";
  status: "received" | "pending" | "voided" | "failed" | "in_progress";
  at: string;
};

const METHOD_LABEL: Record<ExternalMethod, string> = { paid_cash: "Cash", paid_e_transfer: "E-transfer", paid_other_external: "Transfer or other" };
export const methodLabel = (m: ExternalMethod) => METHOD_LABEL[m];

/** The itemised payment history, oldest first, voided and failed lines kept visible (financial history is never hidden). */
export function historyLines(l: VisitLedger): HistoryLine[] {
  const lines: HistoryLine[] = [];
  for (const c of l.cards) {
    if (c.status === "ready") continue; // a prepared charge that was never run is not a payment
    lines.push({
      key: `card:${c.id}`, label: "Card", amountCents: c.amountCents, direction: "in", at: c.at,
      status: c.status === "succeeded" ? "received" : c.status === "pending_stripe" ? "in_progress" : "failed",
    });
  }
  for (const e of l.externals) {
    lines.push({
      key: `ext:${e.id}`, label: methodLabel(e.method), amountCents: e.amountCents, direction: "in", at: e.at,
      status: e.state === "confirmed" ? "received" : e.state === "pending_confirmation" ? "pending" : "voided",
    });
  }
  for (const r of l.refunds) {
    const what = r.kind === "price_reduction" ? "Price reduced, money returned" : "Payment returned";
    const from = r.attemptId ? "card" : "cash or transfer";
    lines.push({
      key: `refund:${r.id}`, label: `${what} (${from})`, amountCents: r.amountCents, direction: "out", at: r.at,
      status: r.status === "succeeded" ? "received" : r.status === "pending_stripe" ? "in_progress" : "failed",
    });
  }
  return lines.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
}

export const STATUS_LABEL: Record<HistoryLine["status"], string> = {
  received: "Received", pending: "Waiting for confirmation", voided: "Voided", failed: "Failed", in_progress: "Checking payment status",
};

// ---------------------------------------------------------------------------
// The database's refusals, in plain words
// ---------------------------------------------------------------------------
export type CommandNote = { tone: "ok" | "info" | "blocked"; message: string };

const MONEY = (c: number, cur: VisitCurrency | null) => formatMoney(c, cur);

/** result codes of the 0394 commands (and the card wall's PY001/PY002) to a sentence that says what happened and what to do. */
export function commandNote(code: string, ctx: { collectableCents?: number; currency?: VisitCurrency | null } = {}): CommandNote {
  const left = typeof ctx.collectableCents === "number" ? ` ${MONEY(ctx.collectableCents, ctx.currency ?? null)} is still collectable.` : "";
  switch (code) {
    case "created": case "exists": return { tone: "ok", message: "The bill for this visit is ready." };
    case "recorded": return { tone: "ok", message: "Payment recorded." };
    case "already_recorded": return { tone: "info", message: "That payment was already recorded, so nothing was added." };
    case "confirmed": return { tone: "ok", message: "Transfer confirmed. It now counts as received." };
    case "already_confirmed": return { tone: "info", message: "That transfer was already confirmed." };
    case "voided": return { tone: "ok", message: "Transfer cancelled. Its amount can be collected again." };
    case "already_voided": return { tone: "info", message: "That transfer was already cancelled." };
    case "requested": return { tone: "ok", message: "Refund recorded." };
    case "already_requested": return { tone: "info", message: "That refund was already recorded, so nothing was added." };
    case "reserved_for_pending_transfer": case "PY001":
      return { tone: "blocked", message: "This amount is reserved for a pending transfer. Confirm the transfer when the money arrives, or cancel it to collect this amount another way." };
    case "exceeds_balance": case "PY002":
      return { tone: "blocked", message: `That is more than is still collectable on this visit.${left}` };
    case "refund_failed": return { tone: "blocked", message: "Stripe could not complete this refund. Nothing was returned." };
    case "exceeds_refundable": return { tone: "blocked", message: "That is more than is left to refund on this payment. Choose a smaller amount." };
    case "exceeds_bill": return { tone: "blocked", message: "A price reduction cannot be more than the bill." };
    case "confirmed_is_final": return { tone: "blocked", message: "A confirmed payment cannot be cancelled. If the money went back to the client, record a refund." };
    case "payment_not_refundable": return { tone: "blocked", message: "That payment has not been received, so it cannot be refunded." };
    case "method_unavailable": return { tone: "blocked", message: "E-transfer is not used for a US studio. Record it as a transfer or other payment." };
    case "not_completed": return { tone: "blocked", message: "Finish the visit before taking payment." };
    case "already_settled": return { tone: "blocked", message: "This visit already has a recorded outcome (paid another way or waived), so it cannot be split. The studio owner can correct that record first." };
    case "card_payment_exists": return { tone: "blocked", message: "This visit already has a card payment, so it cannot be split." };
    case "price_missing": return { tone: "blocked", message: "Check the fee for this visit first: it has no price." };
    case "no_bill": return { tone: "blocked", message: "This visit has no bill yet. Reload the page and try again." };
    case "split_payments_off": return { tone: "blocked", message: "Split payments are not switched on for this studio." };
    case "not_owner": return { tone: "blocked", message: "Only the studio owner can do that." };
    case "not_found": return { tone: "blocked", message: "That was not found in this studio. Reload the page." };
    case "submission_reused": return { tone: "blocked", message: "That form was already used for a different amount. Reload the page and enter it again." };
    case "invalid_input": return { tone: "blocked", message: "Check the amount and the details, then try again." };
    default: return { tone: "blocked", message: "That did not go through and nothing was changed. Reload the page and check before trying again." };
  }
}

// ---------------------------------------------------------------------------
// A card payment whose outcome is not known
// ---------------------------------------------------------------------------
// "Checking payment status" is shown EXACTLY while the answer is unknown, and while it is shown there is NO charge control: a second
// click could create a second charge. The same attempt id carries the same idempotency key to Stripe, so checking again is safe.
export const CHECKING_PAYMENT_STATUS = "Checking payment status";

export type CardPhase =
  | { phase: "idle" }
  | { phase: "preparing" }
  | { phase: "charging"; attemptId: string }
  | { phase: "unknown"; attemptId: string }          // the response never arrived, or Stripe has not said yet
  | { phase: "succeeded"; attemptId: string }
  | { phase: "failed"; attemptId: string | null; message: string };

export type CardEvent =
  | { type: "submit" }
  | { type: "prepared"; attemptId: string }
  | { type: "prepare_refused"; message: string }
  | { type: "result"; outcome: "succeeded" | "failed" | "unknown"; message?: string }
  | { type: "lost_response" }
  | { type: "status"; outcome: "succeeded" | "failed" | "unknown"; message?: string };

export function cardReduce(s: CardPhase, e: CardEvent): CardPhase {
  switch (e.type) {
    case "submit": return s.phase === "idle" || s.phase === "failed" ? { phase: "preparing" } : s;   // never from unknown or charging
    case "prepared": return s.phase === "preparing" ? { phase: "charging", attemptId: e.attemptId } : s;
    case "prepare_refused": return s.phase === "preparing" ? { phase: "failed", attemptId: null, message: e.message } : s;
    case "lost_response": return s.phase === "charging" ? { phase: "unknown", attemptId: s.attemptId } : s;
    case "result": case "status": {
      if (s.phase !== "charging" && s.phase !== "unknown") return s;
      if (e.outcome === "succeeded") return { phase: "succeeded", attemptId: s.attemptId };
      if (e.outcome === "failed") return { phase: "failed", attemptId: s.attemptId, message: e.message ?? "The card was not charged." };
      return { phase: "unknown", attemptId: s.attemptId };
    }
  }
}

/** The one rule the screen follows: a new charge may be started only from idle or after a definite failure. */
export const canStartCharge = (s: CardPhase) => s.phase === "idle" || s.phase === "failed";
export const showCheckingStatus = (s: CardPhase) => s.phase === "unknown";


/** What the dashboard's outstanding view needs of a BILLED visit (HON-123): the live bill, its cash/transfer rows and its refunds. */
export type BilledVisitRows = {
  totalCents: number;
  currency: string;
  externals: ReadonlyArray<{ amountCents: number; state: string }>;
  refunds: ReadonlyArray<{ amountCents: number; status: string }>;
};

export type BilledOutstanding =
  | { kind: "paid" }
  | { kind: "amount_unavailable" }
  | { kind: "owed"; outstandingCents: number; currency: string; quoteCents: number; cardKeptCents: number; collectedCents: number };

/**
 * Owed on a billed visit = bill total − confirmed cash/transfers − card money received + money handed back. An unconfirmed transfer is NOT
 * received, so it stays owed (it is only reserved). A card payment still in flight, a refund still pending, or an unknown currency makes the
 * figure unprovable: "Amount unavailable", never a guess. Pure.
 */
export function billedOutstanding(
  bill: BilledVisitRows,
  cards: ReadonlyArray<{ status: string | null; amountCents: number | null; currency: string | null }>,
): BilledOutstanding {
  const cur = bill.currency.toLowerCase();
  if (cur !== "cad" && cur !== "usd") return { kind: "amount_unavailable" };
  let cardKept = 0;
  for (const c of cards) {
    if (c.status === "pending_stripe") return { kind: "amount_unavailable" };
    if (c.status !== "succeeded") continue;
    if (typeof c.amountCents !== "number" || (c.currency !== null && c.currency.toLowerCase() !== cur)) return { kind: "amount_unavailable" };
    cardKept += c.amountCents;
  }
  if (bill.refunds.some((r) => r.status === "pending_stripe")) return { kind: "amount_unavailable" };
  const collected = bill.externals.filter((e) => e.state === "confirmed").reduce((n, e) => n + e.amountCents, 0);
  const handedBack = bill.refunds.filter((r) => r.status === "succeeded").reduce((n, r) => n + r.amountCents, 0);
  const owed = bill.totalCents - collected - cardKept + handedBack;
  if (owed <= 0) return { kind: "paid" };
  return { kind: "owed", outstandingCents: owed, currency: cur, quoteCents: bill.totalCents, cardKeptCents: cardKept, collectedCents: collected };
}


/**
 * The share of a charge's platform fee returned with one partial card refund (US pilot fee, HON-90): proportional to the amount refunded, rounded
 * down, and the LAST refund returns exactly what is left so the fee returned never exceeds the fee taken and a full refund returns all of it.
 * A charge with no fee (null or 0) returns none (null). $100 charge, $0.50 fee, $40 refund = $0.20.
 */
export function proportionalFeeReturn(args: { feeCents: number | null; chargeCents: number; refundCents: number; alreadyRefundedCents: number; alreadyReturnedCents: number }): number | null {
  const { feeCents, chargeCents, refundCents, alreadyRefundedCents, alreadyReturnedCents } = args;
  if (feeCents === null || feeCents <= 0 || chargeCents <= 0 || refundCents <= 0) return null;
  const left = Math.max(0, feeCents - alreadyReturnedCents);
  if (alreadyRefundedCents + refundCents >= chargeCents) return left;
  return Math.min(left, Math.floor((feeCents * refundCents) / chargeCents));
}
