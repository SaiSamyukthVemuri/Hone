import { createClient } from "@/lib/supabase/server";
import { noteDraftsEnabledFor } from "./enabled";
import { sanitizeDraftFields } from "./sanitize";
import { NOTE_DRAFT_KINDS, type NoteDraftKind, type StoredNoteDraft } from "./types";

// HON-130: the page's one read of the caller's own autosaved drafts. A plain server module, NOT a server action: it is called by the client page
// with the studio the page already resolved, so it adds no identity lookup of its own and cannot be invoked from the browser. The studio only
// decides whether the switch is on; WHAT is returned is decided by row-level security (author-only), never by this argument.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The caller's own live drafts for one client (RLS is author-only; a cleared or NULL row reads as no draft). */
export async function loadNoteDrafts(clientId: string, studioId: string): Promise<StoredNoteDraft[]> {
  if (!UUID.test(clientId) || !noteDraftsEnabledFor(studioId)) return [];
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("client_note_drafts")
      .select("kind, target, fields, revision, updated_at, generation")
      .eq("client_id", clientId);
    if (error || !data) return [];
    const out: StoredNoteDraft[] = [];
    for (const r of data as Array<{ kind: NoteDraftKind; target: string; fields: unknown; revision: number; updated_at: string; generation: string | null }>) {
      if (!(NOTE_DRAFT_KINDS as readonly string[]).includes(r.kind)) continue;
      if (r.fields == null || !r.generation) continue; // NULL = cleared = no draft, no banner
      const fields = sanitizeDraftFields(r.kind, r.fields);
      if (!fields) continue;
      out.push({ key: { clientId, kind: r.kind, target: r.target }, fields, revision: r.revision, savedAt: r.updated_at, generation: r.generation });
    }
    return out;
  } catch {
    return [];
  }
}
