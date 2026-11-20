import type { StatementDocument } from "@/lib/finance/statement-document";
import type { StatementKind } from "@/lib/finance/statement";
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
