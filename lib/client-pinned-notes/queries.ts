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

// Latest pinned note per client, used for the compact dashboard roster
// indicator. Returns a Map keyed by client_id. Clients with no notes are
// absent from the Map.
export async function getLatestPinnedNoteByClient(
  studioId: string,
  clientIds: ReadonlyArray<string>,
): Promise<Map<string, ClientPinnedNote>> {
  const out = new Map<string, ClientPinnedNote>();
  if (clientIds.length === 0) return out;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("client_pinned_notes")
    .select("*")
    .eq("studio_id", studioId)
    .in("client_id", clientIds as string[])
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to load pinned notes: ${error.message}`);

  for (const row of (data ?? []) as ClientPinnedNote[]) {
    if (!out.has(row.client_id)) out.set(row.client_id, row);
  }
  return out;
}
