import type { SupabaseClient } from "@supabase/supabase-js";
import type { FollowUpRow } from "./followups-owner";

// 0325 — which of a person's EXISTING appointments an owner may link to their open follow-up. Read with the owner's RLS-scoped client, after the
// page's owner check. The database decides eligibility (same studio, same client email as the entry, not cancelled, not already linked); this only
// matches clients on clients.normalized_email (0032: case-folded, trimmed), so a stored mixed-case address still matches; it offers the person's own upcoming, non-cancelled appointments so the owner never types an id. Labels are a date and time only: no name, no service.
export type LinkableAppointment = { id: string; label: string };
/** `more` is true when the person has more eligible appointments than are offered: the card then says which ones are shown. */
export type LinkableList = { items: LinkableAppointment[]; more: boolean };

// Per person, newest-BOOKED first (created_at), so the booking the owner has just made with "Book now" is always among them, however many earlier
// appointments the person has. One extra row is read to know whether more exist.
export const CAP_APPOINTMENTS = 10;
// Id lists stay short URLs, and per-person appointment reads run a few at a time. EVERY displayed open follow-up gets its candidates: nothing is
// capped by position, so the 25th card has the same Link booking control as the first.
const ID_CHUNK = 50;
const PARALLEL = 10;

const chunks = <T,>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export async function loadLinkableAppointments(
  db: SupabaseClient,
  studioId: string,
  rows: readonly FollowUpRow[],
  timeZone: string,
  now: Date = new Date(),
): Promise<Map<string, LinkableList>> {
  const out = new Map<string, LinkableList>();
  const open = rows.filter((r) => r.status === "open");
  if (open.length === 0) return out;
  try {
    const emailByEntry = new Map<string, string>();
    for (const part of chunks(open.map((r) => r.entryId), ID_CHUNK)) {
      const entries = await db.from("new_client_waitlist_entries").select("id,email").eq("studio_id", studioId).in("id", part);
      if (entries.error || !Array.isArray(entries.data)) return out;
      for (const e of entries.data as Array<{ id?: unknown; email?: unknown }>) {
        if (typeof e.id === "string" && typeof e.email === "string" && e.email.trim()) emailByEntry.set(e.id, e.email.trim().toLowerCase());
      }
    }
    const emails = [...new Set(emailByEntry.values())];
    if (emails.length === 0) return out;
    const clientIdsByEmail = new Map<string, string[]>();
    for (const part of chunks(emails, ID_CHUNK)) {
      const clients = await db.from("clients").select("id,normalized_email").eq("studio_id", studioId).in("normalized_email", part);
      if (clients.error || !Array.isArray(clients.data)) return out;
      for (const c of clients.data as Array<{ id?: unknown; normalized_email?: unknown }>) {
        if (typeof c.id !== "string" || typeof c.normalized_email !== "string") continue;
        const k = c.normalized_email;
        clientIdsByEmail.set(k, [...(clientIdsByEmail.get(k) ?? []), c.id]);
      }
    }
    const allClientIds = [...new Set([...clientIdsByEmail.values()].flat())];
    if (allClientIds.length === 0) return out;
    // One bounded read PER PERSON, so one client with many upcoming appointments can never starve another's candidates.
    const apptsByClient = new Map<string, { appts: Array<{ id: string; starts_at: string; created_at: string }>; more: boolean }>();
    for (const part of chunks(allClientIds, PARALLEL)) {
      const results = await Promise.all(
        part.map((clientId) =>
          db
            .from("appointments")
            .select("id,client_id,starts_at,created_at,status")
            .eq("studio_id", studioId)
            .eq("client_id", clientId)
            .neq("status", "cancelled")
            .gte("starts_at", new Date(now.getTime() - 86_400_000).toISOString())
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .limit(CAP_APPOINTMENTS + 1),
        ),
      );
      results.forEach((res, idx) => {
        if (res.error || !Array.isArray(res.data)) return;
        const got = (res.data as Array<{ id?: unknown; starts_at?: unknown; created_at?: unknown }>).flatMap((a) =>
          typeof a.id === "string" && typeof a.starts_at === "string" && typeof a.created_at === "string"
            ? [{ id: a.id, starts_at: a.starts_at, created_at: a.created_at }]
            : [],
        );
        apptsByClient.set(part[idx], { appts: got.slice(0, CAP_APPOINTMENTS), more: res.data.length > CAP_APPOINTMENTS });
      });
    }
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    for (const r of open) {
      const email = emailByEntry.get(r.entryId);
      const reads = (email ? (clientIdsByEmail.get(email) ?? []) : []).map((id) => apptsByClient.get(id));
      const all = reads.flatMap((x) => x?.appts ?? []).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      const more = reads.some((x) => x?.more) || all.length > CAP_APPOINTMENTS;
      const mine = all.slice(0, CAP_APPOINTMENTS).map((a) => ({ id: a.id, label: fmt.format(new Date(a.starts_at)) }));
      if (mine.length > 0) out.set(r.followupId, { items: mine, more });
    }
  } catch {
    // The list is a convenience; the database still decides every link. An unreadable list just offers none.
  }
  return out;
}
