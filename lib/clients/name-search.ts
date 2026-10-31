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

/**
 * Digits as compared for a phone match. A North American number is the same
 * number with or without its leading country code ("+1 416 555 0100" and
 * "416-555-0100"), so an 11-digit string starting with 1 is compared by its
 * ten national digits.
 */
export function nationalDigits(value: string | null | undefined): string {
  const digits = digitsOf(value);
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

function isPhoneShaped(query: string): boolean {
  return PHONE_SHAPED_RE.test(query) && digitsOf(query).length >= MIN_PHONE_DIGITS;
}

/**
 * The fields a client search reads. Extra fields are ignored. `preferred_name`
 * and the legal parts (HON-58) are matched only when the caller selected them,
 * so a surface that is not allowed legal identity never searches it.
 */
export type SearchableClient = {
  name?: string | null;
  preferred_name?: string | null;
  legal_given_name?: string | null;
  legal_middle_name?: string | null;
  legal_family_name?: string | null;
  /** The legal name as one string, for a surface that projects it that way. */
  legal_name?: string | null;
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
  // One identity, several names: the stored name, the preferred name and the
  // legal parts are searched as ONE word set, so "janie smith" finds a record
  // stored as "Jane Smith" with preferred name "Janie", and a legal surname
  // finds it too. With only `name` set this is exactly the old rule.
  const allNames = [
    client.name,
    client.preferred_name,
    client.legal_given_name,
    client.legal_middle_name,
    client.legal_family_name,
    client.legal_name,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
  if (nameMatchesQuery(allNames, query)) return true;

  const lower = query.toLowerCase();
  if ((client.email ?? "").toLowerCase().includes(lower)) return true;
  if ((client.phone ?? "").toLowerCase().includes(lower)) return true;
  if (!isPhoneShaped(query)) return false;
  return (
    digitsOf(client.phone).includes(digitsOf(query)) ||
    nationalDigits(client.phone).includes(nationalDigits(query))
  );
}

/**
 * Where a matching client sorts: lower is better. Exact name first, then a name
 * that starts with the query, then a word-start match, then the looser name
 * match, then email, then phone. Ties break by name, then id, so the order is
 * stable. Only meaningful for a client that matchesClientSearch accepted.
 */
export function clientMatchRank(client: SearchableClient, rawQuery: string): number {
  const query = foldForSearch(rawQuery);
  if (query.length === 0) return 0;
  const names = [client.name, client.preferred_name].map(foldForSearch).filter((n) => n.length > 0);
  if (names.some((n) => n === query)) return 0;
  if (names.some((n) => n.startsWith(query))) return 1;
  const tokens = searchTokens(rawQuery);
  if (names.some((n) => { const words = n.split(" "); return tokens.every((t) => words.some((w) => w.startsWith(t))); })) return 2;
  if (names.some((n) => nameMatchesQuery(n, rawQuery))) return 3;
  const lower = rawQuery.trim().toLowerCase();
  if ((client.email ?? "").toLowerCase().startsWith(lower)) return 4;
  if ((client.email ?? "").toLowerCase().includes(lower)) return 5;
  return 6;
}

/** Stable best-match-first order for a list of matches. */
export function sortByMatchRank<T extends SearchableClient & { id?: string }>(rows: readonly T[], rawQuery: string): T[] {
  return rows
    .map((row) => ({ row, rank: clientMatchRank(row, rawQuery) }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (a.row.name ?? "").localeCompare(b.row.name ?? "") ||
        (a.row.id ?? "").localeCompare(b.row.id ?? ""),
    )
    .map((x) => x.row);
}

// ---------------------------------------------------------------------------
// Server prefilter. ILIKE cannot fold punctuation, diacritics or word order, so
// the global-search action asks the database for a deliberately WIDE candidate
// set and then confirms each row with matchesClientSearch. The candidate set
// must be a SUPERSET of what the matcher accepts, or global search disagrees
// with the client list and the booking drawer (Codex P2 4366960916: wildcarding
// a few "accentable" letters missed "Šimon" and "Žaneta"). It is two reads:
//
//   - an ALL-ASCII name folds character by character to ASCII (lowercase,
//     apostrophes dropped, other punctuation a space), so every query word is
//     an in-order, case-insensitive subsequence of the stored name: the ILIKE
//     patterns below, built from literal letters and digits;
//   - any other name is a candidate whatever it contains (NON_ASCII_NAME_REGEX),
//     because one stored character can fold to a letter, to nothing ("´"), or
//     to several letters ("Ǆ" -> "dz").
//
// Nothing the practitioner typed reaches PostgREST as syntax: the patterns
// hold only folded [\p{L}\p{N}] characters, and the regex is a constant.
// ---------------------------------------------------------------------------

/** Matches a name with any character outside printable ASCII. A constant. */
export const NON_ASCII_NAME_REGEX = "[^ -~]";

/**
 * One ILIKE pattern per query word, to be AND-ed on `name`, admitting every
 * all-ASCII name the matcher can accept: each word becomes an in-order
 * subsequence (`obrien` -> `%o%b%r%i%e%n%`), which admits "O'Brien" and
 * "O Brien". Returns [] when a query word holds a non-ASCII letter (no
 * all-ASCII name can match it) or the query has no letters or digits.
 * Over-matching is expected: matchesClientSearch makes the decision.
 */
export function nameCandidatePatterns(rawQuery: string): string[] {
  const tokens = searchTokens(rawQuery);
  if (tokens.some((token) => /[^a-z0-9]/.test(token))) return [];
  return tokens.map((token) => `%${[...token].join("%")}%`);
}

/** True when the query has a word a name could match at all. */
export function hasNameQuery(rawQuery: string): boolean {
  return searchTokens(rawQuery).length > 0;
}

/** The ILIKE pattern on `phone` for a phone-shaped query, else null. */
export function phoneCandidatePattern(rawQuery: string): string | null {
  const query = rawQuery.trim();
  if (!isPhoneShaped(query)) return null;
  // National digits: a subsequence of them admits the stored number with or
  // without its leading country code, a superset of what the matcher accepts.
  return `%${[...nationalDigits(query)].join("%")}%`;
}
