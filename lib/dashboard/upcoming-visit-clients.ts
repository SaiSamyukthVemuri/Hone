import type { createClient } from "@/lib/supabase/server";

// Which clients have a confirmed visit coming up. Used ONLY to place an intake
// gap in Needs attention's "preparation" tier (a client who is about to be seen)
// rather than the general list. Read-only, studio-scoped, narrow projection
// (client id only). It decides ORDER, never a count: nothing is added to or
// removed from the list by it.

export const UPCOMING_VISIT_WINDOW_DAYS = 7;
const PAGE_SIZE = 1000;
const MAX_PAGES = 5;

type Supabase = Awaited<ReturnType<typeof createClient>>;

export async function getClientIdsWithUpcomingVisits(
  supabase: Supabase,
  studioId: string,
  nowIso: string,
): Promise<Set<string>> {
  const end = new Date(
    new Date(nowIso).getTime() + UPCOMING_VISIT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const ids = new Set<string>();
  for (let page = 0; ; page++) {
    // Past the ceiling the answer would be partial; refuse so the caller can say
    // "could not check" instead of silently mis-tiering.
    if (page >= MAX_PAGES) throw new Error("Failed to load upcoming visits");
    const { data, error } = await supabase
      .from("appointments")
      .select("client_id")
      .eq("studio_id", studioId)
      .eq("status", "confirmed")
      .gte("starts_at", nowIso)
      .lt("starts_at", end)
      .order("starts_at", { ascending: true })
      .order("id", { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) throw new Error("Failed to load upcoming visits");
    const batch = (data ?? []) as Array<{ client_id: string | null }>;
    for (const r of batch) if (r.client_id) ids.add(r.client_id);
    if (batch.length < PAGE_SIZE) break;
  }
  return ids;
}
