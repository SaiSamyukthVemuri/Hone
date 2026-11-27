// Who the database gate refuses when a studio holds more ACTIVE receptionists than it has seats (0390). The rule is the database's, not
// this file's: receptionist_actor_id ranks a studio's active receptionists by (created_at, id) and seats the first `limit`. This mirror
// exists only so the owner's Team page can say who is affected; it grants and refuses nothing.

export type RankedReceptionist = { id: string; active: boolean; created_at: string };

/** Ids of active receptionists beyond the seat limit (the newest ones), in the order the gate would refuse them. */
export function receptionistsOverLimit(rows: readonly RankedReceptionist[], seatLimit: number): Set<string> {
  const active = rows
    .filter((r) => r.active)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Set(active.slice(Math.max(0, seatLimit)).map((r) => r.id));
}
