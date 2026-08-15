// A PREDICATE-RECORDING Supabase stub for the internal booking action.
//
// Why not the usual chain stub. The common shape in this repo is
//
//   for (const m of ["select","eq","is",...]) b[m] = () => b;
//
// which discards every filter argument. Under that stub a query for
// practitioner A's availability and a query for practitioner B's are literally
// the same call, so any test claiming "target-specific hours are respected"
// passes without the code respecting anything. The same hazard bit a previous
// payment PR here, where `q.eq = chain` let a whole set of predicate assertions
// pass for free.
//
// This stub instead RECORDS every filter and hands the accumulated predicate
// list to a resolver, so a test can (a) return different rows for different
// predicates and (b) assert on what was actually asked.

export type Filter = { op: string; column: string; value: unknown };

export type Query = { table: string; filters: Filter[]; single: boolean };

export type Resolver = (q: Query) => { data: unknown; error: unknown };

export type RecordedRpc = { fn: string; args: Record<string, unknown> };

export function createBookingSupabaseMock(resolve: Resolver) {
  const queries: Query[] = [];

  function builder(table: string) {
    const q: Query = { table, filters: [], single: false };
    queries.push(q);
    const b: Record<string, unknown> = {};
    for (const op of ["eq", "is", "lt", "gt", "lte", "gte", "in", "neq"]) {
      b[op] = (column: string, value: unknown) => {
        q.filters.push({ op, column, value });
        return b;
      };
    }
    b.select = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.maybeSingle = () => {
      q.single = true;
      return Promise.resolve(resolve(q));
    };
    b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve(q)).then(onF, onR);
    return b;
  }

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: { from: (t: string) => builder(t) } as any,
    queries,
    /** Every filter recorded for a table, flattened. */
    filtersFor(table: string): Filter[] {
      return queries.filter((q) => q.table === table).flatMap((q) => q.filters);
    },
    queriesFor(table: string): Query[] {
      return queries.filter((q) => q.table === table);
    },
  };
}

/** Reads a filter's value for (op, column) from a recorded query. */
export function filterValue(
  q: Query,
  op: string,
  column: string,
): unknown | undefined {
  return q.filters.find((f) => f.op === op && f.column === column)?.value;
}
