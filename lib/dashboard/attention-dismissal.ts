import type { AttentionIdentity } from "./attention-identity";

// ===========================================================================
// Needs Attention: which items a stored dismissal still hides.
// ===========================================================================
//
// PURE. A dismissal hides an item only while the live item has the SAME key AND
// the SAME instance token. A new issue for the same client (a new intake
// submission, a new reaction) has a different token, so it shows. A restored
// item (its event removed from the live set by the caller) shows again.
// Nothing here reads or writes a payment, a message or a charge.
//
// An "unstamped" token (see attention-identity) is never hidden.

export type StoredDismissal = AttentionIdentity;

export function isDismissed(
  live: AttentionIdentity,
  dismissals: ReadonlyArray<StoredDismissal>,
): boolean {
  if (live.instanceToken === "unstamped") return false;
  return dismissals.some(
    (d) => d.itemKey === live.itemKey && d.instanceToken === live.instanceToken,
  );
}

/** Split live items into shown and dismissed, preserving order. */
export function partitionByDismissal<T>(
  items: ReadonlyArray<T>,
  identityOf: (item: T) => AttentionIdentity,
  dismissals: ReadonlyArray<StoredDismissal>,
): { shown: T[]; dismissed: T[] } {
  const shown: T[] = [];
  const dismissed: T[] = [];
  for (const item of items) {
    (isDismissed(identityOf(item), dismissals) ? dismissed : shown).push(item);
  }
  return { shown, dismissed };
}

/**
 * Unpaid rule (a), recommended: stays dismissed while the outstanding amount is
 * at or below what was dismissed; reappears if it RISES (a refund or dispute
 * re-opens money). A partial payment lowers it and stays dismissed.
 * Pending Sam's answer; the alternative (b) is "reappear on any change".
 */
export function unpaidStaysDismissed(
  dismissedCents: number,
  outstandingCents: number,
): boolean {
  return outstandingCents <= dismissedCents;
}
