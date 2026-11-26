import type { createClient } from "@/lib/supabase/server";
import { chunkIds } from "@/lib/dashboard/in-chunks";

type SourceVisit = { id: string; client_id: string | null; starts_at: string };
export type NextRosterVisit = {
  id: string;
  starts_at: string;
  duration_minutes: number;
  service: { name: string } | null;
  practitioner: { display_name: string | null } | null;
};

type Supabase = Awaited<ReturnType<typeof createClient>>;
type ClientVisits = { id: string; visits: NextRosterVisit[] };

// Compare instants even when two Postgres timestamps use different offsets or differ by less than a millisecond.
function instant(value: string): string {
  const subMilliseconds = /\.\d{3}(\d{1,3})/.exec(value)?.[1] ?? "";
  return new Date(value).toISOString().slice(0, 23) + subMilliseconds.padEnd(3, "0") + "Z";
}

const PER_CLIENT = 8;

/** First confirmed visit strictly after both the clock and the source appointment. Absence means no booking. */
export async function getNextVisitsForRoster(
  supabase: Supabase,
  studioId: string,
  appointments: readonly SourceVisit[],
  nowIso: string,
): Promise<Map<string, NextRosterVisit>> {
  const next = new Map<string, NextRosterVisit>();
  const byClient = new Map<string, Array<{ id: string; clientId: string; after: string }>>();
  const now = instant(nowIso);
  for (const source of appointments) {
    if (!source.client_id) continue;
    const sources = byClient.get(source.client_id) ?? [];
    const start = instant(source.starts_at);
    sources.push({ id: source.id, clientId: source.client_id, after: start > now ? start : now });
    byClient.set(source.client_id, sources);
  }

  await Promise.all(chunkIds([...byClient.keys()]).map(async clientIds => {
    let pending = clientIds.flatMap(id => byClient.get(id) ?? []);
    while (pending.length) {
      const floor = pending.reduce((earliest, source) => source.after < earliest ? source.after : earliest, pending[0].after);
      const { data, error } = await supabase.from("clients")
        .select(`id, visits:appointments!appointments_client_same_studio_fk(
          id, starts_at, duration_minutes,
          service:services!appointments_service_same_studio_fk(name),
          practitioner:practitioners!appointments_practitioner_same_studio_fk(display_name)
        )`)
        .eq("studio_id", studioId)
        .in("id", [...new Set(pending.map(source => source.clientId))])
        .eq("visits.status", "confirmed")
        .gt("visits.starts_at", floor)
        .order("starts_at", { referencedTable: "visits", ascending: true })
        .order("id", { referencedTable: "visits", ascending: true })
        .limit(PER_CLIENT, { referencedTable: "visits" })
        .returns<ClientVisits[]>();
      if (error || !data) throw new Error("Failed to load next visits");

      const candidates = new Map(data.map(client => [
        client.id,
        client.visits.map(visit => ({ visit, time: instant(visit.starts_at) })),
      ]));
      // An exhausted list proves there is no next visit. A full list can hide a later source’s match.
      // Retry those sources from their own earliest threshold, skipping intervening bookings in the database.
      pending = pending.filter(source => {
        const visits = candidates.get(source.clientId) ?? [];
        const match = visits.find(({ visit, time }) => visit.id !== source.id && time > source.after);
        if (!match) return visits.length === PER_CLIENT;
        next.set(source.id, match.visit);
        return false;
      });
    }
  }));
  return next;
}
