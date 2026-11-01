import { clientDisplayName } from "@/lib/clients/identity";
import { preferredNameColumn, readWithPreferredName } from "@/lib/clients/preferred-name-read";
import type { createClient } from "@/lib/supabase/server";
import {
  selectCurrentIntakeByClient,
  type TodayIntakeRow,
} from "@/lib/dashboard/today-intake";

// ===========================================================================
// Intakes awaiting review, PER CLIENT, by the canonical current-intake rule.
// ===========================================================================
//
// R3 (Insurance ruling, approved by OPS and Sam, 2026-10-31): THE ONE SANCTIONED
// METRIC CHANGE of the dashboard redesign.
//
// BEFORE: the dashboard counted every non-deleted `client_intake_forms` row whose
// status was `submitted`. A client with an older submitted form and a newer
// reissued form still in progress was counted, although the practitioner's
// review page (the canonical newest-row selection) shows the in-progress one.
//
// AFTER: a client counts when their NEWEST non-deleted intake row, by
// `created_at`, is `submitted`. The rule is `selectCurrentIntakeByClient`, the
// same one the Today roster and the review page use, so the dashboard can no
// longer disagree with the page its link opens.
//
// Nothing else about the dashboard's numbers changes.

export type IntakeAwaitingReview = {
  clientId: string;
  clientName: string;
  // created_at of the client's current (newest) submitted row.
  submittedAt: string;
};

// PURE. The clients whose current intake is `submitted`, newest first.
export function selectClientsAwaitingIntakeReview(
  rows: ReadonlyArray<TodayIntakeRow>,
): Array<{ clientId: string; submittedAt: string }> {
  const current = selectCurrentIntakeByClient(rows);
  const newestAt = new Map<string, string>();
  for (const row of rows) {
    const at = newestAt.get(row.client_id);
    if (at === undefined || row.created_at > at) {
      newestAt.set(row.client_id, row.created_at);
    }
  }
  const out: Array<{ clientId: string; submittedAt: string }> = [];
  for (const [clientId, status] of current) {
    if (status !== "submitted") continue;
    out.push({ clientId, submittedAt: newestAt.get(clientId) ?? "" });
  }
  return out.sort((a, b) =>
    a.submittedAt === b.submittedAt
      ? a.clientId < b.clientId
        ? -1
        : 1
      : a.submittedAt < b.submittedAt
        ? 1
        : -1,
  );
}

// PostgREST returns at most 1000 rows per request. A count built on a silently
// truncated read would be a wrong number shown as a right one, so the read pages
// and REFUSES (throws) rather than under-count once the ceiling is reached.
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

type Supabase = Awaited<ReturnType<typeof createClient>>;

export async function getIntakesAwaitingReview(
  supabase: Supabase,
  studioId: string,
): Promise<IntakeAwaitingReview[]> {
  const rows: TodayIntakeRow[] = [];
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) {
      // DAT-002 N2: a fixed message.
      throw new Error("Failed to count intakes awaiting review");
    }
    const { data, error } = await supabase
      .from("client_intake_forms")
      .select("client_id, status, created_at")
      .eq("studio_id", studioId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) throw new Error("Failed to count intakes awaiting review");
    const batch = (data ?? []) as TodayIntakeRow[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  const awaiting = selectClientsAwaitingIntakeReview(rows);
  if (awaiting.length === 0) return [];

  // Names are the staff-facing display name (preferred, else stored).
  const { data: clientRows, error: clientError } = await readWithPreferredName(
    (withPreferred) =>
      supabase
        .from("clients")
        .select(`id, name, ${preferredNameColumn(withPreferred)}archived_at`)
        .eq("studio_id", studioId)
        .in(
          "id",
          awaiting.map((a) => a.clientId),
        ),
  );
  if (clientError) throw new Error("Failed to count intakes awaiting review");
  const nameById = new Map<string, string>();
  for (const c of (clientRows ?? []) as unknown as Array<{
    id: string;
    name: string;
    preferred_name?: string | null;
    archived_at: string | null;
  }>) {
    nameById.set(c.id, clientDisplayName(c));
  }
  return awaiting.map((a) => ({
    clientId: a.clientId,
    clientName: nameById.get(a.clientId) ?? "Client",
    submittedAt: a.submittedAt,
  }));
}
