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

/** One row to one hit, or null when the row is malformed. The single place a row's validity is decided. */
export function hitFromRow(r: Record<string, unknown>): SearchHit | null {
  if (typeof r.id !== "string" || typeof r.name !== "string" || typeof r.status !== "string") return null;
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    section: SECTION_OF_STATUS[r.status] ?? null,
    joinedAt: typeof r.joined_at === "string" ? r.joined_at : "",
  };
}

export function hitsFromRows(rows: ReadonlyArray<Record<string, unknown>>): SearchHit[] {
  return rows.flatMap((r) => {
    const h = hitFromRow(r);
    return h ? [h] : [];
  });
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

type RowWithTime = Record<string, unknown>;

/**
 * Merge the expired and the released entries into ONE list, newest outcome first, capped.
 * The time is the entry's own recorded outcome time for the state it is in now: `expired_at` for an expired entry, `released_at` for a
 * released one (a person's decline also releases the entry, so it is the decline time too). An entry whose time is missing sorts last.
 * `capped` is true when anything was left out, so the cut is always the OLDEST outcomes.
 */
export function mergeReleased(expiredRows: ReadonlyArray<RowWithTime>, releasedRows: ReadonlyArray<RowWithTime>, limit: number = RELEASED_LIMIT): { hits: SearchHit[]; capped: boolean } {
  // The hit and its time are produced from the SAME row, so a malformed row that is dropped cannot shift any later row's time.
  const withTime = (rows: ReadonlyArray<RowWithTime>, col: string) =>
    rows.flatMap((r) => {
      const h = hitFromRow(r);
      if (!h) return [];
      const t = typeof r[col] === "string" ? Date.parse(r[col] as string) : NaN;
      return [{ h, t: Number.isNaN(t) ? -Infinity : t }];
    });
  const all = [...withTime(expiredRows, "expired_at"), ...withTime(releasedRows, "released_at")];
  all.sort((a, b) => (b.t !== a.t ? (b.t > a.t ? 1 : -1) : a.h.id < b.h.id ? -1 : a.h.id > b.h.id ? 1 : 0));
  return { hits: all.slice(0, limit).map((x) => x.h), capped: all.length > limit };
}

/**
 * Entries whose status is expired or released, the MOST RECENT outcomes first, capped at RELEASED_LIMIT. Each state is read newest-first
 * with one extra row, so anything cut off is always older than everything shown. Read-only, owner session, studio-scoped.
 */
export async function listReleasedEntries(studioId: string): Promise<ReleasedList> {
  try {
    const supabase = await createClient();
    const read = (status: "expired" | "released", col: "expired_at" | "released_at") =>
      supabase
        .from("new_client_waitlist_entries")
        .select("id,name,status,joined_at,expired_at,released_at")
        .eq("studio_id", studioId)
        .eq("status", status)
        .order(col, { ascending: false })
        .order("id", { ascending: true })
        .limit(RELEASED_LIMIT + 1);
    const [expired, released] = await Promise.all([read("expired", "expired_at"), read("released", "released_at")]);
    if (expired.error || released.error || !Array.isArray(expired.data) || !Array.isArray(released.data)) return { kind: "unknown" };
    const merged = mergeReleased(expired.data as RowWithTime[], released.data as RowWithTime[]);
    return { kind: "ok", ...merged };
  } catch {
    return { kind: "unknown" };
  }
}
