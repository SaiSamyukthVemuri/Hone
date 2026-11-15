import { createClient } from "@/lib/supabase/server";
import { dbErrorCode } from "@/lib/logging/error-class";
import type { VisitAppointment } from "@/lib/clients/profile-visits";

// The Overview's ONE bounded appointment read: at most two rows, no new table, no join. The newest
// completed appointment that already started and the nearest confirmed one still ahead are all that
// "Last visit" and "Next appointment" need (lib/clients/profile-visits.ts decides which wins).
// Read only. Studio-scoped on the RLS client like every other profile read. A failed read throws
// rather than reading as "no appointment".
export async function getOverviewVisitAppointments(
  studioId: string,
  clientId: string,
  nowIso: string,
): Promise<VisitAppointment[]> {
  const supabase = await createClient();
  const [past, next] = await Promise.all([
    supabase
      .from("appointments")
      .select("id, starts_at, status")
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .eq("status", "completed")
      .lt("starts_at", nowIso)
      .order("starts_at", { ascending: false })
      .limit(1),
    supabase
      .from("appointments")
      .select("id, starts_at, status")
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .eq("status", "confirmed")
      .gte("starts_at", nowIso)
      .order("starts_at", { ascending: true })
      .limit(1),
  ]);
  if (past.error) throw new Error(`Failed to load last appointment: ${dbErrorCode(past.error)}`);
  if (next.error) throw new Error(`Failed to load next appointment: ${dbErrorCode(next.error)}`);
  return [...(past.data ?? []), ...(next.data ?? [])] as VisitAppointment[];
}
