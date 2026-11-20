import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { NameLookup } from "../named-clients";

// ===========================================================================
// Display names for the named lists. OWNER-ONLY (the caller has already refused everyone else), STUDIO-SCOPED, NAMES ONLY.
// ===========================================================================
//
// It asks for exactly the clients the period's own visits named, in this studio, and only the id and the display name. A client who is ARCHIVED is excluded
// IN THE QUERY, so an excluded client's name is never fetched at all; the model then leaves out anyone the query did not return, or whose name is blank.
// The schema has no erased or anonymised marker on a client today (erasure is handled case by case, and nothing is purged), so archived is the only
// removal flag there is. When a marker is added it belongs here, in the query, and a test must pin it.
//
// A failed read is a failed lookup, never an empty one: the lists say they are not available and every total is unaffected.

/** Ids per request. Small enough to keep the request line short and far under the API's 1000-row cap. */
export const NAME_CHUNK = 150;
/** Requests in flight at once. */
const PARALLEL = 4;

export async function readClientNames(supabase: SupabaseClient, studioId: string, clientIds: readonly string[]): Promise<NameLookup> {
  const ids = [...new Set(clientIds)];
  const names = new Map<string, string>();
  if (ids.length === 0) return { ok: true, names };
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += NAME_CHUNK) chunks.push(ids.slice(i, i + NAME_CHUNK));
  for (let i = 0; i < chunks.length; i += PARALLEL) {
    const results = await Promise.all(
      chunks.slice(i, i + PARALLEL).map((chunk) => supabase.from("clients").select("id, name").eq("studio_id", studioId).is("archived_at", null).in("id", chunk)),
    );
    for (const r of results) {
      if (r.error || !r.data) return { ok: false };
      for (const row of r.data as Array<{ id: string; name: string | null }>) if (typeof row.name === "string") names.set(row.id, row.name);
    }
  }
  return { ok: true, names };
}
