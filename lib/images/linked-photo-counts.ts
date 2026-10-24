// HON-46 (photos, first slice). How many treatment photos are linked to each
// visit in a per-client procedure print, so the person preparing an insurer
// packet can see that evidence exists for the right visit before printing.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// ===========================================================================
// It never puts a photo, a signed URL, a storage path or a filename into the
// printout. HON-46 allows photos in output "only where intended and
// authorized", and whether a client's photo consent covers disclosure to an
// insurer is an open policy question. So the print shows the count on SCREEN
// only (the caller renders it print:hidden), and the printed document is
// unchanged. Inclusion waits for that ruling.
//
// The read uses the RLS client (createClient, not service-role): studio members already
// list these rows ("treatment_images: members select"), so no new authority
// is introduced. Rows are scoped by studio, client
// AND session, live rows only (deleted_at is the archive soft-delete), and
// paginated so the API row cap cannot silently shorten a count.

import { createClient } from "@/lib/supabase/server";

export type LinkedPhotoCounts =
  | { ok: true; bySession: ReadonlyMap<string, number> }
  | { ok: false };

type Row = { id?: string; session_id: string | null };

/** Pure: count rows per requested session; every requested session gets an entry. */
export function countLinkedPhotos(
  rows: ReadonlyArray<Row>,
  sessionIds: ReadonlyArray<string>,
): Map<string, number> {
  const wanted = new Set(sessionIds);
  const out = new Map<string, number>(sessionIds.map((id) => [id, 0]));
  for (const r of rows) {
    if (r.session_id && wanted.has(r.session_id)) {
      out.set(r.session_id, (out.get(r.session_id) ?? 0) + 1);
    }
  }
  return out;
}

// PostgREST caps every response at the API's max_rows (1000 in
// supabase/config.toml; the hosted value may differ). One unpaginated read
// would silently undercount a client with more linked photos than that, and
// still report ok. So rows are read in id order, and the cursor advances by
// the rows ACTUALLY returned: a server cap smaller than PAGE_SIZE shortens a
// page but cannot end the loop early. Only an empty page ends it.
export const LINKED_PHOTO_PAGE_SIZE = 1000;
// Past this many pages the count is reported as "could not be checked"
// rather than as a confident number.
export const LINKED_PHOTO_MAX_PAGES = 50;

/**
 * Linked-photo counts for one client's printed visits. A read failure is
 * `{ ok: false }`, never zeros: "no photos" and "could not check" must not
 * look the same.
 */
export async function loadLinkedPhotoCounts(
  studioId: string,
  clientId: string,
  sessionIds: ReadonlyArray<string>,
): Promise<LinkedPhotoCounts> {
  if (sessionIds.length === 0) return { ok: true, bySession: new Map() };
  const supabase = await createClient();
  const rows: Row[] = [];
  let offset = 0;
  for (let page = 0; page < LINKED_PHOTO_MAX_PAGES; page++) {
    const { data, error } = await supabase
      .from("treatment_images")
      .select("id, session_id")
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .in("session_id", [...sessionIds])
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .range(offset, offset + LINKED_PHOTO_PAGE_SIZE - 1);
    if (error || !data) return { ok: false };
    if (data.length === 0) {
      return { ok: true, bySession: countLinkedPhotos(rows, sessionIds) };
    }
    rows.push(...data);
    offset += data.length;
  }
  return { ok: false };
}

/** Screen-only copy for one visit. */
export function linkedPhotoLine(count: number | undefined): string {
  if (count === undefined) return "Linked photos could not be checked.";
  if (count === 0) return "No photos linked to this visit.";
  return `${count} ${count === 1 ? "photo is" : "photos are"} linked to this visit. Photos are not included in this printout.`;
}
