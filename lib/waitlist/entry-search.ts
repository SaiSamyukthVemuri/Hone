import "server-only";
// Name search across the owner's waitlist entries: Active, Released and Archived. OWNER ONLY, read-only, through the owner's own
// session (RLS), scoped to the studio. Matches the NAME only, never contact details. Every result carries its own section label,
// derived from the entry's recorded status, so two people with one name stay two results.
import { createClient } from "@/lib/supabase/server";

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 60;
export const SEARCH_LIMIT = 50;

export type EntrySection = "Active" | "Released" | "Archived" | "Booked";

export const SECTION_OF_STATUS: Readonly<Record<string, EntrySection>> = {
  waiting: "Active",
  claimed: "Active",
  invited: "Active",
  expired: "Released",
  released: "Released",
  removed: "Archived",
  converted: "Booked",
};

/** Trim, collapse spaces, bound the length. Null when too short to search. */
export function normalizeQuery(raw: string | null | undefined): string | null {
  const q = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX);
  return q.length >= SEARCH_MIN ? q : null;
}

/** Escape LIKE wildcards so a typed % or _ is matched literally. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export type SearchHit = { id: string; name: string; status: string; section: EntrySection | null; joinedAt: string };
export type SearchResult = { kind: "unknown" } | { kind: "ok"; hits: SearchHit[]; capped: boolean };

export function hitsFromRows(rows: ReadonlyArray<Record<string, unknown>>): SearchHit[] {
  const out: SearchHit[] = [];
  for (const r of rows) {
    if (typeof r.id !== "string" || typeof r.name !== "string" || typeof r.status !== "string") continue;
    out.push({
      id: r.id,
      name: r.name,
      status: r.status,
      section: SECTION_OF_STATUS[r.status] ?? null,
      joinedAt: typeof r.joined_at === "string" ? r.joined_at : "",
    });
  }
  return out;
}

export async function searchWaitlistEntries(studioId: string, query: string): Promise<SearchResult> {
  try {
    const { data, error } = await (await createClient())
      .from("new_client_waitlist_entries")
      .select("id,name,status,joined_at")
      .eq("studio_id", studioId)
      .ilike("name", likePattern(query))
      .order("joined_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(SEARCH_LIMIT + 1);
    if (error || !Array.isArray(data)) return { kind: "unknown" };
    const hits = hitsFromRows(data as Array<Record<string, unknown>>);
    return { kind: "ok", hits: hits.slice(0, SEARCH_LIMIT), capped: hits.length > SEARCH_LIMIT };
  } catch {
    return { kind: "unknown" };
  }
}

export const RELEASED_LIMIT = 100;
export type ReleasedList = { kind: "unknown" } | { kind: "ok"; hits: SearchHit[]; capped: boolean };

/** Entries whose status is expired or released, oldest join first (the queue's own order). Read-only, owner session, studio-scoped. */
export async function listReleasedEntries(studioId: string): Promise<ReleasedList> {
  try {
    const { data, error } = await (await createClient())
      .from("new_client_waitlist_entries")
      .select("id,name,status,joined_at")
      .eq("studio_id", studioId)
      .in("status", ["expired", "released"])
      .order("joined_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(RELEASED_LIMIT + 1);
    if (error || !Array.isArray(data)) return { kind: "unknown" };
    const hits = hitsFromRows(data as Array<Record<string, unknown>>);
    return { kind: "ok", hits: hits.slice(0, RELEASED_LIMIT), capped: hits.length > RELEASED_LIMIT };
  } catch {
    return { kind: "unknown" };
  }
}
