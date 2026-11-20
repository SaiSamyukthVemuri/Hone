import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { clientDisplayName } from "@/lib/clients/identity";
import { preferredNameColumn, readWithPreferredName } from "@/lib/clients/preferred-name-read";

import type { NameLookup } from "../named-clients";

// ===========================================================================
// Display names for the named lists. OWNER-ONLY (the caller has already refused everyone else), STUDIO-SCOPED, NAMES ONLY.
// ===========================================================================
//
// It asks for exactly the clients the period's own visits named, in this studio, and only the id and the name fields. A client who is ARCHIVED is excluded
// IN THE QUERY, so an excluded client's name is never fetched at all; the model then leaves out anyone the query did not return, or whose resulting name is
// blank.
//
// THE NAME SHOWN is the app's one rule (`clientDisplayName`): the preferred name when one is set, else the stored name. The legal name is never read here and
// never shown where a preferred one exists. A database that does not have the preferred-name column yet is read without it, exactly as the other
// surfaces do (`readWithPreferredName`), so the lists show the stored name until it exists.
//
// The schema has no erased or anonymised marker on a client today (erasure is handled case by case, and nothing is purged), so archived is the only
// removal flag there is. When a marker is added it belongs here, in the query, and a test must pin it.
//
// A failed read is a failed lookup, never an empty one: the lists say they are not available and every total is unaffected.

/** Ids per request. Small enough to keep the request line short and far under the API's 1000-row cap. */
export const NAME_CHUNK = 150;
/** Requests in flight at once. */
const PARALLEL = 4;

type NameRow = { id: string; name: string | null; preferred_name?: string | null };

export async function readClientNames(supabase: SupabaseClient, studioId: string, clientIds: readonly string[]): Promise<NameLookup> {
  const ids = [...new Set(clientIds)];
  const names = new Map<string, string>();
  if (ids.length === 0) return { ok: true, names };
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += NAME_CHUNK) chunks.push(ids.slice(i, i + NAME_CHUNK));
  for (let i = 0; i < chunks.length; i += PARALLEL) {
    const results = await Promise.all(
      chunks.slice(i, i + PARALLEL).map((chunk) =>
        readWithPreferredName((includePreferred) =>
          supabase.from("clients").select(`${preferredNameColumn(includePreferred)}id, name`).eq("studio_id", studioId).is("archived_at", null).in("id", chunk),
        ),
      ),
    );
    for (const r of results) {
      if (r.error || !r.data) return { ok: false };
      for (const row of r.data as unknown as NameRow[]) {
        const shown = clientDisplayName({ name: row.name, preferred_name: row.preferred_name });
        if (shown !== "") names.set(row.id, shown);
      }
    }
  }
  return { ok: true, names };
}
