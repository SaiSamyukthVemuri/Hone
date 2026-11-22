import { beforeEach, describe, expect, it, vi } from "vitest";

// Codex P2: a short page is not the last page when the server caps rows below the requested page size. The probe must
// page like the calendar's own loader: keyset by id, continue until an EMPTY page, refuse a repeated row.

type Row = { id: string; updated_at: string };
const state = vi.hoisted(() => ({ rows: [] as Array<{ id: string; updated_at: string }>, cap: 2, repeat: false }));

vi.mock("@/lib/supabase/server", () => {
  function builder(table: string) {
    let after: string | null = null;
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void) => {
              if (table !== "appointments") return resolve({ data: [], error: null });
              let page = state.rows.filter((r) => after === null || r.id > after).slice(0, state.cap);
              if (state.repeat && after !== null) page = state.rows.slice(0, 1);
              resolve({ data: page, error: null });
            };
          }
          return (...args: unknown[]) => {
            if (prop === "gt" && args[0] === "id") after = String(args[1]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  }
  return { createClient: async () => ({ from: (table: string) => builder(table) }) };
});

import { readCalendarFingerprint } from "@/lib/calendar/change-probe-read";
import { calendarFingerprint } from "@/lib/calendar/change-fingerprint";

const input = { studioId: "11111111-1111-4111-8111-111111111111", timezone: "America/Toronto", view: "day" as const, anchor: "2026-11-18" };
const mk = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `00000000-0000-4000-8000-00000000000${i + 1}`, updated_at: `2026-11-18T10:0${i}:00Z` }));

beforeEach(() => {
  state.rows = mk(5);
  state.cap = 2;
  state.repeat = false;
});

describe("the probe pages appointments like the page loader", () => {
  it("reads every row when the server returns short pages (cap 2 of a requested 1000)", async () => {
    const got = await readCalendarFingerprint(input);
    expect(got).toBe(calendarFingerprint({ appointments: mk(5), timedBlocks: [], blockouts: [], occurrences: [] }));
  });
  it("a change to a row on a later page moves the fingerprint (a stop at the first short page would miss it)", async () => {
    const before = await readCalendarFingerprint(input);
    state.rows = mk(5).map((r, i) => (i === 4 ? { ...r, updated_at: "2026-11-18T12:00:00Z" } : r));
    expect(await readCalendarFingerprint(input)).not.toBe(before);
  });
  it("a repeated row refuses the whole read", async () => {
    state.repeat = true;
    await expect(readCalendarFingerprint(input)).rejects.toThrow(/repeated row/);
  });
  it("an empty studio hashes the empty set", async () => {
    state.rows = [];
    expect(await readCalendarFingerprint(input)).toBe(calendarFingerprint({ appointments: [], timedBlocks: [], blockouts: [], occurrences: [] }));
  });
});
