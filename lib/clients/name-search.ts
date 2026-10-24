// HON-58 — one client-search rule for every surface that finds a client.
//
// Before this, three matchers (components/client-search.tsx, the calendar's
// QuickBookDrawer and the global-search server action) each did a raw,
// case-insensitive substring over `clients.name`. That meant a stored
// "Jane (Janie) Smith" was found by "janie smith" only if the parentheses
// were typed too, "Smith, Jane" was not found by "jane smith", and
// "O'Brien", "Mary-Kate" and "José" were not found by "obrien", "mary kate"
// and "jose".
//
// The rule here is a SUPERSET of the old one for names (the compact substring
// check below still finds "mit" in "Smith"), plus:
//   - case, diacritics, spacing and punctuation are folded away;
//   - every query word may match the START of any name word, in any order, so
//     a surname alone, a preferred name alone, or "smith jane" all find the
//     record, with no parentheses and no exact display string;
//   - a phone-shaped query matches the phone's digits whatever its formatting.
//
// Pure and isomorphic: it runs in client components and in the server action.
// It never logs, and it is a pure function of its inputs.

/** Apostrophes join their neighbours ("O'Brien" -> "obrien") instead of splitting them. */
const APOSTROPHES_RE = /['‘’ʼ`]/g;
const COMBINING_MARKS_RE = /\p{M}+/gu;
const NON_WORD_RE = /[^\p{L}\p{N}]+/gu;
const PHONE_SHAPED_RE = /^[\d\s()+.\-]+$/;

/** Fewest digits a phone-shaped query needs before it is matched as a phone. */
const MIN_PHONE_DIGITS = 3;

/**
 * Fold a name or query to its searchable words: lowercase, no diacritics, no
 * punctuation, single spaces. `"  José  O'Brien-Smith "` -> `"jose obrien smith"`.
 */
export function foldForSearch(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(COMBINING_MARKS_RE, "")
    .toLowerCase()
    .replace(APOSTROPHES_RE, "")
    .replace(NON_WORD_RE, " ")
    .trim();
}

export function searchTokens(value: string | null | undefined): string[] {
  const folded = foldForSearch(value);
  return folded.length === 0 ? [] : folded.split(" ");
}

function digitsOf(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

function isPhoneShaped(query: string): boolean {
  return PHONE_SHAPED_RE.test(query) && digitsOf(query).length >= MIN_PHONE_DIGITS;
}

/** The fields a client search reads. Extra fields are ignored. */
export type SearchableClient = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
};

/** True when the name alone satisfies the query. */
export function nameMatchesQuery(name: string | null | undefined, rawQuery: string): boolean {
  const queryTokens = searchTokens(rawQuery);
  if (queryTokens.length === 0) return false;
  const nameTokens = searchTokens(name);
  if (nameTokens.length === 0) return false;
  if (queryTokens.every((q) => nameTokens.some((n) => n.startsWith(q)))) return true;
  return nameTokens.join("").includes(queryTokens.join(""));
}

/**
 * The single client-search predicate: name (folded, any word order), email
 * (case-insensitive substring) or phone (raw substring, or digits for a
 * phone-shaped query). An empty query matches everything, as before.
 */
export function matchesClientSearch(client: SearchableClient, rawQuery: string): boolean {
  const query = rawQuery.trim();
  if (query.length === 0) return true;
  if (nameMatchesQuery(client.name, query)) return true;

  const lower = query.toLowerCase();
  if ((client.email ?? "").toLowerCase().includes(lower)) return true;
  if ((client.phone ?? "").toLowerCase().includes(lower)) return true;
  return isPhoneShaped(query) && digitsOf(client.phone).includes(digitsOf(query));
}

// ---------------------------------------------------------------------------
// Server prefilter. ILIKE cannot fold punctuation or reorder words, so the
// global-search action asks the database for a deliberately WIDE candidate set
// and then confirms each row with matchesClientSearch. The patterns are built
// only from folded [\p{L}\p{N}] characters, so nothing the practitioner typed
// can reach PostgREST as syntax (no comma, dot, parenthesis or backslash).
// ---------------------------------------------------------------------------

/** Letters that commonly carry a diacritic in a stored name: matched as `_`. */
const ACCENTABLE = new Set(["a", "c", "e", "i", "n", "o", "u", "y"]);

/**
 * One ILIKE pattern per query word, to be AND-ed on `name`. Each word becomes
 * an in-order subsequence (`obrien` -> `%_%b%r%_%_%_%`), which admits
 * "O'Brien" and "O Brien". Accentable letters become `_` so "jose" admits
 * "José". Over-matching is expected: matchesClientSearch makes the decision.
 */
export function nameCandidatePatterns(rawQuery: string): string[] {
  return searchTokens(rawQuery).map(
    (token) => `%${[...token].map((ch) => (ACCENTABLE.has(ch) ? "_" : ch)).join("%")}%`,
  );
}

/** The ILIKE pattern on `phone` for a phone-shaped query, else null. */
export function phoneCandidatePattern(rawQuery: string): string | null {
  const query = rawQuery.trim();
  if (!isPhoneShaped(query)) return null;
  return `%${[...digitsOf(query)].join("%")}%`;
}
