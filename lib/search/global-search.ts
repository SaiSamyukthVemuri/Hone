// Global Search V1 (PR #232). Pure types + helpers shared by the
// server action and the header client component. No imports from
// server modules so the client bundle stays clean.
//
// Search posture (enforced in app/(app)/global-search-actions.ts and
// pinned in tests): authenticated practitioner only, current studio
// only, user-scoped Supabase client (RLS backstop), simple capped
// ILIKE queries. No AI, no embeddings, no external search service,
// no migration, no new index. Deliberately EXCLUDED from V1:
// exposure incident content, audit change payloads, payment
// internals, Stripe ids, and every raw token field.
//
// V2-A extends the "page" category from six hard-coded shortcuts to the
// permission-aware navigation/settings registry in
// lib/search/navigation-registry.ts. The registry is static product metadata
// with no database access, so the posture above is unchanged: a nav result
// can only ever point at a page the practitioner was already authorized to
// open.

export type SearchResultType =
  | "client"
  | "appointment"
  | "memory"
  | "record"
  | "page";

export type SearchResult = {
  id: string;
  type: SearchResultType;
  title: string;
  subtitle?: string;
  href: string;
  date?: string;
  badge?: string;
};

export type SearchGroup = {
  label: string;
  results: SearchResult[];
};

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_QUERY_LENGTH = 80;

/**
 * Cap on DATA results (clients, appointments, treatment memory, records).
 * Unchanged from V1.
 */
export const SEARCH_TOTAL_CAP = 12;

/**
 * Cap on NAVIGATION results (the settings/pages registry).
 *
 * Six, not four: the pre-typing state of the dropdown is the six default
 * shortcuts inherited from V1, and this cap is applied by groupResults on the
 * way to the screen. A cap below six would silently trim that state: the
 * component would render four of the six rows the action returned. Pinned by
 * tests/lib/search/navigation-registry.test.ts.
 *
 * Lives here rather than in navigation-registry.ts so the client component can
 * import it without pulling the registry, which is server-only precisely so a
 * non-owner's browser bundle never carries the titles of owner-only surfaces.
 */
export const NAV_RESULT_CAP = 6;

/**
 * Absolute cap on everything the dropdown can render.
 *
 * Navigation results are capped SEPARATELY (NAV_RESULT_CAP) and sit on top of
 * the data cap rather than competing for the same twelve slots. Two reasons:
 *   * a data-rich query must never lose a client result to a settings row,
 *     V1's categories are not allowed to degrade;
 *   * a settings-only query ("buffer", "photo consent") must never lose its
 *     answer to a wall of unrelated clients, which is exactly what happens
 *     when page shortcuts are appended last into a shared, already-full cap.
 * Both caps are constants, so the total is deterministic.
 */
export const SEARCH_RESULT_CAP = SEARCH_TOTAL_CAP + NAV_RESULT_CAP;

// Display order. Clients first; navigation/settings always last.
export const GROUP_ORDER: ReadonlyArray<{
  type: SearchResultType;
  label: string;
}> = [
  { type: "client", label: "Clients" },
  { type: "appointment", label: "Appointments" },
  { type: "memory", label: "Treatment Memory" },
  { type: "record", label: "Records" },
  // V2-A: the group is no longer "six page shortcuts". It is every settings
  // and navigation destination the practitioner is allowed to reach.
  { type: "page", label: "Settings & Pages" },
];

// Escape ILIKE metacharacters so a typed % or _ is literal (same
// convention as the record-keeping lot search).
export function escapeIlike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function sanitizeQuery(raw: string): string {
  return raw.trim().slice(0, SEARCH_MAX_QUERY_LENGTH);
}

// Apply the two independent caps. Data results keep the V1 budget; navigation
// results get their own, so neither category can starve the other. Order
// within each category is preserved exactly as the producer established it,
// which is what makes the capped output deterministic.
//
// Called by the server action (before returning) and again by groupResults
// (before rendering), capping is idempotent, and defining it once means the
// two can never disagree about what "capped" means.
export function capResults(results: SearchResult[]): SearchResult[] {
  const data: SearchResult[] = [];
  const nav: SearchResult[] = [];
  for (const r of results) {
    if (r.type === "page") {
      if (nav.length < NAV_RESULT_CAP) nav.push(r);
    } else if (data.length < SEARCH_TOTAL_CAP) {
      data.push(r);
    }
  }
  return [...data, ...nav];
}

// Group flat results in display order and apply the caps,
// preserving the per-category ranking the action established.
export function groupResults(results: SearchResult[]): SearchGroup[] {
  const capped = capResults(results);
  return GROUP_ORDER.map(({ type, label }) => ({
    label,
    results: capped.filter((r) => r.type === type),
  })).filter((g) => g.results.length > 0);
}

// Map a query like "no show" / "cancelled" to an appointment status
// so status text is searchable without free-text status columns.
export function statusForQuery(query: string): string | null {
  const q = query.trim().toLowerCase();
  if (q.length < SEARCH_MIN_CHARS) return null;
  if ("confirmed".startsWith(q)) return "confirmed";
  if ("completed".startsWith(q)) return "completed";
  if ("cancelled".startsWith(q) || "canceled".startsWith(q)) return "cancelled";
  if ("no show".startsWith(q) || "no-show".startsWith(q) || "no_show".startsWith(q))
    return "no_show";
  return null;
}
