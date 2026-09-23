import type { createClient } from "@/lib/supabase/server";
import type { WaitlistEntryStatus } from "./admission-model";

// ===========================================================================
// NEW-CLIENT WAITLIST — DOES THIS STUDIO HAVE A LIVE OPERATOR QUEUE?
// ===========================================================================
//
// WAITLIST-NAV-VIS-01. The Settings tab used to follow ONLY the rollout flags,
// so a studio holding real durable entries lost its navigation to them the
// moment the flags were not both set — the queue stayed reachable by URL but
// nobody could find it. This answers the one extra question the layout needs:
// is there anything in the queue an operator can still act on?

/**
 * The states the operator queue (`/settings/waitlist`) reads and acts on, in
 * section order. The page's sections are THIS list, so "the tab is visible
 * because of active entries" and "the page shows those entries" cannot drift.
 *
 * `converted` and `removed` are terminal history and deliberately absent:
 * history alone is no reason to advertise a queue.
 */
export const OPERATOR_QUEUE_STATUSES = [
  "waiting",
  "claimed",
  "invited",
  "expired",
  "released",
] as const satisfies ReadonlyArray<WaitlistEntryStatus>;

type UserClient = Awaited<ReturnType<typeof createClient>>;

/**
 * True when the studio has at least one entry in an operator-queue state.
 *
 * Takes the caller's RLS-scoped USER client — never service-role — so the read
 * is gated by the owner policy on `new_client_waitlist_entries` at the
 * database; the explicit `studio_id` filter is defence in depth and the leading
 * column of the queue index. HEAD-only: a count comes back, no rows do.
 *
 * FAILS CLOSED. This runs in the Settings layout, which wraps every settings
 * page, so an error must not take those pages down; it hides the tab (the
 * pre-existing behaviour) and logs, and the page itself stays reachable by URL.
 */
export async function hasActiveWaitlistEntries(
  supabase: UserClient,
  studioId: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from("new_client_waitlist_entries")
    .select("id", { count: "exact", head: true })
    .eq("studio_id", studioId)
    .in("status", [...OPERATOR_QUEUE_STATUSES]);

  if (error) {
    console.error(
      JSON.stringify({
        event: "waitlist_nav_presence_failed",
        studioId,
        code: error.code ?? "unknown",
        timestamp: new Date().toISOString(),
      }),
    );
    return false;
  }
  return (count ?? 0) > 0;
}
