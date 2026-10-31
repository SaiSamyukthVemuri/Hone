// CLIENTS DIRECTORY QUERY: search, filter, sort, count and page, all over the WHOLE
// authorized set, on the server, in one pure function (Plan: nothing client-side
// over a single page). The page hands it every row the viewer may see; it hands
// back ONE page and the count for exactly the set that produced it (Privacy S5).
//
// The set the count describes is the set the rows come from: search first (the
// shown name, email, phone only: directory-search.ts), then the filters, then the
// sort, then the slice. `total` is the size before the slice, so page boundaries,
// "N matches" and "no matches" vs "empty directory" depend on no hidden field.
//
// MISSING DATA IS NEVER A CLAIM. An aggregate (next appointment, intake status)
// that could not be read is `null`, which gives the explicit state "unavailable":
// never "Reviewed" and never "No upcoming appointment". A filter whose aggregate
// is unavailable is BLOCKED (reported, no rows) instead of silently ignored or
// answered from nothing.
//
// DEFINITIONS (reused, not invented):
//   next appointment  status confirmed and starts_at after now, earliest first;
//                     cancelled, no-show and completed are never upcoming.
//   intake            the canonical current intake per client (newest non-deleted
//                     form): submitted = awaiting review, reviewed = reviewed,
//                     in progress or no form = not submitted.

import { directorySortKey, matchesDirectoryQuery, normalizeDirectoryQuery } from "@/lib/clients/directory-search";
import type { DirectoryIdentityRow } from "@/lib/clients/directory-rules";

export const DIRECTORY_PAGE_SIZE = 25;

export type IntakeStatusValue = "in_progress" | "submitted" | "reviewed";
export type IntakeState = "not_submitted" | "awaiting_review" | "reviewed" | "unavailable";
export type NextAppointment =
  | { state: "scheduled"; startsAt: string }
  | { state: "none" }
  | { state: "unavailable" };

export type DirectoryFilter = "intake_review" | "no_upcoming";
export type DirectorySort = "name" | "next" | "archived";

export type DirectoryParams = {
  q: string;
  filters: DirectoryFilter[];
  sort: DirectorySort;
  page: number;
};

export type DirectoryAggregates = {
  /** client id -> earliest upcoming start; null when the read failed. */
  nextAppointments: ReadonlyMap<string, string> | null;
  /** client id -> canonical current intake status; null when the read failed. */
  intake: ReadonlyMap<string, IntakeStatusValue> | null;
};

export type DirectoryRow = DirectoryIdentityRow & {
  next: NextAppointment;
  intake: IntakeState;
};

export type DirectoryPage = {
  rows: DirectoryRow[];
  /** Size of the searched and filtered set (the count shown). */
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  /** 1-based inclusive range of the rows on this page; 0 when empty. */
  firstIndex: number;
  lastIndex: number;
  /** The viewer's whole set is empty (distinct from "no matches"). */
  directoryEmpty: boolean;
  /** Filters that could not be applied because their data was unavailable. */
  blockedFilters: DirectoryFilter[];
  /** The next-appointment sort was requested but its data is unavailable. */
  sortDegraded: boolean;
  nextUnavailable: boolean;
  intakeUnavailable: boolean;
};

const FILTERS: ReadonlyArray<DirectoryFilter> = ["intake_review", "no_upcoming"];

function one(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

export function parseDirectoryParams(
  sp: Record<string, string | string[] | undefined>,
  view: "active" | "archived" = "active",
): DirectoryParams {
  const q = normalizeDirectoryQuery(one(sp.q));
  const rawFilters = ([] as string[]).concat(sp.filter ?? []);
  const filters = FILTERS.filter((f) => rawFilters.includes(f));
  const rawSort = one(sp.sort);
  // Active: name (default) or next appointment. Archived: most recently archived (default) or name.
  const sort: DirectorySort =
    view === "archived"
      ? rawSort === "name" ? "name" : "archived"
      : rawSort === "next" ? "next" : "name";
  const n = Number.parseInt(one(sp.page) ?? "1", 10);
  const page = Number.isFinite(n) && n >= 1 ? Math.min(n, 100000) : 1;
  return { q, filters, sort, page };
}

function intakeState(status: IntakeStatusValue | undefined): IntakeState {
  if (status === "submitted") return "awaiting_review";
  if (status === "reviewed") return "reviewed";
  return "not_submitted";
}

function compareById(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Folded displayed name, then id (Privacy S4). */
function byName(a: DirectoryRow, b: DirectoryRow): number {
  const ka = directorySortKey(a);
  const kb = directorySortKey(b);
  return (ka < kb ? -1 : ka > kb ? 1 : 0) || compareById(a, b);
}

/** Attach the aggregates to the identity rows (the same construction the page uses for a selected client). */
export function buildDirectoryRows(
  source: ReadonlyArray<DirectoryIdentityRow>,
  aggregates: DirectoryAggregates,
): DirectoryRow[] {
  const nextUnavailable = aggregates.nextAppointments === null;
  const intakeUnavailable = aggregates.intake === null;
  return source.map((r) => {
    const startsAt = aggregates.nextAppointments?.get(r.id);
    return {
      ...r,
      next: nextUnavailable
        ? { state: "unavailable" }
        : startsAt
          ? { state: "scheduled", startsAt }
          : { state: "none" },
      intake: intakeUnavailable ? "unavailable" : intakeState(aggregates.intake?.get(r.id)),
    };
  });
}

export function queryDirectory(
  source: ReadonlyArray<DirectoryIdentityRow>,
  aggregates: DirectoryAggregates,
  params: DirectoryParams,
): DirectoryPage {
  const nextUnavailable = aggregates.nextAppointments === null;
  const intakeUnavailable = aggregates.intake === null;

  const rows = buildDirectoryRows(source, aggregates);

  const blockedFilters = params.filters.filter(
    (f) => (f === "no_upcoming" && nextUnavailable) || (f === "intake_review" && intakeUnavailable),
  );
  const sortDegraded = params.sort === "next" && nextUnavailable;

  const base = {
    page: 1,
    pageCount: 1,
    pageSize: DIRECTORY_PAGE_SIZE,
    firstIndex: 0,
    lastIndex: 0,
    directoryEmpty: source.length === 0,
    blockedFilters,
    sortDegraded,
    nextUnavailable,
    intakeUnavailable,
  };
  if (blockedFilters.length > 0) return { ...base, rows: [], total: 0 };

  let set = rows.filter((r) => matchesDirectoryQuery(r, params.q));
  if (params.filters.includes("intake_review")) set = set.filter((r) => r.intake === "awaiting_review");
  if (params.filters.includes("no_upcoming")) set = set.filter((r) => r.next.state === "none");

  if (params.sort === "next" && !nextUnavailable) {
    set.sort((a, b) => {
      const ta = a.next.state === "scheduled" ? a.next.startsAt : null;
      const tb = b.next.state === "scheduled" ? b.next.startsAt : null;
      if (ta !== null && tb !== null && ta !== tb) return ta < tb ? -1 : 1;
      if (ta !== null && tb === null) return -1;
      if (ta === null && tb !== null) return 1;
      return byName(a, b);
    });
  } else if (params.sort === "archived") {
    set.sort((a, b) => {
      const ta = a.archivedAt ? Date.parse(a.archivedAt) : 0;
      const tb = b.archivedAt ? Date.parse(b.archivedAt) : 0;
      return tb - ta || compareById(a, b);
    });
  } else {
    set.sort(byName);
  }

  const total = set.length;
  const pageCount = Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE));
  const page = Math.min(params.page, pageCount);
  const start = (page - 1) * DIRECTORY_PAGE_SIZE;
  const slice = set.slice(start, start + DIRECTORY_PAGE_SIZE);
  return {
    ...base,
    rows: slice,
    total,
    page,
    pageCount,
    firstIndex: slice.length === 0 ? 0 : start + 1,
    lastIndex: start + slice.length,
  };
}

/** The directory URL for a state, so every control and link carries it (search, filters, sort, page, view, selection). */
export function directoryHref(state: {
  view: "active" | "archived";
  q?: string;
  filters?: ReadonlyArray<DirectoryFilter>;
  sort?: DirectorySort;
  page?: number;
  client?: string;
}): string {
  const p = new URLSearchParams();
  if (state.view === "archived") p.set("view", "archived");
  if (state.q) p.set("q", state.q);
  for (const f of state.filters ?? []) p.append("filter", f);
  if (state.sort === "next") p.set("sort", "next");
  if (state.sort === "name" && state.view === "archived") p.set("sort", "name");
  if (state.page && state.page > 1) p.set("page", String(state.page));
  if (state.client) p.set("client", state.client);
  const qs = p.toString();
  return qs ? `/clients?${qs}` : "/clients";
}
