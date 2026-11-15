import { createClient } from "@/lib/supabase/server";

// Read-back of ONE entry's status through the signed-in owner's own session (RLS-scoped, SELECT only).
// Used when a lifecycle command's answer is uncertain (a transport error, an unmapped code), so the owner
// is told what the row actually is before any retry is offered. It never writes, and a failed read is
// reported as unknown rather than guessed.
export type EntryStatusReadback = { known: true; status: string | null } | { known: false };

export async function readEntryStatus(studioId: string, entryId: string): Promise<EntryStatusReadback> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("new_client_waitlist_entries")
      .select("status")
      .eq("studio_id", studioId)
      .eq("id", entryId)
      .maybeSingle();
    if (error) return { known: false };
    return { known: true, status: typeof data?.status === "string" ? data.status : null };
  } catch {
    return { known: false };
  }
}
