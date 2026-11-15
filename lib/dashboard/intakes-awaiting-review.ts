import { getClientDisplayNames } from "./client-display-names";
import { readIntakeStatusProjection } from "@/lib/intake/status-projection";
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
//
// TIES (Insurance B1): on an exact `created_at` tie the canonical single-client
// read (`order created_at desc limit 1`) picks arbitrarily; this helper keeps
// the first row in input order, and the loader feeds rows newest-first with the
// id as a deterministic secondary key. So the dashboard and the review page can
// differ only on an exact tie, which the canonical rule itself leaves undefined.
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

// BOUNDED READ (Insurance early review B2).
//
// The first version read EVERY non-deleted intake row of the studio. The count
// only ever needs clients that have a `submitted` form, so the read now goes in
// two steps and its size follows the number of SUBMITTED forms, not the studio's
// whole intake history:
//
//   1. the distinct clients with at least one non-deleted `submitted` row;
//   2. for just those clients (in chunks, so no URL grows without bound), all
//      their non-deleted rows, so the newest-row rule sees the reissue that
//      supersedes an older submitted form.
//
// A client with no submitted row can never be "awaiting review" under the newest
// rule, so skipping them cannot change the answer.
//
// PostgREST returns at most 1000 rows per request and the read must not
// under-count silently, so each step pages and REFUSES (throws) past its
// ceiling. The CALLER turns a refusal into an honest "unavailable" for this one
// count; it never takes down the rest of Needs attention.

type Supabase = Awaited<ReturnType<typeof createClient>>;

const REFUSAL = "Failed to count intakes awaiting review";

export async function getIntakesAwaitingReview(
  supabase: Supabase,
  studioId: string,
): Promise<IntakeAwaitingReview[]> {
  // ONE read of the 0334 status projection: the newest non-deleted form per client (status and created_at, never the answers). It returns zero
  // rows to a viewer who holds neither clin.view_intake_status nor clin.view_intake; the page decides restricted-versus-none before it calls this.
  const projected = await readIntakeStatusProjection(supabase, studioId);
  if (projected === null) throw new Error(REFUSAL);
  const rows: TodayIntakeRow[] = projected as TodayIntakeRow[];

  const awaiting = selectClientsAwaitingIntakeReview(rows);
  if (awaiting.length === 0) return [];

  // Names are the staff-facing display name (preferred, else stored).
  let nameById: Map<string, string>;
  try {
    nameById = await getClientDisplayNames(supabase, studioId, awaiting.map((a) => a.clientId));
  } catch {
    throw new Error(REFUSAL);
  }
  return awaiting.map((a) => ({
    clientId: a.clientId,
    clientName: nameById.get(a.clientId) ?? "Client",
    submittedAt: a.submittedAt,
  }));
}
