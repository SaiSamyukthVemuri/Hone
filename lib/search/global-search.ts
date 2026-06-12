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
export const SEARCH_TOTAL_CAP = 12;

// Display order. Clients first; page shortcuts always last.
export const GROUP_ORDER: ReadonlyArray<{
  type: SearchResultType;
  label: string;
}> = [
  { type: "client", label: "Clients" },
  { type: "appointment", label: "Appointments" },
  { type: "memory", label: "Treatment Memory" },
  { type: "record", label: "Records" },
  { type: "page", label: "Pages" },
];

// Escape ILIKE metacharacters so a typed % or _ is literal (same
// convention as the record-keeping lot search).
export function escapeIlike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function sanitizeQuery(raw: string): string {
  return raw.trim().slice(0, SEARCH_MAX_QUERY_LENGTH);
}

// Static page shortcuts: search stays useful before data exists.
// Exposure Incidents is deliberately NOT a shortcut (owner-only
// surface; global search must not advertise it).
const PAGE_SHORTCUTS: ReadonlyArray<{ title: string; href: string }> = [
  { title: "Dashboard", href: "/dashboard" },
  { title: "Clients", href: "/clients" },
  { title: "Calendar", href: "/calendar" },
  { title: "Records", href: "/records" },
  { title: "Settings", href: "/settings/profile" },
  { title: "Getting Started", href: "/getting-started" },
];

export function filterPageShortcuts(query: string): SearchResult[] {
  const q = query.trim().toLowerCase();
  return PAGE_SHORTCUTS.filter(
    (p) => q.length === 0 || p.title.toLowerCase().includes(q),
  ).map((p) => ({
    id: `page:${p.href}`,
    type: "page" as const,
    title: p.title,
    subtitle: "Go to page",
    href: p.href,
  }));
}

// Group flat results in display order and apply the global cap,
// preserving the per-category ranking the action established.
export function groupResults(results: SearchResult[]): SearchGroup[] {
  const capped = results.slice(0, SEARCH_TOTAL_CAP);
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
