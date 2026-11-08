// Entries whose invitation was used but whose booking did not complete.
//
// DERIVED, NEVER STORED. After the redeem commits and the appointment does not,
// the entry stays `invited` with a redeemed invitation and no conversion. That
// state survives a reload and needs no table, so the owner's list is a pure
// function of facts the page already reads. It cannot say WHY the booking
// failed (a taken time and a lost response look the same here), so the copy
// built on it must not claim a reason.

export type AttentionEntry = {
  id: string;
  name: string;
  joined_at: string;
  status: string;
};

export type CycleFacts = { redeemed: boolean };

export function redeemedUnbookedEntries<T extends AttentionEntry>(
  rows: readonly T[],
  cycles: ReadonlyMap<string, CycleFacts> | null,
): T[] | null {
  // Unknown is not "none": the caller says so rather than showing an empty list.
  if (cycles === null) return null;
  return rows.filter((r) => r.status === "invited" && cycles.get(r.id)?.redeemed === true);
}
