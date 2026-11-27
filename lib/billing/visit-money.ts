import type { VisitLedger } from "@/lib/billing/visit-payments-core";

// ===========================================================================
// ONE definition of "Collected / Refunded / Net" for a visit (HON-123 / HON-122, Sam's acceptance).
// ===========================================================================
// Collected  = money actually received: confirmed cash/transfers and SUCCEEDED card payments. A transfer still waiting for confirmation and a card still with Stripe are not collected.
// Refunded   = SUCCEEDED refunds only (a payment returned, or a price reduction with money returned). The same rule as the database's payment_refund_money / visit_payment_position:
//              the ledger's refund rows already carry the greater-of the itemised rows and the attempt's own cumulative refund columns, never the sum.
// Net        = Collected - Refunded: what the studio kept.
// A refund still pending at Stripe is NOT counted as kept or as refunded: it is shown on its own ("Refund pending"), and Net says it is not final. An open review (a refund made in
// the Stripe dashboard that is waiting for the owner) makes Net not final too.
// Checkout, the visit page and the statement all take their labels, order and wording from `moneyRows`, so they cannot word it differently.

export const MONEY_LABELS = { collected: "Collected", refunded: "Refunded", net: "Net" } as const;
export const REFUND_PENDING_LABEL = "Refund pending";
export const BALANCE_DUE_LABEL = "Balance due"; // ONE word for "what is still owed" on checkout, the visit page, the statement and the print page
export const REFUND_STATUS_LABELS = { partial: "Partially refunded", full: "Fully refunded" } as const;
export const NET_NOT_FINAL_PENDING = "Not counted in Refunded or Net until Stripe confirms it.";
export const NET_NOT_FINAL_REVIEW = "A refund made in your Stripe dashboard is waiting for you to confirm it, so Net may change.";
export const NET_NOT_FINAL_PAYMENT = "A payment or refund is still being confirmed, so Net may change.";

export type VisitMoneySummary = {
  collectedCents: number;
  refundedCents: number;
  netCents: number;
  /** Refunds still with Stripe: not in refundedCents, not subtracted from netCents. */
  refundPendingCents: number;
  /** Transfers recorded but not yet confirmed: not collected. */
  waitingCents: number;
  /** Card payments still with Stripe: not collected. */
  cardPendingCents: number;
  /** A refund observed in the Stripe dashboard waits for the owner. */
  reviewOpen: boolean;
  /** False while anything above is still pending: Net is then the figure so far, and the screen says so. */
  final: boolean;
};

/** The summary of one visit's split-payments ledger (checkout and the visit page). */
export function visitMoneySummary(ledger: VisitLedger): VisitMoneySummary {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const collectedCents = sum(ledger.externals.filter((e) => e.state === "confirmed").map((e) => e.amountCents))
    + sum(ledger.cards.filter((c) => c.status === "succeeded").map((c) => c.amountCents));
  const refundedCents = sum(ledger.refunds.filter((r) => r.status === "succeeded").map((r) => r.amountCents));
  // An open review is a refund Stripe reports that Hone has not recorded: the money may already be gone, so it is pending too, never kept and never yet refunded.
  const refundPendingCents = sum(ledger.refunds.filter((r) => r.status === "pending_stripe").map((r) => r.amountCents))
    + sum((ledger.reviews ?? []).map((rv) => rv.amountCents));
  const waitingCents = sum(ledger.externals.filter((e) => e.state === "pending_confirmation").map((e) => e.amountCents));
  const cardPendingCents = sum(ledger.cards.filter((c) => c.status === "pending_stripe").map((c) => c.amountCents));
  const reviewOpen = ledger.reviewOpen === true || (ledger.reviews ?? []).length > 0;
  return {
    collectedCents, refundedCents, netCents: collectedCents - refundedCents,
    refundPendingCents, waitingCents, cardPendingCents, reviewOpen,
    final: refundPendingCents === 0 && cardPendingCents === 0 && !reviewOpen,
  };
}

/**
 * The same figures from a client statement's totals, so the arithmetic and wording are identical. `paidCents` mixes two models: a payment partly refunded in the split ledger
 * stays in it in full, a legacy fully refunded card payment is taken out. Collected is what was received either way (paid + refunded - the part-refunds still inside paid).
 */
export function statementMoneySummary(totals: { paidCents: number; refundedCents: number }, partialRefundedCents: number, awaitingVisits: number, refundPendingCents = 0): VisitMoneySummary {
  const collectedCents = totals.paidCents + totals.refundedCents - partialRefundedCents;
  const refundedCents = totals.refundedCents;
  return {
    collectedCents, refundedCents, netCents: collectedCents - refundedCents,
    refundPendingCents, waitingCents: 0, cardPendingCents: 0, reviewOpen: false,
    final: awaitingVisits === 0 && refundPendingCents === 0,
  };
}

export type MoneyRow = { key: "collected" | "refunded" | "net" | "refund_pending" | "waiting"; label: string; cents: number; note: string | null };

/** Collected, Refunded, Net, then (only when they apply) Refund pending and Waiting. */
export function moneyRows(m: VisitMoneySummary, opts: { statement?: boolean } = {}): { rows: MoneyRow[]; notFinalNote: string | null } {
  const rows: MoneyRow[] = [
    { key: "collected", label: MONEY_LABELS.collected, cents: m.collectedCents, note: null },
    { key: "refunded", label: MONEY_LABELS.refunded, cents: m.refundedCents, note: null },
    { key: "net", label: MONEY_LABELS.net, cents: m.netCents, note: null },
  ];
  if (m.refundPendingCents > 0) rows.push({ key: "refund_pending", label: REFUND_PENDING_LABEL, cents: m.refundPendingCents, note: NET_NOT_FINAL_PENDING });
  if (m.waitingCents > 0 && !opts.statement) rows.push({ key: "waiting", label: "Waiting for confirmation", cents: m.waitingCents, note: null });
  const notFinalNote = m.final ? null : m.reviewOpen ? NET_NOT_FINAL_REVIEW : m.refundPendingCents > 0 ? NET_NOT_FINAL_PENDING : NET_NOT_FINAL_PAYMENT;
  return { rows, notFinalNote };
}

/** "Partially refunded" or "Fully refunded" once money has been returned (succeeded refunds only); null when nothing has been returned. Never a reason to reopen a balance. */
export function refundStatusLabel(m: Pick<VisitMoneySummary, "collectedCents" | "refundedCents">): string | null {
  if (m.refundedCents <= 0) return null;
  return m.collectedCents > 0 && m.refundedCents >= m.collectedCents ? REFUND_STATUS_LABELS.full : REFUND_STATUS_LABELS.partial;
}
