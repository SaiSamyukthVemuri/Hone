// CLIENTS DIRECTORY SEARCH. What it searches, so a match is always explainable
// (Privacy S8): the NAME SHOWN on the row, the EMAIL shown and the PHONE shown.
// Nothing else: not the stored name behind a preferred name, not any legal
// identity, not pronouns. The fields come from `directory-rules.ts`, which is the
// same definition that decides what the row renders (S1).
//
// MATCHING (documented, deliberately narrower than the older shared matcher, and
// importing none of its helpers: Privacy S2):
//   name   the query is split into words after folding (case, accents and
//          punctuation removed); EVERY word must appear inside the folded
//          displayed name, in any order. "mit" finds "Smith"; "smith jane" finds
//          "Jane Smith". There is no join-across-spaces fallback, so a match can
//          never span two separate fields.
//   email  case-insensitive substring of the displayed email.
//   phone  a phone-shaped query (digits, spaces, + ( ) . -, at least 3 digits) is
//          compared as DIGITS ONLY against the displayed phone, with a leading
//          North American 1 ignored; a query that is not phone-shaped never
//          matches a phone.
//
// Pure. It never logs and never echoes a term.

import { foldForSearch } from "@/lib/clients/name-search";

export const MAX_DIRECTORY_QUERY_LENGTH = 80;
const MIN_PHONE_DIGITS = 3;
const PHONE_SHAPED_RE = /^[\d\s()+.\-]+$/;

export type DirectorySearchable = {
  displayName: string;
  email: string | null;
  phone: string | null;
};

/** Trim and bound the typed term. */
export function normalizeDirectoryQuery(raw: string | null | undefined): string {
  return (raw ?? "").trim().slice(0, MAX_DIRECTORY_QUERY_LENGTH);
}

function digitsOf(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

function nationalDigits(value: string | null | undefined): string {
  const digits = digitsOf(value);
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

function foldedWords(value: string): string[] {
  const folded = foldForSearch(value);
  return folded.length === 0 ? [] : folded.split(" ");
}

/** True when the row's SHOWN name, email or phone satisfies the query. An empty query matches every row. */
export function matchesDirectoryQuery(row: DirectorySearchable, rawQuery: string): boolean {
  const query = normalizeDirectoryQuery(rawQuery);
  if (query.length === 0) return true;

  const words = foldedWords(query);
  if (words.length > 0) {
    const shown = foldForSearch(row.displayName);
    if (shown.length > 0 && words.every((w) => shown.includes(w))) return true;
  }

  const lower = query.toLowerCase();
  if ((row.email ?? "").toLowerCase().includes(lower)) return true;

  if (PHONE_SHAPED_RE.test(query) && digitsOf(query).length >= MIN_PHONE_DIGITS) {
    const phone = row.phone ?? "";
    if (phone.length === 0) return false;
    return (
      digitsOf(phone).includes(digitsOf(query)) ||
      nationalDigits(phone).includes(nationalDigits(query))
    );
  }
  return false;
}

/** The sort key: the folded displayed name only (Privacy S4). */
export function directorySortKey(row: { displayName: string }): string {
  return foldForSearch(row.displayName);
}
