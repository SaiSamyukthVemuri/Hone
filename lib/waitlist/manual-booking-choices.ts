import type { SupabaseClient } from "@supabase/supabase-js";

// "Booked manually": the appointments an owner may pick for a waiting person. Read with the owner's RLS-scoped client after the page's owner check.
// Unlike the follow-up link, this offers ALL of the person's non-cancelled appointments from a day ago onward (not the 10 most recent), matched on
// clients.normalized_email within the studio. The database still decides eligibility (not linked elsewhere, studio, status, email confirmation);
// an unreadable read offers nothing and never guesses.
export type ManualBookingChoice = { id: string; label: string };

// Bounded so one person with a very long history cannot make the page unbounded; the picker says when it was cut.
export const MANUAL_CHOICES_PER_PERSON = 100;
const ID_CHUNK = 50;
const DAY_MS = 86_400_000;

const chunks = <T,>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export async function loadManualBookingChoices(
  db: SupabaseClient,
  studioId: string,
  entries: ReadonlyArray<{ id: string; email: string }>,
  label: (startsAtIso: string) => string,
  now: Date = new Date(),
): Promise<Map<string, ManualBookingChoice[]>> {
  const out = new Map<string, ManualBookingChoice[]>();
  const emailByEntry = new Map<string, string>();
  for (const e of entries) {
    const em = typeof e.email === "string" ? e.email.trim().toLowerCase() : "";
    if (em) emailByEntry.set(e.id, em);
  }
  const emails = [...new Set(emailByEntry.values())];
  if (emails.length === 0) return out;
  try {
    const clientIdsByEmail = new Map<string, string[]>();
    for (const part of chunks(emails, ID_CHUNK)) {
      const res = await db.from("clients").select("id,normalized_email").eq("studio_id", studioId).in("normalized_email", part);
      if (res.error || !Array.isArray(res.data)) return new Map();
      for (const c of res.data as Array<{ id?: unknown; normalized_email?: unknown }>) {
        if (typeof c.id !== "string" || typeof c.normalized_email !== "string") continue;
        clientIdsByEmail.set(c.normalized_email, [...(clientIdsByEmail.get(c.normalized_email) ?? []), c.id]);
      }
    }
    const since = new Date(now.getTime() - DAY_MS).toISOString();
    const byClient = new Map<string, ManualBookingChoice[]>();
    const allClientIds = [...new Set([...clientIdsByEmail.values()].flat())];
    for (const part of chunks(allClientIds, 10)) {
      const results = await Promise.all(
        part.map((clientId) =>
          db
            .from("appointments")
            .select("id,starts_at")
            .eq("studio_id", studioId)
            .eq("client_id", clientId)
            .neq("status", "cancelled")
            .gte("starts_at", since)
            .order("starts_at", { ascending: true })
            .order("id", { ascending: true })
            .limit(MANUAL_CHOICES_PER_PERSON),
        ),
      );
      results.forEach((res, i) => {
        if (res.error || !Array.isArray(res.data)) return;
        byClient.set(
          part[i],
          (res.data as Array<{ id?: unknown; starts_at?: unknown }>).flatMap((a) =>
            typeof a.id === "string" && typeof a.starts_at === "string" ? [{ id: a.id, label: label(a.starts_at) }] : [],
          ),
        );
      });
    }
    for (const [entryId, em] of emailByEntry) {
      const items = (clientIdsByEmail.get(em) ?? []).flatMap((cid) => byClient.get(cid) ?? []);
      if (items.length > 0) out.set(entryId, items);
    }
    return out;
  } catch {
    return new Map();
  }
}
