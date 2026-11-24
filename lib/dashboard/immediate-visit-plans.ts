import type { createClient } from "@/lib/supabase/server";
import type { AppointmentPrepLoad } from "@/lib/sessions/last-treatment-loader";
import { chunkIds } from "./in-chunks";

type Appointment = {
  id: string; client_id: string; starts_at: string; status: string;
  service: { modality: string | null } | null;
};
type Plan = NonNullable<AppointmentPrepLoad["narrative"]["plan"]>;
type Visit = {
  id: string; starts_at: string; service: { modality: string | null } | null;
  sessions: { id: string }[];
};
const WINDOW = 48;

// Keep PostgreSQL's microseconds when comparing equivalent offsets.
function instant(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const remainder = /\.\d{3}(\d{1,3})/.exec(value)?.[1] ?? "";
  return new Date(time).toISOString().slice(0, 23) + remainder.padEnd(3, "0") + "Z";
}

/** An ordered page either reaches the target, proves a prior treatment
 * already used its note, or needs the next page. */
export function planTargetOnPage(target: Appointment, plan: Plan, visits: Visit[]): "target" | "consumed" | "unseen" {
  const from = instant(plan.startedAt);
  const until = instant(target.starts_at);
  if (!from || !until || from >= until) return "consumed";
  const intervening = visits.some(visit => {
    const time = instant(visit.starts_at);
    return visit.id !== target.id && time >= from && (time < until || (time === until && visit.id < target.id))
      && visit.service?.modality !== "consultation"
      && !visit.sessions.some(session => session.id === plan.sessionId);
  });
  if (intervening) return "consumed";
  return visits.some(visit => visit.id === target.id) ? "target" : "unseen";
}

/** A one-visit plan belongs to the first treatment after its source. The history
 * loader knows about sessions; the schedule also knows about visits with no
 * chart at all. Use a bounded, studio-scoped batch for only clients with a plan. */
export async function immediateVisitPlans(
  supabase: Awaited<ReturnType<typeof createClient>>,
  studioId: string,
  roster: readonly Appointment[],
  loads: ReadonlyMap<string, AppointmentPrepLoad>,
): Promise<Map<string, string>> {
  const candidates = new Map<string, { target: Appointment; plan: Plan }[]>();
  for (const target of roster) {
    const narrative = loads.get(target.id)?.narrative;
    const plan = narrative?.plan;
    if (!plan || !plan.text.trim() || plan.sessionId !== narrative?.latestVisit?.id
        || target.status !== "confirmed" || target.service?.modality === "consultation") continue;
    const group = candidates.get(target.client_id) ?? [];
    group.push({ target, plan });
    candidates.set(target.client_id, group);
  }
  const result = new Map<string, string>();
  await Promise.all(chunkIds([...candidates.keys()]).map(async ids => {
    const targets = ids.flatMap(id => candidates.get(id)!);
    const oldest = targets.map(({ plan }) => instant(plan.startedAt)).sort()[0];
    const newest = targets.map(({ target }) => instant(target.starts_at)).sort().at(-1);
    if (!oldest || !newest) return;
    let pending = new Map(ids.map(id => [id, candidates.get(id)!]));
    for (let offset = 0; pending.size; offset += WINDOW) {
      const { data, error } = await supabase.from("clients").select(
        "id, visits:appointments!appointments_client_same_studio_fk(id, starts_at, service:services!appointments_service_same_studio_fk(modality), sessions!sessions_appointment_same_studio_fk(id))",
      ).eq("studio_id", studioId).in("id", [...pending.keys()]).in("visits.status", ["confirmed", "completed"])
        .gte("visits.starts_at", oldest).lte("visits.starts_at", newest)
        .order("starts_at", { ascending: true, referencedTable: "visits" })
        .order("id", { ascending: true, referencedTable: "visits" })
        .range(offset, offset + WINDOW - 1, { referencedTable: "visits" });
      if (error) return;
      const remaining = new Map<string, { target: Appointment; plan: Plan }[]>();
      for (const client of (data ?? []) as unknown as { id: string; visits: Visit[] }[]) {
        const waiting = [];
        for (const request of pending.get(client.id) ?? []) {
          const outcome = planTargetOnPage(request.target, request.plan, client.visits);
          if (outcome === "target") result.set(request.target.id, request.plan.text.trim());
          if (outcome === "unseen" && client.visits.length === WINDOW) waiting.push(request);
        }
        if (waiting.length) remaining.set(client.id, waiting);
      }
      pending = remaining;
    }
  }));
  return result;
}
