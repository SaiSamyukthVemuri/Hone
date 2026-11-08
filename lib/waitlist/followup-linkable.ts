import type { SupabaseClient } from "@supabase/supabase-js";
import type { FollowUpRow } from "./followups-owner";

// 0325 — which of a person's EXISTING appointments an owner may link to their open follow-up. Read with the owner's RLS-scoped client, after the
// page's owner check. The database decides eligibility (same studio, same client email as the entry, not cancelled, not already linked); this only
// matches clients on clients.normalized_email (0032: case-folded, trimmed), so a stored mixed-case address still matches; it offers the person's own upcoming, non-cancelled appointments so the owner never types an id. Labels are a date and time only: no name, no service.
export type LinkableAppointment = { id: string; label: string };

const CAP_ROWS = 20;
const CAP_APPOINTMENTS = 5;

export async function loadLinkableAppointments(
  db: SupabaseClient,
  studioId: string,
  rows: readonly FollowUpRow[],
  timeZone: string,
  now: Date = new Date(),
): Promise<Map<string, LinkableAppointment[]>> {
  const out = new Map<string, LinkableAppointment[]>();
  const open = rows.filter((r) => r.status === "open").slice(0, CAP_ROWS);
  if (open.length === 0) return out;
  try {
    const entries = await db.from("new_client_waitlist_entries").select("id,email").eq("studio_id", studioId).in("id", open.map((r) => r.entryId));
    if (entries.error || !Array.isArray(entries.data)) return out;
    const emailByEntry = new Map<string, string>();
    for (const e of entries.data as Array<{ id?: unknown; email?: unknown }>) {
      if (typeof e.id === "string" && typeof e.email === "string" && e.email.trim()) emailByEntry.set(e.id, e.email.trim().toLowerCase());
    }
    const emails = [...new Set(emailByEntry.values())];
    if (emails.length === 0) return out;
    const clients = await db.from("clients").select("id,normalized_email").eq("studio_id", studioId).in("normalized_email", emails);
    if (clients.error || !Array.isArray(clients.data)) return out;
    const clientIdsByEmail = new Map<string, string[]>();
    for (const c of clients.data as Array<{ id?: unknown; normalized_email?: unknown }>) {
      if (typeof c.id !== "string" || typeof c.normalized_email !== "string") continue;
      const k = c.normalized_email;
      clientIdsByEmail.set(k, [...(clientIdsByEmail.get(k) ?? []), c.id]);
    }
    const allClientIds = [...clientIdsByEmail.values()].flat();
    if (allClientIds.length === 0) return out;
    const appts = await db
      .from("appointments")
      .select("id,client_id,starts_at,status")
      .eq("studio_id", studioId)
      .in("client_id", allClientIds)
      .neq("status", "cancelled")
      .gte("starts_at", new Date(now.getTime() - 86_400_000).toISOString())
      .order("starts_at", { ascending: true })
      .limit(100);
    if (appts.error || !Array.isArray(appts.data)) return out;
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    for (const r of open) {
      const email = emailByEntry.get(r.entryId);
      const ids = new Set(email ? (clientIdsByEmail.get(email) ?? []) : []);
      const mine = (appts.data as Array<{ id?: unknown; client_id?: unknown; starts_at?: unknown }>)
        .filter((a) => typeof a.id === "string" && typeof a.client_id === "string" && ids.has(a.client_id) && typeof a.starts_at === "string")
        .slice(0, CAP_APPOINTMENTS)
        .map((a) => ({ id: a.id as string, label: fmt.format(new Date(a.starts_at as string)) }));
      if (mine.length > 0) out.set(r.followupId, mine);
    }
  } catch {
    // The list is a convenience; the database still decides every link. An unreadable list just offers none.
  }
  return out;
}
