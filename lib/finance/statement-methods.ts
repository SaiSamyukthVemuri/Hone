import type { StatementDocument } from "@/lib/finance/statement-document";
import type { StatementBucket, StatementKind } from "@/lib/finance/statement";
import { STATEMENT_METHOD_LABELS } from "@/lib/finance/statement-copy";

// ===========================================================================
// "How it was paid": the collected lines of a statement grouped by method, for the summary card. PURE; it reads the document and nothing else.
// ===========================================================================
// It adds NO new rule. It only regroups the money lines the document already carries, under the labels the screen already uses. It is shown ONLY
// when the groups add up to the document's own total paid, to the cent; if they do not (or there is nothing collected) it returns null and the card
// shows no breakdown, so a method figure can never disagree with the total beside it.

const COLLECTED: readonly StatementKind[] = ["collected_card_session", "collected_card_fee", "collected_cash", "collected_e_transfer", "collected_other_external"];

export type MethodShare = { kind: StatementKind; label: string; cents: number };

export function methodBreakdown(doc: Pick<StatementDocument, "visits" | "feeItems" | "totals">): MethodShare[] | null {
  const byKind = new Map<StatementKind, number>();
  for (const row of [...doc.visits, ...doc.feeItems]) {
    for (const l of row.lines) {
      if (!COLLECTED.includes(l.kind) || l.cents === null) continue;
      byKind.set(l.kind, (byKind.get(l.kind) ?? 0) + l.cents);
    }
  }
  const shares = COLLECTED.filter((k) => (byKind.get(k) ?? 0) > 0).map((k) => ({ kind: k, label: STATEMENT_METHOD_LABELS[k as keyof typeof STATEMENT_METHOD_LABELS], cents: byKind.get(k) as number }));
  const sum = shares.reduce((n, s) => n + s.cents, 0);
  return shares.length > 0 && sum === doc.totals.paidCents ? shares : null;
}

// The same regrouping for the STUDIO statement's bucket (the "All practitioners" totals). Shown only when the groups add up to the bucket's own
// collected total, to the cent; otherwise null and the card shows no breakdown. It reads the bucket and nothing else.
export function bucketMethodBreakdown(bucket: Pick<StatementBucket, "kinds" | "collectedCents">): MethodShare[] | null {
  const shares = COLLECTED.filter((k) => bucket.kinds[k].cents > 0).map((k) => ({ kind: k, label: STATEMENT_METHOD_LABELS[k as keyof typeof STATEMENT_METHOD_LABELS], cents: bucket.kinds[k].cents }));
  const sum = shares.reduce((n, x) => n + x.cents, 0);
  return shares.length > 0 && sum === bucket.collectedCents ? shares : null;
}

// What ONE visit's row shows as collected: the sum of its collected-method lines (refunded, waived, unresolved and the other not-totalled lines are
// never added). null when the visit has no collected line with an amount, so the row shows "no amount" instead of a figure.
export function visitCollectedCents(lines: readonly { kind: StatementKind; cents: number | null }[]): number | null {
  let sum = 0;
  let any = false;
  for (const l of lines) {
    if (!COLLECTED.includes(l.kind) || l.cents === null) continue;
    sum += l.cents;
    any = true;
  }
  return any ? sum : null;
}

// The status pill on a Studio visit row, derived ONLY from that visit's own money lines, the price it was settled against, and the screen's existing wording;
// nothing is invented. The rule mirrors the client statement's own visit states:
//   * money collected AND a known price: "Paid" only when what was collected (plus anything waived) covers it; below it the pill is "Payment not confirmed"
//     with the existing reason "Part settled; the rest is not confirmed". No amount owed is computed or shown.
//   * money collected, no price known: "Payment recorded" (it cannot be said to be paid in full). The price is the settlement's recorded quote, else the
//     amount of a SOLE card session charge (the same priority the client statement's recorded fee uses); card amounts are what was charged, so a visit
//     paid by one card charge is covered by definition.
//   * a still-owing note beside money: "Payment recorded", the note shown beside the method.
//   * a recorded $0 collection: "No charge" when the price is $0, otherwise "Payment not confirmed" (nothing was collected against a price).
//   * no money collected: the adjustment or note, in the breakdown's own words.
// "paid" is the positive tone; the others are neutral.
export type VisitStatus = { label: string; tone: "paid" | "neutral"; reason?: string };
const PART_SETTLED = "Part settled; the rest is not confirmed";
export function studioVisitStatus(lines: readonly { kind: StatementKind; cents: number | null }[], quoteCents: number | null = null): VisitStatus {
  const kinds = new Set(lines.map((l) => l.kind));
  const collected = visitCollectedCents(lines);
  if (collected !== null) {
    const waived = lines.reduce((n, l) => (l.kind === "waived" && l.cents !== null ? n + l.cents : n), 0);
    const cardSessions = lines.filter((l) => l.kind === "collected_card_session" && l.cents !== null);
    const others = lines.filter((l) => COLLECTED.includes(l.kind) && l.kind !== "collected_card_session" && l.cents !== null);
    const price = quoteCents !== null ? quoteCents : cardSessions.length === 1 && others.length === 0 ? (cardSessions[0].cents as number) : null;
    if (collected === 0 && waived === 0) return price === 0 ? { label: "No charge", tone: "neutral" } : { label: "Payment not confirmed", tone: "neutral" };
    if (kinds.has("still_owes_note")) return { label: "Payment recorded", tone: "paid" };
    if (price === null) return { label: "Payment recorded", tone: "paid" };
    if (collected + waived < price) return { label: "Payment not confirmed", tone: "neutral", reason: PART_SETTLED };
    return { label: "Paid", tone: "paid" };
  }
  if (kinds.has("refunded_card_session") || kinds.has("refunded_card_fee")) return { label: "Refunded in full", tone: "neutral" };
  if (kinds.has("waived")) return { label: "Waived", tone: "neutral" };
  if (kinds.has("still_owes_note")) return { label: "Marked still owing", tone: "neutral" };
  return { label: "Unresolved", tone: "neutral" };
}

/** The short method words the Studio card and rows use ("Card", "E-transfer"); the full verified basis wording stays in the breakdown. */
export const SHORT_METHOD_LABEL: Partial<Record<StatementKind, string>> = {
  collected_card_session: "Card",
  collected_card_fee: "Card fees",
  collected_cash: "Cash",
  collected_e_transfer: "E-transfer",
  collected_other_external: "Other",
};
