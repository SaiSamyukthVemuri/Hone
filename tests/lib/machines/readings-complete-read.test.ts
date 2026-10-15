import { describe, expect, it } from "vitest";

import {
  BLOCK_READING_MAX_PAGES,
  BLOCK_READING_PAGE_SIZE,
  readingsForBlock,
  type MachineDb,
} from "@/lib/machines/machine-queries";

// ===========================================================================
// A BLOCK'S READINGS ARE READ COMPLETELY, OR THE READ FAILS
// (Codex, #860 4288424513)
// ===========================================================================
//
// The version this covers asked for `.order("field_key").limit(500)`. Two
// faults compounded:
//
//   1. a block CAN exceed the cap - one row per field per capture, one capture
//      per settings group per save, so a four-channel unit re-read through a
//      long treatment reaches several hundred rows without anything unusual;
//   2. ordered by `field_key` ALONE, the cap does not cut at a capture
//      boundary. It cuts mid-alphabet across every capture at once, so the
//      surface that groups these rows renders captures MISSING SOME FIELDS - a
//      complete-looking record of a treatment that never happened. A current
//      without its duration is not a setting anyone can reproduce.
//
// AND RAISING THE LIMIT WOULD HAVE MOVED THE CLIFF. PostgREST answers a read
// past `max_rows` with 200, the first window and NO error, so `.limit(5000)`
// just relocates the silent truncation to 1,000. That is why the fake below
// caps pages BELOW the requested limit: it is modelling the thing that makes
// the naive fix wrong, and a fake that always honours the requested limit
// cannot fail on case 2.
// ===========================================================================

type Row = Record<string, unknown>;

/** One reading row, shaped as the query selects it. */
function row(id: string, o: Partial<Row> = {}): Row {
  return {
    id,
    session_block_id: "block-1",
    machine_profile_id: "fixture:paging",
    machine_profile_version: 1,
    mode_key: "galvanic",
    group_key: "g1",
    channels: [],
    stage_key: null,
    field_key: "current",
    value_numeric: "120",
    absence_reason: null,
    native_unit: "µA",
    decimals: 0,
    revision: 1,
    capture_id: "cap-1",
    studio_machine_id: "dev-1",
    recorded_at: "2026-10-15T10:00:00Z",
    ...o,
  };
}

type FakeOptions = {
  /** The server's OWN ceiling, applied regardless of the requested limit. */
  serverMaxRows?: number;
  /** Answer every page with these rows, ignoring the keyset. */
  stuck?: boolean;
  error?: { message: string };
  /** Hand back something that is not an array, as a broken client would. */
  notAnArray?: boolean;
};

function fakeDb(rows: Row[], opts: FakeOptions = {}) {
  const calls: Array<{ after: string | null; limit: number }> = [];
  const page = (after: string | null) => (limit: number) => {
    calls.push({ after, limit });
    if (opts.error) return Promise.resolve({ data: null, error: opts.error });
    if (opts.notAnArray) return Promise.resolve({ data: {}, error: null });
    // ORDERED BY id, as the query asks. The first spelling of this fake
    // filtered but did not sort, so a page handed back rows in insert order
    // and the cursor took the LAST of those rather than the greatest id - the
    // next page then re-served a row it had already given. The fake was wrong
    // and the reader caught it, which is the right way round.
    const source = opts.stuck
      ? rows
      : rows
          .filter((r) => after === null || String(r.id) > after)
          .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const cap = Math.min(limit, opts.serverMaxRows ?? limit);
    return Promise.resolve({ data: source.slice(0, cap), error: null });
  };
  const db = {
    rpc: async () => ({ data: null, error: null }),
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({ order: async () => ({ data: [], error: null }) }),
          order: () => ({ limit: page(null) }),
          gt: (_c: string, after: string) => ({
            order: () => ({ limit: page(after) }),
          }),
          in: () => ({ limit: async () => ({ data: [], error: null }) }),
        }),
      }),
    }),
  } as unknown as MachineDb;
  return { db, calls };
}

describe("readingsForBlock reads every page", () => {
  it("returns rows from BEYOND the first page", async () => {
    // 1,500 rows against a 1,000-row page: the old read would have answered
    // with 500 and called itself successful.
    const rows = Array.from({ length: 1500 }, (_, i) =>
      row(`r-${String(i).padStart(5, "0")}`),
    );
    const { db, calls } = fakeDb(rows);

    const out = await readingsForBlock(db, "block-1");

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toHaveLength(1500);
    // Three calls: a full page, a short page, then the empty one that ends it.
    expect(calls).toHaveLength(3);
    expect(calls[0]!.after).toBeNull();
    expect(calls[0]!.limit).toBe(BLOCK_READING_PAGE_SIZE);
    expect(calls[1]!.after).toBe("r-00999");
  });

  it("does NOT trust a short page to be the last one", async () => {
    // THE CASE THAT MAKES THE NAIVE FIX WRONG. The server caps every response
    // at 400 whatever this asks for, exactly as PostgREST's max_rows does -
    // and answers 200 with no error. A reader that stops when a page comes
    // back shorter than requested would return 400 of 900 rows and report
    // success.
    const rows = Array.from({ length: 900 }, (_, i) =>
      row(`r-${String(i).padStart(5, "0")}`),
    );
    const { db, calls } = fakeDb(rows, { serverMaxRows: 400 });

    const out = await readingsForBlock(db, "block-1");

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value, "a short page ended the read early").toHaveLength(900);
    expect(calls).toHaveLength(4); // 400, 400, 100, 0
  });

  it("never splits a capture, however the cap falls", async () => {
    // THE CLINICAL POINT, and the reason the old ordering was worse than the
    // old limit. 300 captures of three fields each, with the server cutting
    // every 400 rows - mid-capture by construction. Every capture must come
    // back whole.
    const rows: Row[] = [];
    for (let c = 0; c < 300; c += 1) {
      const capture = `cap-${String(c).padStart(4, "0")}`;
      for (const field of ["current", "duration", "energy_shown"]) {
        rows.push(
          row(`r-${String(rows.length).padStart(5, "0")}`, {
            capture_id: capture,
            field_key: field,
            revision: c + 1,
          }),
        );
      }
    }
    const { db } = fakeDb(rows, { serverMaxRows: 400 });

    const out = await readingsForBlock(db, "block-1");

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toHaveLength(900);
    const byCapture = new Map<string, number>();
    for (const r of out.value) {
      byCapture.set(r.captureId ?? "", (byCapture.get(r.captureId ?? "") ?? 0) + 1);
    }
    expect(byCapture.size).toBe(300);
    const short = [...byCapture.entries()].filter(([, n]) => n !== 3);
    expect(short, "a capture came back with some of its fields").toEqual([]);
  });

  it("keeps the field_key ordering the surface has always had", async () => {
    // The repair reads by `id` because that is the only stable keyset, but the
    // ORDER it hands back is unchanged, so no rendering contract moves with it.
    const { db } = fakeDb([
      row("r-3", { field_key: "energy_shown" }),
      row("r-1", { field_key: "current" }),
      row("r-2", { field_key: "duration" }),
    ]);

    const out = await readingsForBlock(db, "block-1");

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.map((r) => r.fieldKey)).toEqual([
      "current",
      "duration",
      "energy_shown",
    ]);
  });
});

describe("readingsForBlock fails CLOSED rather than returning part of a block", () => {
  it("refuses when the keyset does not advance", async () => {
    // A server answering every page with the same rows would otherwise spin
    // until the ceiling and then return 50,000 duplicates.
    const { db, calls } = fakeDb([row("r-1"), row("r-2")], { stuck: true });

    const out = await readingsForBlock(db, "block-1");

    expect(out.ok).toBe(false);
    expect(calls.length, "it must notice on the SECOND page, not at the ceiling")
      .toBe(2);
  });

  it("refuses when a row carries no id to page by", async () => {
    // Without a cursor the read cannot be shown complete. Guessing - stopping
    // and calling it done - is the defect being repaired, one layer down.
    const { db } = fakeDb([{ ...row("x"), id: undefined }]);

    const out = await readingsForBlock(db, "block-1");

    expect(out.ok).toBe(false);
  });

  it("refuses at the page ceiling instead of truncating", async () => {
    // More rows than the bound allows is still an incomplete read, and the
    // caller must not be handed a prefix wearing ok:true.
    const rows = Array.from(
      { length: BLOCK_READING_PAGE_SIZE * (BLOCK_READING_MAX_PAGES + 2) },
      (_, i) => row(`r-${String(i).padStart(7, "0")}`),
    );
    const { db, calls } = fakeDb(rows);

    const out = await readingsForBlock(db, "block-1");

    expect(out.ok).toBe(false);
    expect(calls).toHaveLength(BLOCK_READING_MAX_PAGES);
  });

  it("refuses on a failed page, and passes the server's own words through", async () => {
    // `fail()` returns a STRING and prefers the database's message to the
    // fallback. My first spelling here asserted `out.error.message` against
    // the fallback and was wrong twice over - the shape and the precedence.
    const { db } = fakeDb([row("r-1")], { error: { message: "boom" } });
    const out = await readingsForBlock(db, "block-1");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe("boom");
  });

  it("uses the fallback sentence when the failure carries no message", async () => {
    // The keyset, ceiling and not-a-list refusals have no server error to
    // quote, so the caller still gets a sentence rather than an empty string.
    const { db } = fakeDb([row("r-1")], { notAnArray: true });
    const out = await readingsForBlock(db, "block-1");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/could not read settings/i);
  });

  it("refuses when the client hands back something that is not a list", async () => {
    const { db } = fakeDb([row("r-1")], { notAnArray: true });
    const out = await readingsForBlock(db, "block-1");
    expect(out.ok).toBe(false);
  });

  it("CONTROL: an empty block is an ordinary EMPTY success, not a refusal", async () => {
    // Fail-closed must not swallow the commonest case: a treatment area with
    // no machine settings recorded on it yet.
    const { db, calls } = fakeDb([]);

    const out = await readingsForBlock(db, "block-1");

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
