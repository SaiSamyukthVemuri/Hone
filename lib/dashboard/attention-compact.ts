import type { AttentionItem, AttentionItemKind } from "./needs-attention-model";

// Compact presentation of one client's Needs attention items (HON-65, Sam 4 Nov). PURE.
//
// One client card shows ONE row per KIND of issue, so "aftercare not marked" on three visits reads as one short line with a count and its visits
// one click away, never as three copies of the same sentence and button. Distinct issues stay distinct rows. Nothing here changes an item, its
// destination or its dismissal identity: the details list still carries each visit's own action.

export type ItemGroup = { kind: AttentionItemKind; items: AttentionItem[] };

/** Items of one kind folded together, in the order the kinds first appear (the model's order is already the priority order). */
export function groupItemsByKind(items: ReadonlyArray<AttentionItem>): ItemGroup[] {
  const groups: ItemGroup[] = [];
  for (const item of items) {
    const g = groups.find((x) => x.kind === item.kind);
    if (g) g.items.push(item);
    else groups.push({ kind: item.kind, items: [item] });
  }
  return groups;
}

/** "Tue, Oct 28" in the STUDIO's timezone, so the date a visit is listed under is the day it happened there. Empty for a missing or bad date. */
export function visitDateLabel(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone }).format(new Date(t));
  } catch {
    return new Intl.DateTimeFormat("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(t));
  }
}

/** The count text of a folded group: "3 visits". */
export const visitsLabel = (n: number): string => `${n} visits`;
