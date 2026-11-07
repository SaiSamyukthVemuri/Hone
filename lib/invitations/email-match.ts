import { escapeIlike } from "@/lib/search/global-search";

// Matching an address typed by a user against stored invitation / practitioner emails.
//
// `_` and `%` are ILIKE wildcards, and PostgREST ALSO rewrites `*` to `%` in like/ilike filters (probed live on the local stack, 7 Nov 2026:
// `email=ilike.b*@example.com` matched bob.jones@example.com and `*@example.com` matched every row). So the filter is only a candidate
// narrowing; the property that holds is the exact, lowercased comparison of the fetched rows against the typed address, in code.

/** ILIKE pattern for the address: `\`, `%` and `_` escaped, and `*` escaped too (PostgREST's alias for `%`). */
export function emailIlikePattern(email: string): string {
  return escapeIlike(email).replace(/\*/g, "\\*");
}

/** Bounded candidate fetch: `.limit(EMAIL_CANDIDATE_LIMIT)` after the ilike, then filter with the helpers below. */
export const EMAIL_CANDIDATE_LIMIT = 5;

const norm = (s: string) => s.trim().toLowerCase();

/** The fetched rows whose email EQUALS the typed address (case-insensitive, exact). Anything else is not a match. */
export function exactEmailRows<T extends { email: string | null }>(rows: readonly T[] | null | undefined, typed: string): T[] {
  const want = norm(typed);
  return (rows ?? []).filter((r) => typeof r.email === "string" && norm(r.email) === want);
}

/** True when at least one fetched row is an exact match (used for "already invited / already a member" refusals). */
export function hasExactEmailMatch<T extends { email: string | null }>(rows: readonly T[] | null | undefined, typed: string): boolean {
  return exactEmailRows(rows, typed).length > 0;
}

/** The one exact-match row, or null when there are none or several (ambiguity fails closed). Used for the signup gate. */
export function singleExactEmailRow<T extends { email: string | null }>(rows: readonly T[] | null | undefined, typed: string): T | null {
  const m = exactEmailRows(rows, typed);
  return m.length === 1 ? m[0] : null;
}
