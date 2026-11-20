// ===========================================================================
// Business → Analytics: COMPLETED SERVICE VALUE. PURE. No I/O.
// ===========================================================================
//
// Rule: each completed visit's service value is the price RECORDED for that visit, classified by what the evidence actually proves. There is no single
// priority list and no total that hides gaps: the result is one subtotal per evidence class plus a COUNT of completed visits with no price evidence.
//
//  * A card payment or a fee is money, not a price. It is not an evidence class here and can never be passed in as a candidate.
//  * Today's price list is never an input. A visit with no recorded evidence is counted as missing, not valued.
//  * A discount that was never recorded cannot be shown; nothing here invents one.
//
// The set of evidence classes is a closed union. Adding one is a reviewed change that comes with its own rule for what it proves.

export type PriceEvidenceClass = "recorded_at_visit" | "online_booking";
export const PRICE_EVIDENCE_CLASSES: readonly PriceEvidenceClass[] = ["recorded_at_visit", "online_booking"];

/** One stored price for a visit, with the class of evidence it is. A missing or non-integer amount is not a price. */
export type PriceCandidate = { evidence: PriceEvidenceClass; cents: number | null };

export type MissingReason = "no_evidence" | "ambiguous" | "unreadable";
export type VisitPrice =
  | { state: "evidence"; evidence: PriceEvidenceClass; cents: number }
  | { state: "missing"; reason: MissingReason };

const isCents = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Resolve ONE visit. Classes are tried in `precedence` order (default: the stronger proof first, the price recorded with the visit). A visit counts in
 * exactly one class, and a lower class's amount is never added to a higher one. Two different amounts inside one class are ambiguous: missing
 * evidence, never a guess. Zero is a real, recorded price (a free visit).
 */
export function resolveVisitPrice(
  candidates: readonly PriceCandidate[],
  precedence: readonly PriceEvidenceClass[] = PRICE_EVIDENCE_CLASSES,
): VisitPrice {
  let sawUnreadable = false;
  for (const cls of precedence) {
    const ofClass = candidates.filter((c) => c.evidence === cls);
    if (ofClass.some((c) => !isCents(c.cents))) sawUnreadable = true;
    const amounts = [...new Set(ofClass.filter((c) => isCents(c.cents)).map((c) => c.cents as number))];
    if (amounts.length === 1) return { state: "evidence", evidence: cls, cents: amounts[0] };
    if (amounts.length > 1) return { state: "missing", reason: "ambiguous" };
  }
  return { state: "missing", reason: sawUnreadable ? "unreadable" : "no_evidence" };
}

export type ServiceValueVisit = { appointmentId: string; candidates: readonly PriceCandidate[] };

export type ClassSubtotal = { visits: number; cents: number };
export type ServiceValue = {
  /** One subtotal per evidence class. A class with no visits is present with 0 visits and 0 cents (that is a known zero: no visit had it). */
  subtotals: Record<PriceEvidenceClass, ClassSubtotal>;
  /** Visits that have price evidence, and the sum of their subtotals. Always shown with `missingVisits` beside it. */
  withEvidenceVisits: number;
  withEvidenceCents: number;
  /** Completed visits with no price evidence, by reason. These are counted and left out of every subtotal. */
  missingVisits: number;
  missingByReason: Record<MissingReason, number>;
  completedVisits: number;
};

/** Per-visit resolution, kept so the reconciliation line can use the same prices. */
export function resolveVisits(visits: readonly ServiceValueVisit[], precedence?: readonly PriceEvidenceClass[]): Map<string, VisitPrice> {
  const out = new Map<string, VisitPrice>();
  for (const v of visits) if (!out.has(v.appointmentId)) out.set(v.appointmentId, resolveVisitPrice(v.candidates, precedence));
  return out;
}

/** Completed service value as subtotals per evidence class, plus the count of visits with no evidence. A repeated appointment id counts once. */
export function serviceValue(visits: readonly ServiceValueVisit[], precedence?: readonly PriceEvidenceClass[]): ServiceValue {
  const resolved = resolveVisits(visits, precedence);
  const subtotals = Object.fromEntries(PRICE_EVIDENCE_CLASSES.map((c) => [c, { visits: 0, cents: 0 }])) as Record<PriceEvidenceClass, ClassSubtotal>;
  const missingByReason: Record<MissingReason, number> = { no_evidence: 0, ambiguous: 0, unreadable: 0 };
  let missing = 0;
  for (const p of resolved.values()) {
    if (p.state === "evidence") {
      subtotals[p.evidence].visits += 1;
      subtotals[p.evidence].cents += p.cents;
    } else {
      missing += 1;
      missingByReason[p.reason] += 1;
    }
  }
  const withEvidenceVisits = PRICE_EVIDENCE_CLASSES.reduce((n, c) => n + subtotals[c].visits, 0);
  const withEvidenceCents = PRICE_EVIDENCE_CLASSES.reduce((n, c) => n + subtotals[c].cents, 0);
  return { subtotals, withEvidenceVisits, withEvidenceCents, missingVisits: missing, missingByReason, completedVisits: resolved.size };
}
