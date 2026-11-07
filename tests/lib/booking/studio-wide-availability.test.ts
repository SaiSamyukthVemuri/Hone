import { describe, expect, it } from "vitest";
import {
  getStudioWideDefaultsSafe,
  getStudioWideDaySafe,
} from "@/lib/booking/studio-wide-availability";

// PR B Part 3A — the studio-wide loader: query practitioner_id IS NULL and FAIL
// CLOSED on every error. 0135 is hosted, so an undefined-column error is no
// longer migration skew and must never trigger an unscoped (multi-row) read.

type Res = { data: unknown; error: { code: string } | null };

// Mock that returns queued {data,error} on each terminal (thenable await for the
// list query, maybeSingle for the day query), so a test can count queries.
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

  it("FAILS CLOSED on the undefined-column error too — no unscoped legacy retry", async () => {
    const q = mockQueue([
      { data: null, error: { code: "42703" } },
      { data: [{ day_of_week: 2 }], error: null }, // must never be read
    ]);
    await expect(getStudioWideDefaultsSafe(q.mock, "s1")).rejects.toThrow(
      /availability_read_failed:defaults:42703/,
    );
    expect(q.calls()).toBe(1);
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

  it("fails closed on undefined-column and on any other error", async () => {
    const absent = mockQueue([
      { data: null, error: { code: "PGRST204" } },
      { data: { is_open: false, open_time: null, close_time: null }, error: null },
    ]);
    await expect(getStudioWideDaySafe(absent.mock, "s1", 3)).rejects.toThrow(
      /availability_read_failed:day:PGRST204/,
    );
    expect(absent.calls()).toBe(1);

    const bad = mockQueue([{ data: null, error: { code: "08006" } }]); // connection error
    await expect(getStudioWideDaySafe(bad.mock, "s1", 3)).rejects.toThrow(/availability_read_failed/);
  });
});
