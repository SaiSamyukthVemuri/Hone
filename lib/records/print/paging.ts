// HON-46 — read every page of a result, or fail closed.
//
// PostgREST caps a response at max_rows and still answers 200, so an unpaged
// read silently drops the rest of a clinical record. A packet must be complete
// or absent: a read that errors, stalls, or would need more than `maxPages`
// pages returns null, and the caller shows no record rather than a partial one.
//
// Keyset paging on id (not offset): an offset page skips or repeats rows when
// one is inserted or soft-deleted between reads.

export const PRINT_PAGE_SIZE = 1000;
export const PRINT_MAX_PAGES = 50;

export type PageResult<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

/**
 * `page(after)` must return rows ordered by id ascending, only ids greater than
 * `after` when it is set, at most `pageSize` rows. Returns null on error,
 * a non-advancing cursor, or saturation.
 */
export async function readAllPages<T extends { id: string }>(
  page: (after: string | null) => PageResult<T>,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<T[] | null> {
  const pageSize = opts.pageSize ?? PRINT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? PRINT_MAX_PAGES;
  const out: T[] = [];
  let after: string | null = null;
  for (let p = 0; p < maxPages; p += 1) {
    const { data, error } = await page(after);
    if (error || !data) return null;
    if (data.length > pageSize) return null;
    out.push(...data);
    if (data.length < pageSize) return out;
    const last: string = data[data.length - 1].id;
    if (after !== null && last <= after) return null;
    after = last;
  }
  return null;
}
