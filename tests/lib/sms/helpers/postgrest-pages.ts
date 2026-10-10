// ===========================================================================
// A fake PostgREST read, honest about the one thing the STOP reads depend on:
// every response carries AT MOST `cap` rows (the API's row limit, 1,000 on
// Hone's stacks), and a capped response is a plain 200 with no error.
//
// It honours exactly what a keyset reader sends: .select, .not(col, "is",
// null), .gt(col, value), .order(col), .limit(n) and .range(from, to). Any
// request can be made to fail. It cannot tell a paginated reader from a single
// read: it only answers what was asked.
//
// One `pagedSource` stands for one source (the `clients` table, or 0202's
// prospect-candidates command). `query()` starts one request; `requests`
// counts the requests it has answered, failures included.
// ===========================================================================

export type FakeRow = { id: string } & Record<string, unknown>;

export type PagedSource = {
  requests: number;
  query(): Record<string, unknown>;
};

export const POSTGREST_ROW_LIMIT = 1000;

export function pagedSource(
  rows: () => readonly FakeRow[],
  opts: { cap?: number; fail?: (requestIndex: number) => boolean; throws?: (requestIndex: number) => boolean } = {},
): PagedSource {
  const source: PagedSource = {
    requests: 0,
    query() {
      const q = {
        notNull: [] as string[],
        gt: [] as Array<[string, string]>,
        order: null as string | null,
        limit: null as number | null,
        range: null as [number, number] | null,
      };
      const b: Record<string, unknown> = {
        select: () => b,
        not: (col: string, op: string, value: unknown) => {
          if (op !== "is" || value !== null) throw new Error(`fake supports only not(col, "is", null), got ${op}`);
          q.notNull.push(col);
          return b;
        },
        gt: (col: string, value: string) => {
          q.gt.push([col, value]);
          return b;
        },
        order: (col: string) => {
          q.order = col;
          return b;
        },
        limit: (n: number) => {
          q.limit = n;
          return b;
        },
        range: (from: number, to: number) => {
          q.range = [from, to];
          return b;
        },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          const index = source.requests++;
          if (opts.throws?.(index)) return Promise.reject(new Error("socket hang up")).then(resolve, reject);
          if (opts.fail?.(index)) {
            return Promise.resolve({
              data: null,
              error: { code: "57014", message: "canceling statement due to statement timeout" },
            }).then(resolve, reject);
          }
          let out = rows().filter((r) => q.notNull.every((col) => r[col] !== null && r[col] !== undefined));
          out = out.filter((r) => q.gt.every(([col, value]) => String(r[col]) > value));
          if (q.order) {
            const col = q.order;
            out = [...out].sort((a, z) => (String(a[col]) < String(z[col]) ? -1 : String(a[col]) > String(z[col]) ? 1 : 0));
          }
          if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
          if (q.limit !== null) out = out.slice(0, q.limit);
          // The server's row limit, applied silently: no error, no hint.
          out = out.slice(0, opts.cap ?? POSTGREST_ROW_LIMIT);
          return Promise.resolve({ data: out, error: null }).then(resolve, reject);
        },
      };
      return b;
    },
  };
  return source;
}

/** A STOP candidate row, as both the `clients` read and 0202's command return it. */
export type CandidateRow = {
  id: string;
  studio_id: string;
  phone: string | null;
  sms_opted_out_at: string | null;
} & Record<string, unknown>;

/** `n` rows with zero-padded ids (so string order is id order) and distinct phones. */
export function candidateRows(
  n: number,
  prefix: string,
  base: { studio_id?: string; sms_opted_out_at?: string | null } = {},
  at: Record<number, Partial<CandidateRow>> = {},
): CandidateRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${String(i + 1).padStart(6, "0")}`,
    studio_id: base.studio_id ?? "studio-1",
    phone: `+1416${String(1000000 + i).slice(-7)}`,
    sms_opted_out_at: base.sms_opted_out_at === undefined ? "2026-09-01T10:00:00.000Z" : base.sms_opted_out_at,
    ...(at[i + 1] ?? {}),
  }));
}
