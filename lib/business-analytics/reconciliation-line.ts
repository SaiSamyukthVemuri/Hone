import type { CollectedSplit } from "./money-metrics";

// ===========================================================================
// Business → Analytics: THE LINE BETWEEN SERVICE VALUE AND COLLECTED. PURE.
// ===========================================================================
//
// An exact identity by construction. There is no "other" line that absorbs a remainder:
//
//   service value (visits with price evidence)
//   + collected above price     (per visit, kept minus price where kept is larger)
//   - collected below price     (per visit, price minus kept where kept is smaller: unpaid, part-paid, adjusted down, waived)
//   + collected on completed visits with no price evidence
//   + fees                      (the document's fee items for cancelled and no-show bookings)
//   + payments on past bookings never completed
//   + money on other bookings   (including a booking later today)
//   = Collected
//
// Refunded-in-full money, unresolved rows and other-currency rows are NOT in Collected and are not in this line; the screen lists them beside it.

export type CompletedVisitMoney = {
  appointmentId: string;
  /** The visit's resolved price in cents, or null when it has no price evidence. */
  priceCents: number | null;
  /** Money kept on this visit (the statement's collected kinds). */
  collectedCents: number;
  /** How many separate collected rows make up `collectedCents` (a card payment plus an e-transfer is 2). */
  collectedRows: number;
};

export type ReconciliationLine = {
  serviceValueCents: number;
  collectedAbovePriceCents: number;
  collectedBelowPriceCents: number;
  collectedOnNoEvidenceCents: number;
  feesCents: number;
  uncompletedPaymentsCents: number;
  otherBookingsCents: number;
  collectedCents: number;
  /** Annotation, NOT a line: visits above price that carry two or more collected rows. The statement does not de-duplicate across sources and neither does this. */
  possibleDoubleRecording: { visits: number; aboveCents: number };
};

export type LineFailure = "unreadable_amount" | "completed_money_differs_from_split" | "identity_failed";
export type LineResult = { ok: true; line: ReconciliationLine } | { ok: false; reason: LineFailure };

const isCents = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * Build the line. The completed visits' money must add up to the split's completed-visit line, and the seven lines must add up to the split's total:
 * either mismatch is REFUSED, never shown. A repeated appointment id counts once.
 */
export function serviceValueToCollected(visits: readonly CompletedVisitMoney[], split: CollectedSplit): LineResult {
  const seen = new Set<string>();
  let service = 0;
  let above = 0;
  let below = 0;
  let noEvidence = 0;
  let keptOnCompleted = 0;
  let doubleVisits = 0;
  let doubleAbove = 0;
  for (const v of visits) {
    if (seen.has(v.appointmentId)) continue;
    seen.add(v.appointmentId);
    if (!isCents(v.collectedCents) || !Number.isSafeInteger(v.collectedRows) || v.collectedRows < 0 || (v.priceCents !== null && !isCents(v.priceCents))) {
      return { ok: false, reason: "unreadable_amount" };
    }
    keptOnCompleted += v.collectedCents;
    if (v.priceCents === null) {
      noEvidence += v.collectedCents;
      continue;
    }
    service += v.priceCents;
    if (v.collectedCents > v.priceCents) {
      const diff = v.collectedCents - v.priceCents;
      above += diff;
      if (v.collectedRows >= 2) {
        doubleVisits += 1;
        doubleAbove += diff;
      }
    } else below += v.priceCents - v.collectedCents;
  }
  if (keptOnCompleted !== split.completedVisitsCents) return { ok: false, reason: "completed_money_differs_from_split" };
  const total = service + above - below + noEvidence + split.feesCents + split.uncompletedPaymentsCents + split.otherBookingsCents;
  if (total !== split.totalCents) return { ok: false, reason: "identity_failed" };
  return {
    ok: true,
    line: {
      serviceValueCents: service,
      collectedAbovePriceCents: above,
      collectedBelowPriceCents: below,
      collectedOnNoEvidenceCents: noEvidence,
      feesCents: split.feesCents,
      uncompletedPaymentsCents: split.uncompletedPaymentsCents,
      otherBookingsCents: split.otherBookingsCents,
      collectedCents: total,
      possibleDoubleRecording: { visits: doubleVisits, aboveCents: doubleAbove },
    },
  };
}
