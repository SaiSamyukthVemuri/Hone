// ===========================================================================
// EXPORT QUERY PROVENANCE — the select that ran, and the rows it produced
// ===========================================================================
//
// Two Codex P2s on 327b3487, and they are one problem seen from two ends.
//
// CAPTURE THE FINAL SELECT. The previous design recorded the string handed to
// `exportSelect(resource, columns)` at the moment it was passed to `.select()`.
// That is not the selection PostgREST receives. postgrest-js writes `select`
// into the request URL and a LATER `.select()` on the same builder REPLACES it:
//
//     .select("id, name, email").select("id")   -> select=id
//
// so the recorder could hold `id,name,email` while the request asked for `id`,
// the audit stayed green and the CSV column came back blank. There is no longer
// a wrapper to desynchronise: the select is read OFF THE BUILT REQUEST, at
// execution, which is the only copy PostgREST can act on.
//
// BIND ROWS TO THE QUERY THAT PRODUCED THEM. `writeCsv(resource, rows)` took a
// bare array, so rows fetched for one resource could be serialized as another
// whenever the destination already had a recorded select. Rows now travel
// inside an envelope carrying the resource and the executed select, and the
// brand is a symbol, so a hand-built object cannot impersonate one.
//
// THE TWO HALVES REINFORCE EACH OTHER RATHER THAN DRIFTING. They are the same
// envelope: the audit reads its select, `writeCsv` reads its resource. There is
// no second map to fall out of step with the first, which is precisely how the
// earlier static declaration failed.
//
// PRIVILEGE. Like `paginate`, this module holds no Supabase client. It only
// observes a builder the caller already constructed.

import {
  fetchAllRows,
  type FetchAllRowsOptions,
  type PageFactory,
  type PageResult,
} from "./paginate";

// OPS-DAT-EXPORT-01: every exported read is boundary-checked. Its key defaults
// to `id`, which every exported resource selects and orders by last; a resource
// keyed otherwise (client_budget_context: client_id) passes its own `rowKey`.
function rowId<T>(row: T): string {
  return (row as { id?: string }).id as string;
}

/**
 * Runtime brand. A plain object literal cannot carry it, so `provenanceOf`
 * cannot be satisfied by rows that merely look right.
 */
export const EXPORT_PROVENANCE: unique symbol = Symbol("hone.export.provenance");

export type QueryProvenance = {
  /** The resource whose CSV these rows become. */
  readonly resource: string;
  /** The `select` parameter as it appeared on the executed request. */
  readonly select: string;
};

export type ExportRead<T> = PageResult<T> & {
  readonly [EXPORT_PROVENANCE]: QueryProvenance;
};

/**
 * The `select` on a built postgrest-js request, or null when it cannot be read.
 *
 * Deliberately defensive: an unreadable request must FAIL CLOSED at the caller
 * rather than silently audit as "selected nothing".
 */
export function readFinalSelect(page: unknown): string | null {
  const url = (page as { url?: unknown } | null | undefined)?.url;
  if (!url || typeof url !== "object") return null;
  const params = (url as { searchParams?: unknown }).searchParams;
  if (!params || typeof (params as URLSearchParams).get !== "function") return null;
  return (params as URLSearchParams).get("select");
}

function brand<T>(result: PageResult<T>, provenance: QueryProvenance): ExportRead<T> {
  return Object.defineProperty({ ...result }, EXPORT_PROVENANCE, {
    value: provenance,
    enumerable: false,
    writable: false,
    configurable: false,
  }) as ExportRead<T>;
}

/**
 * Read every row for `resource`, capturing the select actually sent.
 *
 * Every page is observed, not only the first: a factory whose selection varies
 * by page would otherwise let page 1 satisfy the audit while later pages
 * fetched something narrower.
 */
export async function fetchExportRows<T>(
  resource: string,
  makePage: PageFactory<T>,
  opts: FetchAllRowsOptions<T> = {},
): Promise<ExportRead<T>> {
  let observed: string | null = null;
  let disagreement: string | null = null;
  let unreadable = false;

  const observedPage: PageFactory<T> = (from, to) => {
    const page = makePage(from, to);
    const select = readFinalSelect(page);
    if (select === null) {
      unreadable = true;
    } else if (observed === null) {
      observed = select;
    } else if (observed !== select) {
      disagreement ??= `page selects disagree: "${observed}" then "${select}"`;
    }
    return page;
  };

  const result = await fetchAllRows<T>(observedPage, {
    ...opts,
    rowKey: opts.rowKey ?? rowId,
  });

  if (unreadable || observed === null) {
    return brand(
      {
        data: null,
        error: {
          message: `export: could not read the executed SELECT for "${resource}"; refusing to audit a query it cannot see`,
        },
      },
      { resource, select: "" },
    );
  }
  if (disagreement) {
    return brand(
      { data: null, error: { message: `export: ${resource} ${disagreement}` } },
      { resource, select: observed },
    );
  }
  return brand(result, { resource, select: observed });
}

// ---------------------------------------------------------------------------
// THE RPC SOURCE KIND
// ---------------------------------------------------------------------------
//
// Some studio-owned data lives in a table that no browser role may read (RLS on, no policy), so the owner's export cannot SELECT it. Its owner-gated
// export function is the only door. There is no `select` on such a request to read back, so the evidence is different but the rule is the same:
// the columns the function actually RETURNED are compared with the columns the registry declares it returns, in BOTH directions, row by row, and
// that observed list is what the registry audit sees. A function that grows a column nobody declared, or loses one the CSV needs, fails the export
// rather than shipping a blank or an unexplained cell.
//
// Paging is keyset: each call passes the last key it saw and the loop stops at the first SHORT page. A key that does not strictly increase, or a
// page budget that runs out, is a refusal ("refusing to return a partial table"), never a silent truncation.

export type RpcPageFactory<T> = (afterId: string | null, limit: number) => PromiseLike<PageResult<T>>;

export type RpcSourceSpec = {
  /** The column the function pages by, ascending. */
  readonly keyColumn: string;
  /** The columns the function is declared to return, exactly. */
  readonly returns: readonly string[];
};

export const EXPORT_RPC_PAGE_LIMIT = 1000;
const MAX_RPC_PAGES = 10_000;

export async function fetchExportRpcRows<T extends Record<string, unknown>>(
  resource: string,
  source: RpcSourceSpec,
  call: RpcPageFactory<T>,
  limit: number = EXPORT_RPC_PAGE_LIMIT,
): Promise<ExportRead<T>> {
  const select = source.returns.join(", ");
  const fail = (message: string): ExportRead<T> =>
    brand<T>({ data: null, error: { message: `export: ${resource} ${message}` } }, { resource, select });
  const declared = new Set(source.returns);
  if (!declared.has(source.keyColumn)) return fail(`declares key column "${source.keyColumn}" that it does not return`);

  const rows: T[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_RPC_PAGES; page += 1) {
    let result: PageResult<T>;
    try {
      result = await call(after, limit);
    } catch {
      return fail("read failed");
    }
    if (result.error) return fail(`read failed: ${result.error.message}`);
    if (!Array.isArray(result.data)) return fail("read returned no data");
    for (const row of result.data) {
      const keys = new Set(Object.keys(row));
      const missing = source.returns.filter((c) => !keys.has(c));
      const extra = [...keys].filter((c) => !declared.has(c));
      if (missing.length > 0) return fail(`function did not return declared column(s): ${missing.join(", ")}`);
      if (extra.length > 0) return fail(`function returned undeclared column(s): ${extra.join(", ")}`);
      const key = row[source.keyColumn];
      if (typeof key !== "string" || key.length === 0) return fail(`row has no usable ${source.keyColumn}`);
      if (after !== null && key <= after && rows.length > 0 && rows[rows.length - 1][source.keyColumn] !== undefined) {
        const prev = rows[rows.length - 1][source.keyColumn] as string;
        if (key <= prev) return fail(`${source.keyColumn} did not increase between rows (refusing to return a partial table)`);
      }
      rows.push(row);
    }
    if (result.data.length < limit) return brand<T>({ data: rows, error: null }, { resource, select });
    const last = result.data[result.data.length - 1][source.keyColumn] as string;
    if (after !== null && last <= after) return fail(`${source.keyColumn} did not advance between pages (refusing to return a partial table)`);
    after = last;
  }
  return fail("exceeded the page budget (refusing to return a partial table)");
}

/**
 * Transform the rows while keeping the envelope. The export joins display names
 * onto several resources between reading and writing; without this the
 * provenance would be dropped at exactly the step that makes a swap plausible.
 */
export function mapExportRows<A, B>(
  read: ExportRead<A>,
  fn: (rows: A[]) => B[],
): ExportRead<B> {
  const provenance = read[EXPORT_PROVENANCE];
  return brand<B>(
    { data: read.data === null ? null : fn(read.data), error: read.error },
    provenance,
  );
}

/**
 * The rows an envelope carries, but ONLY for the resource that produced them.
 *
 * This is the function `writeCsv` calls, so a test that exercises it is
 * exercising the real write-side guard rather than a restatement of it.
 */
export function rowsForResource<T>(resource: string, read: ExportRead<T>): T[] {
  const provenance = provenanceOf(read);
  if (!provenance) {
    throw new Error(
      `export: rows written as ${resource} carry no query provenance, so they cannot be attributed to a query`,
    );
  }
  if (provenance.resource !== resource) {
    throw new Error(
      `export: rows produced for ${provenance.resource} cannot be written as ${resource}`,
    );
  }
  return read.data ?? [];
}

/** The provenance carried by a value, or null if it carries none. */
export function provenanceOf(value: unknown): QueryProvenance | null {
  if (value === null || typeof value !== "object") return null;
  const provenance = (value as Record<symbol, unknown>)[EXPORT_PROVENANCE];
  if (!provenance || typeof provenance !== "object") return null;
  const { resource, select } = provenance as Partial<QueryProvenance>;
  if (typeof resource !== "string" || typeof select !== "string") return null;
  return { resource, select };
}

/**
 * The executed selects, keyed by resource, in the shape the registry audit
 * consumes. Built from the envelopes themselves, so a resource that was never
 * read simply has no entry and the audit refuses on the absence.
 */
export function selectedColumnsByResource(
  reads: ReadonlyArray<ExportRead<unknown>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const read of reads) {
    const { resource, select } = read[EXPORT_PROVENANCE];
    out[resource] = select
      .split(",")
      .map((column) => column.trim())
      .filter((column) => column.length > 0);
  }
  return out;
}
