import type { SupabaseClient } from "@supabase/supabase-js";
import { DECLINE_READ_PAGE, type DeclineRecords, type EntryFacts } from "@/lib/waitlist/decline-visibility";
import { readFollowUps, type FollowUpList } from "@/lib/waitlist/followups-owner";

// The owner's own session reads (RLS decides); the only other read is the existing owner follow-up command, which re-derives the owner itself. Reads ids, times and (for the section only) names and statuses.
// Contact details are NOT read here: they come only from the existing contact read, for the rows shown. Nothing is logged but a code.

/** Every declined invitation of the studio. Trusted only when the exact count equals the rows returned (the Data API cuts a response at 1000 rows). */
export async function loadDeclineRecords(db: SupabaseClient, studioId: string): Promise<DeclineRecords> {
  try {
    const r = await db
      .from("new_client_waitlist_invitations")
      .select("id,entry_id,declined_at", { count: "exact" })
      .eq("studio_id", studioId)
      .not("declined_at", "is", null)
      .order("declined_at", { ascending: false })
      .limit(DECLINE_READ_PAGE);
    if (r.error || !Array.isArray(r.data) || typeof r.count !== "number" || r.count !== r.data.length) return { kind: "unknown" };
    return { kind: "ok", rows: r.data as Array<{ id: string; entry_id: string; declined_at: string }> };
  } catch {
    return { kind: "unknown" };
  }
}

const CHUNK = 100;

/** Name and state for exactly the entries shown. Null when unreadable (the rows then say so). */
export async function loadDeclinedEntryFacts(db: SupabaseClient, studioId: string, entryIds: readonly string[]): Promise<Map<string, EntryFacts> | null> {
  const out = new Map<string, EntryFacts>();
  try {
    for (let i = 0; i < entryIds.length; i += CHUNK) {
      const r = await db
        .from("new_client_waitlist_entries")
        .select("id,name,status,joined_at")
        .eq("studio_id", studioId)
        .in("id", entryIds.slice(i, i + CHUNK));
      if (r.error || !Array.isArray(r.data)) return null;
      for (const e of r.data as Array<{ id: string; name: string; status: string; joined_at?: string | null }>)
        out.set(e.id, { name: e.name, status: e.status, joinedAt: typeof e.joined_at === "string" ? e.joined_at : null });
    }
    return out;
  } catch {
    return null;
  }
}

const PARALLEL = 10;

async function inBatches<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += PARALLEL) out.push(...(await Promise.all(items.slice(i, i + PARALLEL).map(run))));
  return out;
}

/**
 * Each shown invitation's OWN follow-ups through the existing owner command's invitation-scoped form, which includes closed follow-ups whose
 * answers were erased or are past retention (the page list leaves those out). At most the people shown, ten at a time. A read that fails is
 * `unknown` for that invitation only.
 */
export async function loadScopedFollowUps(studioId: string, actorUserId: string | null, invitationIds: readonly string[]): Promise<Map<string, FollowUpList>> {
  const results = await inBatches(invitationIds, (id) => readFollowUps(studioId, actorUserId, id));
  return new Map(invitationIds.map((id, i) => [id, results[i]!]));
}

/**
 * The queue page each entry sits on, so the link lands on a page that contains it: its position in its own status section under the SAME total
 * order the queue uses (joined_at, then id), as a head-only count of the entries ahead of it. An entry whose count cannot be read is simply
 * absent from the result, and the caller then offers no link for it.
 */
export async function loadEntryQueuePages(
  db: SupabaseClient,
  studioId: string,
  entries: ReadonlyArray<{ id: string; status: string; joinedAt: string }>,
  pageSize: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const counted = await inBatches(entries, async (e) => {
    try {
      const r = await db
        .from("new_client_waitlist_entries")
        .select("id", { count: "exact", head: true })
        .eq("studio_id", studioId)
        .eq("status", e.status)
        .or(`joined_at.lt.${e.joinedAt},and(joined_at.eq.${e.joinedAt},id.lt.${e.id})`);
      return r.error || typeof r.count !== "number" ? null : r.count;
    } catch {
      return null;
    }
  });
  entries.forEach((e, i) => {
    const ahead = counted[i];
    if (typeof ahead === "number") out.set(e.id, Math.floor(ahead / pageSize) + 1);
  });
  return out;
}
