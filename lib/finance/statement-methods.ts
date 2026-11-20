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

// The status pill on a Studio visit row, derived ONLY from that visit's own money lines and the screen's existing wording; nothing is invented. Money
// collected wins; but with no price or balance known "Paid" cannot mean paid in full, so when a still-owing or waived note sits beside the money the pill
// says only "Payment recorded" and the row shows the note beside the method, in the breakdown's own wording. Otherwise the visit's lines are all adjustments
// or not-totalled notes and the pill says which. "paid" is the positive tone; the others are neutral.
export type VisitStatus = { label: string; tone: "paid" | "neutral" };
export function studioVisitStatus(lines: readonly { kind: StatementKind; cents: number | null }[]): VisitStatus {
  const kinds = new Set(lines.map((l) => l.kind));
  if (visitCollectedCents(lines) !== null) return kinds.has("still_owes_note") || kinds.has("waived") ? { label: "Payment recorded", tone: "paid" } : { label: "Paid", tone: "paid" };
  if (kinds.has("refunded_card_session") || kinds.has("refunded_card_fee")) return { label: "Refunded in full", tone: "neutral" };
  if (kinds.has("waived")) return { label: "Waived", tone: "neutral" };
  if (kinds.has("still_owes_note")) return { label: "Marked still owing", tone: "neutral" };
  return { label: "Unresolved", tone: "neutral" };
}
