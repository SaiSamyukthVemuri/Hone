import { escapeIlike } from "@/lib/search/global-search";

// Matching an address typed by a user against stored invitation / practitioner emails.
//
// `_` and `%` are ILIKE wildcards, and PostgREST ALSO rewrites `*` to `%` in like/ilike filters (probed live on the local stack, 7 Nov 2026:
// `email=ilike.b*@example.com` matched bob.jones@example.com and `*@example.com` matched every row). So the filter is only a candidate
// narrowing; the property that holds is the exact, lowercased comparison of the fetched rows against the typed address, in code.

/**
 * ILIKE pattern for the address: `\`, `%` and `_` escaped (literal), and each `*` emitted as an UNESCAPED `_`.
 *
 * Why: PostgREST rewrites `*` to `%` before Postgres sees the filter, and `\*` becomes `\%`, a literal percent that can never match a
 * stored `*` (probed live). So a real invite address containing `*` (the validators accept it) would be unfindable and that invitee could
 * not sign up. `_` is the single-character wildcard: it matches the literal `*` in the stored row and PostgREST never sees a `*`. The
 * candidate set can widen by one character position at most (a stored `bobXjones@` also matches a typed `bob*jones@`), and the exact,
 * lowercased compare below still decides, so only the identical address passes. Each `*` widens the pattern by one character position, so
 * a typed address with several `*` can match many more stored rows: the candidate page can fill, which the helpers below treat as
 * INCONCLUSIVE (fail closed) rather than as "no match".
 */
export function emailIlikePattern(email: string): string {
  return escapeIlike(email).replace(/\*/g, "_");
}

/** Bounded candidate fetch: `.limit(EMAIL_CANDIDATE_LIMIT)` after the ilike, then filter with the helpers below. */
export const EMAIL_CANDIDATE_LIMIT = 50;

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

/** A page of EMAIL_CANDIDATE_LIMIT rows may have cut off the real row (or a second exact one): it proves nothing about absence. */
export function isFullCandidatePage(rows: readonly unknown[] | null | undefined): boolean {
  return (rows?.length ?? 0) >= EMAIL_CANDIDATE_LIMIT;
}

export type EmailCandidateState = "match" | "none" | "inconclusive";

/** For "already a member / already invited" checks: an exact row is a match; otherwise a FULL page is inconclusive, never "none". */
export function emailCandidateState<T extends { email: string | null }>(rows: readonly T[] | null | undefined, typed: string): EmailCandidateState {
  if (hasExactEmailMatch(rows, typed)) return "match";
  return isFullCandidatePage(rows) ? "inconclusive" : "none";
}

/** The one exact-match row, or null when there are none or several (ambiguity fails closed). Used for the signup gate. */
export function singleExactEmailRow<T extends { email: string | null }>(rows: readonly T[] | null | undefined, typed: string): T | null {
  if (isFullCandidatePage(rows)) return null; // inconclusive: a second exact row could be hidden beyond the page
  const m = exactEmailRows(rows, typed);
  return m.length === 1 ? m[0] : null;
}
