// The contact details on the owner's waitlist response cards: the SESSION-SCOPED READ.
//
// SERVER ONLY, OWNER ONLY, and only ever called from an owner-gated page AFTER its owner check. It reads the linked waitlist ENTRY's
// email and phone through the signed-in owner's own session client, so the existing row-level security decides what is visible;
// nothing here uses the service role and no policy is widened. The join is by ENTRY ID. Two people with the same name are two
// entries and never share a card's contact. Nothing here writes, sends, or marks a response handled, and nothing logs a row or an
// error body. Client components must import the pure helpers from reply-contact-pure.ts, never this file.
import "server-only";
import { createClient } from "@/lib/supabase/server";
import { contactsFromRows, type ReplyContactMap } from "@/lib/waitlist/reply-contact-pure";

export async function loadReplyContacts(studioId: string, entryIds: readonly string[]): Promise<ReplyContactMap> {
  if (entryIds.length === 0) return { kind: "ok", byEntry: new Map() };
  try {
    const { data, error } = await (await createClient())
      .from("new_client_waitlist_entries")
      .select("id,email,phone")
      .eq("studio_id", studioId)
      .in("id", [...entryIds]);
    if (error || !Array.isArray(data)) return { kind: "unknown" };
    return contactsFromRows(entryIds, data as Array<Record<string, unknown>>);
  } catch {
    return { kind: "unknown" };
  }
}
