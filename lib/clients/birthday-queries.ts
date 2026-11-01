// Practitioner-only birthday lookups.
//
// Reads month + day from the existing public.clients.date_of_birth
// column (the year is ignored. See app/(app)/clients/[id]/birthday-
// actions.ts for the sentinel-year storage convention).
//
// Filters in app code rather than via SQL EXTRACT because Supabase
// JS does not expose a clean filter for derived month/day. For
// expected studio sizes (≤ a few hundred clients) this is trivial.
//
// Server-only. Must NOT be imported by app/book/*, lib/email/*,
// app/intake/*, app/cancel/*, app/reschedule/*, app/api/cron/*, or
// app/api/stripe/*. Audited by grep in PR #28.

import { clientDisplayName } from "@/lib/clients/identity";
import { preferredNameColumn, readWithPreferredName } from "@/lib/clients/preferred-name-read";
import { createClient } from "@/lib/supabase/server";

export type ClientBirthdayRow = {
  id: string;
  name: string;
  month: number; // 1-12
  day: number; // 1-31
};

export async function getClientBirthdaysForMonth(
  studioId: string,
  monthInStudioTz: number,
): Promise<ClientBirthdayRow[]> {
  const supabase = await createClient();
  // PR Willow launch fixes (migration 0050): archived clients are
  // hidden from the dashboard birthday surface for the same reason
  // they are hidden from the active client list.
  // Privacy C2 (PEER-1299): the NAME staff see is the display identity
  // (preferred, else stored) through the one identity helper, not the raw stored
  // name. The read tolerates a database that has no preferred_name column yet.
  const { data, error } = await readWithPreferredName((withPreferred) =>
    supabase
      .from("clients")
      .select(`id, name, ${preferredNameColumn(withPreferred)}date_of_birth`)
      .eq("studio_id", studioId)
      .is("archived_at", null)
      .not("date_of_birth", "is", null),
  );
  if (error) {
    // DAT-002 N2: a fixed message; PostgREST text can echo the statement.
    throw new Error("Failed to load birthdays");
  }

  const out: ClientBirthdayRow[] = [];
  for (const r of (data ?? []) as unknown as {
    id: string;
    name: string;
    preferred_name?: string | null;
    date_of_birth: string;
  }[]) {
    const parts = r.date_of_birth.split("-");
    if (parts.length !== 3) continue;
    const month = parseInt(parts[1], 10);
    const day = parseInt(parts[2], 10);
    if (!Number.isFinite(month) || !Number.isFinite(day)) continue;
    if (month !== monthInStudioTz) continue;
    out.push({ id: r.id, name: clientDisplayName(r), month, day });
  }
  // Sort by day-of-month, then DISPLAY name, then id (a total, stable order), so
  // earliest-upcoming birthdays appear first.
  out.sort(
    (a, b) =>
      a.day - b.day ||
      a.name.localeCompare(b.name) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return out;
}
