// The contact details on the owner's "replies to review" card.
//
// OWNER ONLY, and only ever called from the owner-gated replies page AFTER its owner check. It reads the
// linked waitlist ENTRY's email and phone through the signed-in owner's own session client, so the existing
// row-level security decides what is visible; nothing here uses the service role and no policy is widened.
// The join is by ENTRY ID. Two people with the same name are two entries and never share a card's contact.
// Nothing here writes, sends, or marks a reply handled, and nothing logs a row or an error body.
import { createClient } from "@/lib/supabase/server";

export type ReplyContact =
  | { kind: "entry"; email: string | null; phone: string | null }
  | { kind: "gone" };

export type ReplyContactMap = { kind: "unknown" } | { kind: "ok"; byEntry: ReadonlyMap<string, ReplyContact> };

const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Pure: turns the rows read for the listed entry ids into a per-entry answer. An id with no row is "gone". */
export function contactsFromRows(entryIds: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): ReplyContactMap {
  const found = new Map<string, ReplyContact>();
  for (const r of rows) {
    if (typeof r.id !== "string") continue;
    found.set(r.id, { kind: "entry", email: clean(r.email), phone: clean(r.phone) });
  }
  const byEntry = new Map<string, ReplyContact>();
  for (const id of entryIds) byEntry.set(id, found.get(id) ?? { kind: "gone" });
  return { kind: "ok", byEntry };
}

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

/** A mailto: href that cannot carry anything but the address. */
export function mailtoHref(email: string): string {
  return `mailto:${encodeURIComponent(email).replace(/%40/g, "@")}`;
}

/** A tel: href with only digits and a leading plus; null when nothing dialable is left. */
export function telHref(phone: string): string | null {
  const digits = phone.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  return /\d/.test(digits) ? `tel:${digits}` : null;
}
