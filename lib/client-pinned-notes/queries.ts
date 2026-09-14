import { createClient } from "@/lib/supabase/server";
import {
  assertDeterministicOrder,
  fetchAllRows,
  EXPORT_PAGE_SIZE,
} from "@/lib/export/paginate";
import type { ClientPinnedNote } from "@/lib/types/database";

export async function getPinnedNotesForClient(
  studioId: string,
  clientId: string,
): Promise<ClientPinnedNote[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("client_pinned_notes")
    .select("*")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to load pinned notes: ${error.message}`);
  return (data ?? []) as ClientPinnedNote[];
}

// ALL pinned notes per client, newest first, for the dashboard roster.
//
// THIS REPLACED A LATEST-ONLY MODEL, AND THE REASON IS THE PRODUCT. The previous
// `getLatestPinnedNoteByClient` ran a single query and then kept only the first
// row per client, discarding the rest. A practitioner who pinned three notes saw
// one and had no way to know the others existed — pinning was silently a
// one-slot field. Chloe reported exactly that.
//
// IT IS PAGINATED, AND THAT IS NOT THEORETICAL. PostgREST caps every response at
// `max_rows` (supabase/config.toml: 1000). An unbounded select would have traded
// "only the newest note" for "only the first thousand notes" — the same silent
// loss, moved somewhere harder to notice, and biased: because the order is
// newest-first across ALL selected clients, the rows beyond the cap belong to
// whichever clients' notes happen to be oldest, so a client could vanish from
// the roster entirely rather than merely lose a note.
//
// DETERMINISM IS REQUIRED, NOT NICE. Paginating over `created_at` alone is not
// "slightly wrong": two notes sharing a timestamp have no defined order within
// the tie, so the same row can land on two pages while another is skipped. The
// order is therefore (created_at desc, id desc), and `assertDeterministicOrder`
// makes the tiebreak a checked contract rather than a convention.
//
// ALL-OR-NOTHING. `fetchAllRows` propagates a failed page verbatim instead of
// returning the pages it already had. A roster that quietly showed the first
// thousand notes and called itself complete is the defect this function exists
// to remove.
//
// STILL ONE READ PER ROSTER, NOT PER CLIENT. Paging is over the whole selected
// set — `in(client_id, …)` — so the request count follows the total number of
// notes, never the number of clients. Clients with no notes stay ABSENT from the
// Map, so callers keep treating "missing" as "nothing to show".
export async function getPinnedNotesByClient(
  studioId: string,
  clientIds: ReadonlyArray<string>,
): Promise<Map<string, ClientPinnedNote[]>> {
  const out = new Map<string, ClientPinnedNote[]>();
  if (clientIds.length === 0) return out;

  assertDeterministicOrder("client_pinned_notes", ["created_at", "id"]);

  const supabase = await createClient();
  const { data, error } = await fetchAllRows<ClientPinnedNote>((from, to) =>
    supabase
      .from("client_pinned_notes")
      .select("*")
      .eq("studio_id", studioId)
      .in("client_id", clientIds as string[])
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to),
  );
  if (error) throw new Error(`Failed to load pinned notes: ${error.message}`);

  // Already newest-first across every page, so pushing preserves that order
  // within each client without a second sort.
  for (const row of data ?? []) {
    const bucket = out.get(row.client_id);
    if (bucket) bucket.push(row);
    else out.set(row.client_id, [row]);
  }
  return out;
}

/** Re-exported so tests and callers can name the same page size the read uses. */
export const PINNED_NOTES_PAGE_SIZE = EXPORT_PAGE_SIZE;
