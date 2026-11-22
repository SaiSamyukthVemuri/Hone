import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isBookableByNewClient } from "@/lib/booking/consultation";
import { createClient } from "@/lib/supabase/server";
import { loadCommandCounts, loadOutcomeCounts } from "@/lib/waitlist/invitation-booking-summary-read";
import { periodStart, type Count } from "@/lib/waitlist/invitation-booking-summary";
import { buildWaitlistAnalytics, parseWaitlistParams, summarizeWaitingPool, type DeliveryCounts, type WaitingEntry, type WaitlistAnalyticsView, type WaitlistService } from "../waitlist-model";

const READ_CAP = 1000;
const ACTIVE_STATES = ["waiting", "claimed", "invited"];
type RawParams = Record<string, string | string[] | undefined>;
export type WaitlistRead = { access: "refused" } | {
  access: "granted"; view: WaitlistAnalyticsView; services: WaitlistService[]; servicesAvailable: boolean;
  params: ReturnType<typeof parseWaitlistParams>;
};

async function readPool(db: SupabaseClient, studioId: string, now: Date) {
  try {
    const r = await db.from("new_client_waitlist_entries")
      .select("status,joined_at,joined_at_provenance", { count: "exact" }).eq("studio_id", studioId)
      .in("status", ACTIVE_STATES).order("id").limit(READ_CAP);
    if (r.error || !Array.isArray(r.data) || r.count === null || r.count !== r.data.length) return null;
    const entries: WaitingEntry[] = [];
    for (const row of r.data) {
      if (!ACTIVE_STATES.includes(row.status) || typeof row.joined_at !== "string") return null;
      entries.push({ status: row.status as WaitingEntry["status"], joinedAt: row.joined_at, provenance: typeof row.joined_at_provenance === "string" ? row.joined_at_provenance : null });
    }
    return summarizeWaitingPool(entries, now);
  } catch { return null; }
}

async function readServices(db: SupabaseClient, studioId: string): Promise<WaitlistService[] | null> {
  try {
    const r = await db.from("services").select("id,name,modality,active", { count: "exact" })
      .eq("studio_id", studioId).eq("active", true).order("name").limit(READ_CAP);
    if (r.error || !Array.isArray(r.data) || r.count === null || r.count !== r.data.length) return null;
    if (r.data.some((s) => typeof s.id !== "string" || typeof s.name !== "string" || (s.modality !== null && typeof s.modality !== "string"))) return null;
    return r.data.filter((s) => isBookableByNewClient(s)).map((s) => ({ id: s.id as string, name: s.name as string }));
  } catch { return null; }
}

async function readDelivery(db: SupabaseClient, studioId: string, since: string): Promise<DeliveryCounts> {
  const count = async (disposition: string | null): Promise<Count> => {
    try {
      const q = db.from("new_client_waitlist_invitations").select("id", { count: "exact", head: true })
        .eq("studio_id", studioId).gte("issued_at", since);
      const r = await (disposition === null ? q.is("delivery_disposition", null) : q.eq("delivery_disposition", disposition));
      return !r.error && typeof r.count === "number" && Number.isSafeInteger(r.count) && r.count >= 0 ? r.count : null;
    } catch { return null; }
  };
  const [accepted, refused, unknown, unrecorded] = await Promise.all([count("accepted"), count("refused"), count("unknown"), count(null)]);
  return { accepted, refused, unknown, unrecorded };
}

async function readPeopleInvited(db: SupabaseClient, studioId: string, since: string): Promise<{ total: number; people: number } | null> {
  try {
    const r = await db.from("new_client_waitlist_invitations").select("entry_id", { count: "exact" })
      .eq("studio_id", studioId).gte("issued_at", since).limit(READ_CAP);
    if (r.error || !Array.isArray(r.data) || r.count === null || r.count !== r.data.length) return null;
    if (r.data.some((row) => typeof row.entry_id !== "string" || row.entry_id.length === 0)) return null;
    return { total: r.count, people: new Set(r.data.map((row) => row.entry_id as string)).size };
  } catch { return null; }
}

/** Invoker-only reads. Identity comes from the page's session, never a query string. No prospect contacts or invitation credentials are read. */
export async function loadWaitlistAnalytics(
  practitioner: { role: string }, studio: { id: string; timezone: string }, raw: RawParams, now: Date,
  suppliedClient?: SupabaseClient,
): Promise<WaitlistRead> {
  if (practitioner.role !== "owner") return { access: "refused" };
  const db = suppliedClient ?? await createClient();
  const since = periodStart(now.getTime());
  const [command, outcomes, pool, services, delivery] = await Promise.all([
    loadCommandCounts(db, studio.id, since), loadOutcomeCounts(db, studio.id, since, now.toISOString()),
    readPool(db, studio.id, now), readServices(db, studio.id), readDelivery(db, studio.id, since),
  ]);
  const view = buildWaitlistAnalytics({ now, timezone: studio.timezone, periodStartIso: since, command, outcomes, pool, delivery });
  if (command === null) {
    const people = await readPeopleInvited(db, studio.id, since);
    if (people !== null && people.total === outcomes.total) view.summary.peopleInvited = people.people;
  }
  return {
    access: "granted", services: services ?? [], servicesAvailable: services !== null,
    params: parseWaitlistParams(raw, services ?? []),
    view,
  };
}
