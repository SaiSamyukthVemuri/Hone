import { describe, expect, it } from "vitest";
import {
  getStudioWideDefaultsSafe,
  getStudioWideDaySafe,
} from "@/lib/booking/studio-wide-availability";

// PR B Part 3A — the migration-order-safe studio-wide loader: query
// practitioner_id IS NULL; fall back to the legacy unscoped query ONLY on the
// undefined-column error; FAIL CLOSED on any other error.

type Res = { data: unknown; error: { code: string } | null };

// Mock that returns queued {data,error} on each terminal (thenable await for the
// list query, maybeSingle for the day query), so we can drive scoped-then-legacy.
function mockQueue(results: Res[]) {
  let i = 0;
  const next = (): Res => results[i++] ?? { data: null, error: null };
  function builder() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    for (const m of ["select", "eq", "is", "gte", "lte", "order"]) b[m] = () => b;
    b.then = (onF: (v: Res) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(next()).then(onF, onR);
    b.maybeSingle = () => Promise.resolve(next());
    return b;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { calls: () => i, mock: { from: () => builder() } as any };
}

describe("getStudioWideDefaultsSafe", () => {
  it("returns the scoped rows when the query succeeds (no fallback)", async () => {
    const q = mockQueue([{ data: [{ day_of_week: 1 }], error: null }]);
    const rows = await getStudioWideDefaultsSafe(q.mock, "s1");
    expect(rows).toEqual([{ day_of_week: 1 }]);
    expect(q.calls()).toBe(1); // did NOT fall back
  });

  it("falls back to the legacy unscoped query ONLY on the undefined-column error", async () => {
    const q = mockQueue([
      { data: null, error: { code: "42703" } }, // column absent (pre-migration)
      { data: [{ day_of_week: 2 }], error: null }, // legacy result
    ]);
    const rows = await getStudioWideDefaultsSafe(q.mock, "s1");
    expect(rows).toEqual([{ day_of_week: 2 }]);
    expect(q.calls()).toBe(2); // scoped + legacy
  });

  it("FAILS CLOSED on a non-undefined-column error (e.g. auth) — no fallback, no data leak", async () => {
    const q = mockQueue([{ data: null, error: { code: "42501" } }]);
    await expect(getStudioWideDefaultsSafe(q.mock, "s1")).rejects.toThrow(
      /availability_read_failed:defaults:42501/,
    );
    expect(q.calls()).toBe(1); // did NOT fall back on a non-column error
  });
});

describe("getStudioWideDaySafe", () => {
  it("returns the single studio-wide row on success", async () => {
    const q = mockQueue([{ data: { is_open: true, open_time: "09:00", close_time: "17:00" }, error: null }]);
    const row = await getStudioWideDaySafe(q.mock, "s1", 1);
    expect(row).toMatchObject({ is_open: true, open_time: "09:00" });
  });

  it("fails over on undefined-column, fails closed otherwise", async () => {
    const ok = mockQueue([
      { data: null, error: { code: "PGRST204" } },
      { data: { is_open: false, open_time: null, close_time: null }, error: null },
    ]);
    expect(await getStudioWideDaySafe(ok.mock, "s1", 3)).toMatchObject({ is_open: false });

    const bad = mockQueue([{ data: null, error: { code: "08006" } }]); // connection error
    await expect(getStudioWideDaySafe(bad.mock, "s1", 3)).rejects.toThrow(/availability_read_failed/);
  });
});
