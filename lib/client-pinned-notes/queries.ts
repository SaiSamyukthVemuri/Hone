import { createClient } from "@/lib/supabase/server";
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
// `getLatestPinnedNoteByClient` ran this same single query and then kept only the
// first row per client, discarding the rest. A practitioner who pins three notes
// saw one and had no way to know the others existed — pinning was silently a
// one-slot field. Chloe reported exactly that.
//
// ONE studio-scoped query for every selected-day client: the grouping happens in
// memory, so adding clients or notes never adds a roundtrip. There is no LIMIT
// and no per-client cap — a cap here would recreate the same invisible loss in a
// less obvious place. Clients with no notes are ABSENT from the Map, so callers
// can keep treating "missing" as "nothing to show".
export async function getPinnedNotesByClient(
  studioId: string,
  clientIds: ReadonlyArray<string>,
): Promise<Map<string, ClientPinnedNote[]>> {
  const out = new Map<string, ClientPinnedNote[]>();
  if (clientIds.length === 0) return out;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("client_pinned_notes")
    .select("*")
    .eq("studio_id", studioId)
    .in("client_id", clientIds as string[])
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to load pinned notes: ${error.message}`);

  // The query is already newest-first, so pushing preserves that order within
  // each client without a second sort.
  for (const row of (data ?? []) as ClientPinnedNote[]) {
    const bucket = out.get(row.client_id);
    if (bucket) bucket.push(row);
    else out.set(row.client_id, [row]);
  }
  return out;
}
