import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommandCounts, Count, OutcomeCounts } from "@/lib/waitlist/invitation-booking-summary";

// THE OWNER'S OWN SESSION READS, nothing else. Two kinds of read, both counts only:
//   * the owner-only command `waitlist_invitation_booking_counts` (it re-derives the owner and returns five integers for ONE studio), and
//   * exact HEAD-ONLY counts of the studio's invitations by outcome, under the same period filter. A head count returns a number and no rows, so the
//     Data API's row cap (1000) never applies, and a count that could not be read is `null`, never 0.
// No name, contact detail, token or id is read or returned. Nothing is written, sent or logged but a code.

const TABLE = "new_client_waitlist_invitations";
const COMMAND = "waitlist_invitation_booking_counts";

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The command's five counts, or null when the command is not there, refused, or answered anything but five non-negative integers. */
export async function loadCommandCounts(db: SupabaseClient, studioId: string, periodStartIso: string): Promise<CommandCounts | null> {
  try {
    const r = await db.rpc(COMMAND, { p_studio_id: studioId, p_from: periodStartIso });
    if (r.error) {
      console.error(JSON.stringify({ event: "waitlist_booking_counts_read_failed", code: r.error.code ?? "unknown", timestamp: new Date().toISOString() }));
      return null;
    }
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    if (!row || typeof row !== "object") return null;
    const o = row as Record<string, unknown>;
    const vals = [o.invitations_total, o.people_invited, o.booked_linked_live, o.booked_then_cancelled, o.converted_unlinked];
    if (!vals.every(isCount)) return null;
    return {
      invitationsTotal: o.invitations_total as number,
      peopleInvited: o.people_invited as number,
      bookedLinkedLive: o.booked_linked_live as number,
      bookedThenCancelled: o.booked_then_cancelled as number,
      convertedUnlinked: o.converted_unlinked as number,
    };
  } catch {
    return null;
  }
}

/** The few filter methods the head counts use, so no query-builder generics leak out of this file. */
type Q = PromiseLike<{ count: number | null; error: unknown }> & {
  not(column: string, operator: string, value: unknown): Q;
  is(column: string, value: null): Q;
  gt(column: string, value: string): Q;
  lte(column: string, value: string): Q;
};
type Filter = (q: Q) => Q;

async function headCount(db: SupabaseClient, studioId: string, periodStartIso: string, filter: Filter): Promise<Count> {
  try {
    const base = db.from(TABLE).select("id", { count: "exact", head: true }).eq("studio_id", studioId).gte("issued_at", periodStartIso);
    const r = await filter(base as unknown as Q);
    if (r.error || !isCount(r.count)) return null;
    return r.count;
  } catch {
    return null;
  }
}

/** Exact counts of the studio's invitations sent since `periodStartIso`, one per outcome, each invitation in exactly one (declined, then used, then expired, then released, then open). */
export async function loadOutcomeCounts(db: SupabaseClient, studioId: string, periodStartIso: string, nowIso: string): Promise<OutcomeCounts> {
  const c = (f: Filter) => headCount(db, studioId, periodStartIso, f);
  const [total, declined, linkUsed, expiredRecorded, released, open, deadlinePassed] = await Promise.all([
    c((q) => q),
    c((q) => q.not("declined_at", "is", null)),
    c((q) => q.is("declined_at", null).not("redeemed_at", "is", null)),
    c((q) => q.is("declined_at", null).is("redeemed_at", null).not("expired_at", "is", null)),
    c((q) => q.is("declined_at", null).is("redeemed_at", null).is("expired_at", null).not("released_at", "is", null)),
    c((q) => q.is("declined_at", null).is("redeemed_at", null).is("expired_at", null).is("released_at", null).gt("expires_at", nowIso)),
    c((q) => q.is("declined_at", null).is("redeemed_at", null).is("expired_at", null).is("released_at", null).lte("expires_at", nowIso)),
  ]);
  return { total, declined, linkUsed, expiredRecorded, released, open, deadlinePassed };
}
