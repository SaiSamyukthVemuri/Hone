// Complete, page-safe reads for the studio data export.
//
// WHY THIS EXISTS. PostgREST caps every response at `max_rows`
// (supabase/config.toml: 1000). The export issued plain unbounded selects, so
// any studio table past 1000 visible rows was silently truncated: the ZIP
// still built, still looked complete, and still said "export everything". A
// truncated-but-plausible backup is worse than a failed one, because nobody
// goes looking for the missing half.
//
// It was also AMPLIFYING: `electrolysis_entries` and `laser_entries` are
// filtered against the set of session ids that came back from the sessions
// read. Truncate sessions at 1000 and every child row belonging to session
// 1001+ is dropped from the export as well: a parent-page boundary silently
// deleting child clinical rows.
//
// WHAT THIS IS NOT. Even complete, the ZIP is a portable copy of supported
// studio records, not a transactional database backup: the tables are read
// independently, not in one snapshot. That is stated in the product copy and
// in the ZIP's own README, and it is why this module is called `paginate`
// rather than `backup`.
//
// DETERMINISM. Keyset ordering is not enough on its own: an `order("name")` or
// `order("created_at")` whose values repeat has no defined order WITHIN a tie,
// so the same row can appear on two pages or on none. Every caller therefore
// appends `id` as a final tiebreak, and `assertDeterministicOrder` below makes
// that a checked contract rather than a convention.
//
// PRIVILEGE. This module holds no Supabase client of its own. The caller passes
// a page factory built from the request's RLS-scoped authenticated client, so
// pagination cannot widen what the export can see. Nothing here may import an
// admin/service-role client.

// PostgREST's cap. Requesting a wider range than the server allows just gets
// silently clamped, so the page size must match the server's own limit.
export const EXPORT_PAGE_SIZE = 1000;

// A hard stop so a pathological table (or a caller whose ordering is
// non-deterministic enough to never converge) cannot spin forever inside a
// server action. 500 pages x 1000 rows = 500k rows per table.
export const EXPORT_MAX_PAGES = 500;

export type PageResult<T> = {
  data: T[] | null;
  error: { message: string } | null;
};

// The caller supplies a FACTORY, not a builder: a Supabase query builder is
// single-use, so each page needs a freshly constructed query with its own
// `.range()`.
export type PageFactory<T> = (from: number, to: number) => PromiseLike<PageResult<T>>;

/**
 * Read every row a query can see, one `EXPORT_PAGE_SIZE` page at a time.
 *
 * Returns the SAME shape as a single Supabase result so call sites keep their
 * existing `{ data, error }` handling, including the export's all-or-nothing
 * error check. A failure on page 7 fails the whole read; it never returns the
 * first six pages as if they were the table.
 */
export async function fetchAllRows<T>(
  makePage: PageFactory<T>,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<PageResult<T>> {
  const pageSize = opts.pageSize ?? EXPORT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? EXPORT_MAX_PAGES;
  const all: T[] = [];

  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const { data, error } = await makePage(from, from + pageSize - 1);
    // Propagate verbatim. The export's own guard turns this into a refusal.
    if (error) return { data: null, error };
    const rows = data ?? [];
    all.push(...rows);
    // A short page is the end of the table. An exactly-full page is ambiguous,
    // so we ask again and stop on the empty page, one extra cheap request in
    // the exact-multiple case, never a dropped row.
    if (rows.length < pageSize) return { data: all, error: null };
  }

  // Refuse rather than return a silently capped set: the entire point.
  return {
    data: null,
    error: {
      message: `Export read exceeded ${maxPages} pages (${maxPages * pageSize} rows); refusing to return a partial table.`,
    },
  };
}

/**
 * Contract check for the ordering a paginated read depends on.
 *
 * Pagination over a non-unique sort is not "slightly wrong". It can duplicate
 * a row onto two pages and drop another entirely. Callers pass the ordered
 * column list; the last one must be the unique tiebreak.
 */
export function assertDeterministicOrder(
  table: string,
  orderedColumns: ReadonlyArray<string>,
  tiebreak = "id",
): void {
  if (orderedColumns[orderedColumns.length - 1] !== tiebreak) {
    throw new Error(
      `Export read of "${table}" paginates on a non-deterministic order ` +
        `[${orderedColumns.join(", ")}]; the final ordering column must be "${tiebreak}".`,
    );
  }
}
