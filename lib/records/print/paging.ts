// HON-46 — read every page of a result, or fail closed.
//
// PostgREST caps a response at max_rows and still answers 200, so an unpaged
// read silently drops the rest of a clinical record. A packet must be complete
// or absent: a read that errors, stalls, or would need more than `maxPages`
// pages returns null, and the caller shows no record rather than a partial one.
//
// Keyset paging on id (not offset): an offset page skips or repeats rows when
// one is inserted or soft-deleted between reads.
//
// ONLY AN EMPTY PAGE ENDS THE READ. A short page is NOT treated as the last one:
// if the server caps a response below `pageSize` (PostgREST max_rows), every full
// capped page looks short, and "short means last" would silently drop the rest of
// a clinical record behind a 200 (Insurance P-1). Completeness therefore does not
// depend on pageSize matching the server's cap; it costs one extra, empty read.

export const PRINT_PAGE_SIZE = 1000;
export const PRINT_MAX_PAGES = 50;

export type PageResult<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

/**
 * `page(after)` must return rows ordered by id ascending, only ids greater than
 * `after` when it is set, at most `pageSize` rows. Returns null on error, a
 * repeated or non-ascending id, an oversize page, or saturation.
 */
export async function readAllPages<T extends { id: string }>(
  page: (after: string | null) => PageResult<T>,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<T[] | null> {
  const pageSize = opts.pageSize ?? PRINT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? PRINT_MAX_PAGES;
  const out: T[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  for (let p = 0; p < maxPages; p += 1) {
    const { data, error } = await page(after);
    if (error || !data) return null;
    if (data.length > pageSize) return null;
    if (data.length === 0) return out;
    // Ids must be strictly ascending and never repeat, within and across pages,
    // or a misbehaving page function could print a treatment twice (Privacy Q-5).
    let prev: string | null = after;
    for (const row of data) {
      if (typeof row.id !== "string" || row.id.length === 0 || seen.has(row.id)) return null;
      if (prev !== null && row.id <= prev) return null;
      seen.add(row.id);
      prev = row.id;
    }
    out.push(...data);
    after = prev;
  }
  return null;
}
