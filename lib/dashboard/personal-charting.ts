import { createClient } from "@/lib/supabase/server";
import {
  CHARTED_WINDOW_DAYS,
  summarizeChartedWithin24h,
  type ChartedWithin24hMetrics,
} from "./practice-metrics";

// ===========================================================================
// A practitioner's OWN "charted within 24 hours", for the practitioner
// themselves.
// ===========================================================================
//
// Same definition as the studio figure in the owner's Practice Snapshot
// (practice-metrics.ts: completed appointments that ended in the rolling last 7
// days; charted = earliest non-deleted treatment-area save on the linked,
// non-deleted session within 24h), narrowed to appointments ASSIGNED to this
// practitioner. It is shown only to that person. It is never shown to anyone
// else, never compared with another practitioner and never ranked: the studio
// figure's rule "never grouped or ranked by practitioner" stands.
//
// Read-only, studio-scoped by the caller's session, narrow projections (ids and
// timestamps only; no client, service or price column). A read error THROWS so
// the caller can say "unavailable"; it is never rendered as 0/0.

export async function getPersonalChartedWithin24h(
  studioId: string,
  practitionerId: string,
  nowIso: string,
): Promise<ChartedWithin24hMetrics> {
  const supabase = await createClient();
  const windowStartIso = new Date(
    new Date(nowIso).getTime() - CHARTED_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data: appts, error } = await supabase
    .from("appointments")
    .select("id, ends_at")
    .eq("studio_id", studioId)
    .eq("practitioner_id", practitionerId)
    .eq("status", "completed")
    .gte("ends_at", windowStartIso)
    .lte("ends_at", nowIso);
  if (error) throw new Error("Failed to load personal charting");
  const completed = (appts ?? []) as Array<{ id: string; ends_at: string }>;

  const firstCharted = new Map<string, string>();
  if (completed.length > 0) {
    const { data: sessions, error: sErr } = await supabase
      .from("sessions")
      .select("id, appointment_id")
      .eq("studio_id", studioId)
      .in("appointment_id", completed.map((a) => a.id))
      .is("deleted_at", null);
    if (sErr) throw new Error("Failed to load personal charting");
    const sessionToAppt = new Map(
      ((sessions ?? []) as Array<{ id: string; appointment_id: string }>).map((s) => [s.id, s.appointment_id]),
    );
    if (sessionToAppt.size > 0) {
      const { data: blocks, error: bErr } = await supabase
        .from("session_blocks")
        .select("session_id, created_at")
        .eq("studio_id", studioId)
        .in("session_id", [...sessionToAppt.keys()])
        .is("deleted_at", null);
      if (bErr) throw new Error("Failed to load personal charting");
      for (const b of (blocks ?? []) as Array<{ session_id: string; created_at: string }>) {
        const apptId = sessionToAppt.get(b.session_id);
        if (!apptId) continue;
        const existing = firstCharted.get(apptId);
        if (!existing || b.created_at < existing) firstCharted.set(apptId, b.created_at);
      }
    }
  }

  return summarizeChartedWithin24h(
    completed.map((a) => ({ endsAt: a.ends_at, firstChartedAt: firstCharted.get(a.id) ?? null })),
  );
}
