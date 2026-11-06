import type { AttentionItem, AttentionClient, NeedsAttention } from "./needs-attention-model";
import type { DashboardTodoItem } from "./todo-model";
import { attentionIdentity, safeToken, type AttentionIdentity } from "./attention-identity";
import { isDismissed, unpaidStaysDismissed, type StoredDismissal } from "./attention-dismissal";

// ===========================================================================
// Needs Attention: what the owner sees after their own dismissals.
// ===========================================================================
//
// PURE. Takes the full model and the CALLER'S stored dismissals (one owner's, never anyone else's) and returns the model without the
// dismissed items, plus the dismissed rows for the "Dismissed" view. It removes a REMINDER from a list and nothing else: it reads no
// money table, writes nothing, and the model it returns has the same items minus the dismissed ones. The heading count is taken from
// the returned model, so there is exactly one count and it never includes a dismissed item.
//
// Unpaid items follow the adopted rule (Sam, 4 Nov): a dismissal holds while the outstanding balance is at or below what was
// dismissed, and the item comes back when the balance rises. An item whose balance is unknown ("Amount unavailable") is never
// dismissable and never hidden.

export type DismissedRow = {
  itemKey: string;
  instanceToken: string;
  who: string;
  label: string;
  detail: string | null;
  kind: AttentionItem["kind"] | "studio";
  href: string;
  actionLabel: string;
};

/** The dismissal token of an unpaid item: the dismissed cents, `c<cents>`. */
export const unpaidToken = (cents: number): string => `c${Math.max(0, Math.trunc(cents))}`;
const centsOfToken = (token: string): number | null => (/^c\d{1,12}$/.test(token) ? Number(token.slice(1)) : null);

/** The identity a Dismiss on this client item would store; null when the item cannot be dismissed. */
export function itemIdentity(item: AttentionItem): AttentionIdentity | null {
  if (item.kind === "unpaid") {
    return item.balance?.kind === "owed" ? { itemKey: item.id, instanceToken: unpaidToken(item.balance.outstandingCents) } : null;
  }
  const id = attentionIdentity(item, item.stamp);
  return id.instanceToken === "unstamped" ? null : id;
}

/**
 * Studio-level reminders (setup, supplies, roll-ups). Dismissable; the real status stays in Settings and in the workflow itself.
 *
 * The token is DERIVED FROM THE STATE the reminder reports (Privacy AO3, #1356), never a constant: which setup step is missing
 * (the setup reminder), how many intakes or records are involved, the supply plus its expiry date. A dismissal therefore holds only for the
 * state the owner dismissed; when that state changes the reminder is shown again. A studio item that reports no state cannot be told
 * apart from a later one, so it is NOT dismissable (null) rather than hidden on a guess.
 */
export function studioIdentity(item: DashboardTodoItem): AttentionIdentity | null {
  const stamp = item.kind === "supply_expiry" ? item.occurredAt : (item.state ?? null);
  const raw = typeof stamp === "string" ? stamp.trim() : "";
  return raw === "" ? null : { itemKey: item.id, instanceToken: safeToken(raw) };
}

function hidden(item: AttentionItem, dismissals: ReadonlyArray<StoredDismissal>): boolean {
  if (item.kind === "unpaid") {
    if (item.balance?.kind !== "owed") return false;
    const live = item.balance.outstandingCents;
    return dismissals.some((d) => {
      if (d.itemKey !== item.id) return false;
      const was = centsOfToken(d.instanceToken);
      return was !== null && unpaidStaysDismissed(was, live);
    });
  }
  const id = itemIdentity(item);
  return id !== null && isDismissed(id, dismissals);
}

export function applyDismissals(
  needs: NeedsAttention,
  dismissals: ReadonlyArray<StoredDismissal>,
): { shown: NeedsAttention; dismissed: DismissedRow[] } {
  const dismissed: DismissedRow[] = [];
  const clients: AttentionClient[] = [];
  for (const card of needs.clients) {
    const keep: AttentionItem[] = [];
    for (const item of card.items) {
      if (hidden(item, dismissals)) {
        const id = itemIdentity(item)!;
        const stored = dismissals.find((d) => d.itemKey === item.id);
        dismissed.push({
          itemKey: id.itemKey,
          instanceToken: stored?.instanceToken ?? id.instanceToken,
          who: card.clientName,
          label: item.label,
          detail: item.detail,
          kind: item.kind,
          href: item.href,
          actionLabel: item.actionLabel,
        });
      } else keep.push(item);
    }
    if (keep.length > 0) clients.push({ ...card, items: keep });
  }
  const studioItems: DashboardTodoItem[] = [];
  for (const item of needs.studioItems) {
    const id = studioIdentity(item);
    if (id !== null && isDismissed(id, dismissals)) {
      dismissed.push({
        itemKey: id.itemKey,
        instanceToken: id.instanceToken,
        who: item.subject.label,
        label: item.reason,
        detail: item.detail,
        kind: "studio",
        href: item.action.href,
        actionLabel: item.action.label,
      });
    } else studioItems.push(item);
  }
  const idsByName = new Map<string, Set<string>>();
  for (const c of clients) {
    const k = c.clientName.trim().toLocaleLowerCase();
    (idsByName.get(k) ?? idsByName.set(k, new Set()).get(k)!).add(c.clientId);
  }
  const named = clients.map((c) => ({ ...c, sharesNameWithAnotherClient: (idsByName.get(c.clientName.trim().toLocaleLowerCase())?.size ?? 0) > 1 }));
  return {
    shown: {
      ...needs,
      clients: named,
      studioItems,
      itemCount: named.reduce((n, c) => n + c.items.length, 0) + studioItems.length,
    },
    dismissed,
  };
}

/** The ONE count shown in the Needs attention heading: clients and items, from the model the owner actually sees. */
export function headingCount(needs: NeedsAttention): { clients: number; items: number } {
  return { clients: needs.clients.length, items: needs.itemCount };
}

/** Keys of the studio-level reminders (setup, supplies, roll-ups): `<kind>:studio`, or `supply_expiry:<supply id>`. Client and unpaid keys are never here. */
const STUDIO_REMINDER_KEY = /^(?:[a-z_]+:studio|supply_expiry:[A-Za-z0-9_.-]+)$/;
/** At most this many stored dismissals are cleared in one page load. */
export const RESOLVED_CLEAR_CAP = 25;

/**
 * Privacy AP2. A studio reminder's dismissal is keyed by the reminder and the state it reported. When the reminder RESOLVES (it is no longer
 * live) the stored dismissal is dead weight that would hide the SAME state if it came back later (setup undone, a supply re-entered with the
 * same expiry). These are the stored studio-reminder keys that no live studio item carries, to be restored (the existing restore command).
 *
 * Fail safe: nothing is returned unless every check was readable and nothing was capped away, because a reminder missing from an incomplete
 * list has not resolved, it is unknown. Client and unpaid dismissals are never touched here.
 */
export function resolvedStudioDismissalKeys(needs: NeedsAttention, dismissals: ReadonlyArray<StoredDismissal>): string[] {
  if (needs.unavailableChecks.length > 0 || needs.notReturnedCount > 0) return [];
  const live = new Set(needs.studioItems.map((i) => i.id));
  const keys = new Set<string>();
  for (const d of dismissals) {
    if (STUDIO_REMINDER_KEY.test(d.itemKey) && !live.has(d.itemKey)) keys.add(d.itemKey);
  }
  return [...keys].sort().slice(0, RESOLVED_CLEAR_CAP);
}
