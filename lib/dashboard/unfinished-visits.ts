import { createClient } from "@/lib/supabase/server";
import { clientDisplayName } from "@/lib/clients/identity";
import { preferredNameColumn, readWithPreferredName } from "@/lib/clients/preferred-name-read";

// HON-45: PAST appointments that are still CONFIRMED and have a (non-deleted) session. Charting no longer completes an appointment,
// so each of these is open until the practitioner presses Finish. This module is the ONE definition used for the exact total on the
// dashboard and for the paginated "View all" list, so the count and the list can never disagree.
//
//   scope   studio-scoped, read with the caller's own session (RLS applies); another studio's visits are never counted or listed
//   order   most recently ended first, id as the tie-break: stable across pages, no gaps, no duplicates
//   window  none: an unfinished visit does not stop being unfinished after 30 days, so neither the count nor the list hides it
//   reads   only. It completes, sends and charges nothing.

export const UNFINISHED_PAGE_SIZE = 25;

export type UnfinishedVisitRow = {
  appointmentId: string;
  sessionId: string;
  clientId: string;
  clientName: string;
  startsAt: string;
  endsAt: string;
};

export type UnfinishedPage = {
  rows: UnfinishedVisitRow[];
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
};

type ApptRow = {
  id: string;
  client_id: string;
  starts_at: string;
  ends_at: string;
  client: { id: string; name: string | null; preferred_name?: string | null } | Array<{ id: string; name: string | null; preferred_name?: string | null }> | null;
  sessions: Array<{ id: string }> | { id: string } | null;
};

export function parseUnfinishedPage(raw: string | string[] | undefined): number {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100_000) : 1;
}

/** One page of unfinished visits plus the EXACT total (same query, same filters). Throws a fixed message on any failed read. */
export async function loadUnfinishedPage(studioId: string, nowIso: string, page: number): Promise<UnfinishedPage> {
  const supabase = await createClient();
  const from = (page - 1) * UNFINISHED_PAGE_SIZE;
  const { data, error, count } = await readWithPreferredName((withPreferred) =>
    supabase
      .from("appointments")
      .select(
        `id, client_id, starts_at, ends_at, client:clients!inner(id, name, ${preferredNameColumn(withPreferred)}archived_at), sessions!inner(id, studio_id, deleted_at)`,
        { count: "exact" },
      )
      .eq("studio_id", studioId)
      .eq("status", "confirmed")
      .lte("ends_at", nowIso)
      .is("client.archived_at", null)
      .eq("sessions.studio_id", studioId)
      .is("sessions.deleted_at", null)
      .order("ends_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + UNFINISHED_PAGE_SIZE - 1),
  );
  if (error || count == null) throw new Error("Failed to load unfinished visits");

  const rows: UnfinishedVisitRow[] = [];
  for (const a of (data ?? []) as unknown as ApptRow[]) {
    const sess = Array.isArray(a.sessions) ? (a.sessions[0] ?? null) : a.sessions;
    const client = Array.isArray(a.client) ? (a.client[0] ?? null) : a.client;
    if (!sess || !client) continue;
    rows.push({
      appointmentId: a.id,
      sessionId: sess.id,
      clientId: a.client_id,
      clientName: clientDisplayName(client),
      startsAt: a.starts_at,
      endsAt: a.ends_at,
    });
  }
  return { rows, total: count, page, pageCount: Math.max(1, Math.ceil(count / UNFINISHED_PAGE_SIZE)), pageSize: UNFINISHED_PAGE_SIZE };
}

/** The exact total only (a head count, no rows). Same filters as the list. Throws a fixed message on a failed read. */
export async function countUnfinishedVisits(studioId: string, nowIso: string): Promise<number> {
  const supabase = await createClient();
  const { error, count } = await supabase
    .from("appointments")
    .select("id, client:clients!inner(id), sessions!inner(id)", { count: "exact", head: true })
    .eq("studio_id", studioId)
    .eq("status", "confirmed")
    .lte("ends_at", nowIso)
    .is("client.archived_at", null)
    .eq("sessions.studio_id", studioId)
    .is("sessions.deleted_at", null);
  if (error || count == null) throw new Error("Failed to load unfinished visits");
  return count;
}

export const UNFINISHED_VIEW_ALL_HREF = "/dashboard/unfinished";
