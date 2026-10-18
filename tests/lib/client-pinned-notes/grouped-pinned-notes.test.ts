import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// ALL PINNED NOTES REACH THE DASHBOARD ROSTER — INCLUDING PAST ROW 1000
// ===========================================================================
//
// Chloe: "Not all the pinned notes show up on dashboard. If I pin multiple
// notes I need to see all of them."
//
// The first repair grouped the rows instead of keeping only the newest. That
// was still incomplete: PostgREST caps a response at max_rows (1000), so an
// unbounded select trades "only the newest note" for "only the first thousand
// notes" — the same silent loss, moved somewhere harder to see.
//
// It is also BIASED. The order is newest-first across ALL selected clients, so
// the rows past the cap belong to whichever clients' notes are oldest: a client
// can disappear from the roster entirely rather than merely lose a note. The
// cases below fix that shape, not just the count.
// ===========================================================================

const PAGE = 1000;

/** The fake table, pre-sorted the way the query orders it. */
let dataset: Array<Record<string, unknown>> = [];
/** Page index (0-based) that should fail, or null. */
let failOnPage: number | null = null;
let rangeCalls: Array<[number, number]> = [];

const range = vi.fn(async (from: number, to: number) => {
  rangeCalls.push([from, to]);
  if (failOnPage !== null && Math.floor(from / PAGE) === failOnPage) {
    return { data: null, error: { message: "page read failed" } };
  }
  return { data: dataset.slice(from, to + 1), error: null };
});
const orderId = vi.fn(() => ({ range }));
const orderCreated = vi.fn(() => ({ order: orderId }));
const inFn = vi.fn(() => ({ order: orderCreated }));
const eq = vi.fn(() => ({ in: inFn }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ select }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from })),
}));

const { getPinnedNotesByClient } = await import("@/lib/client-pinned-notes/queries");

const STUDIO = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const note = (id: string, client: string, text: string, created: string) => ({
  id, client_id: client, studio_id: STUDIO, text, created_at: created,
});

/** Sort the way the real query does: created_at desc, then id desc. */
const sorted = (rows: Array<Record<string, unknown>>) =>
  [...rows].sort((x, y) => {
    const c = String(y.created_at).localeCompare(String(x.created_at));
    return c !== 0 ? c : String(y.id).localeCompare(String(x.id));
  });

beforeEach(() => {
  vi.clearAllMocks();
  dataset = [];
  failOnPage = null;
  rangeCalls = [];
});

describe("small datasets keep the behaviour they already had", () => {
  it("returns ALL THREE notes for one client, newest first", async () => {
    dataset = sorted([
      note("n1", A, "first pinned note", "2026-01-01T00:00:00Z"),
      note("n2", A, "second pinned note", "2026-02-02T00:00:00Z"),
      note("n3", A, "third pinned note", "2026-03-03T00:00:00Z"),
    ]);

    const out = await getPinnedNotesByClient(STUDIO, [A]);
    const notes = out.get(A) ?? [];

    expect(notes.map((n) => n.id)).toEqual(["n3", "n2", "n1"]);
    expect(notes.map((n) => n.text)).toEqual([
      "third pinned note", "second pinned note", "first pinned note",
    ]);
  });

  it("omits clients with no notes, and short-circuits an empty roster", async () => {
    dataset = sorted([note("b1", B, "only B", "2026-01-05T00:00:00Z")]);
    const out = await getPinnedNotesByClient(STUDIO, [A, B]);
    expect(out.has(A)).toBe(false);
    expect(out.get(B)).toHaveLength(1);

    vi.clearAllMocks();
    const empty = await getPinnedNotesByClient(STUDIO, []);
    expect(empty.size).toBe(0);
    expect(from).not.toHaveBeenCalled();
  });

  it("stays scoped to the studio and the requested clients", async () => {
    await getPinnedNotesByClient(STUDIO, [A, B]);
    expect(eq).toHaveBeenCalledWith("studio_id", STUDIO);
    expect(inFn).toHaveBeenCalledWith("client_id", [A, B]);
  });

  it("orders by created_at THEN id — the tiebreak pagination depends on", () => {
    expect(orderCreated).toBeDefined();
    // Asserted behaviourally below; this pins the call shape.
    return getPinnedNotesByClient(STUDIO, [A]).then(() => {
      expect(orderCreated).toHaveBeenCalledWith("created_at", { ascending: false });
      expect(orderId).toHaveBeenCalledWith("id", { ascending: false });
    });
  });
});

describe("beyond PostgREST's 1000-row cap", () => {
  it("reads MORE than 1000 notes across several clients", async () => {
    // 1,500 notes spread over three clients.
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 1500; i += 1) {
      const client = [A, B, C][i % 3]!;
      rows.push(note(`n${String(i).padStart(5, "0")}`, client, `note ${i}`,
        `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`));
    }
    dataset = sorted(rows);

    const out = await getPinnedNotesByClient(STUDIO, [A, B, C]);
    const total = [...out.values()].reduce((n, v) => n + v.length, 0);

    expect(total).toBe(1500);              // not 1000
    expect(rangeCalls.length).toBeGreaterThan(1);
    expect(rangeCalls[0]).toEqual([0, 999]);
    expect(rangeCalls[1]).toEqual([1000, 1999]);
  });

  it("a client whose notes ALL fall beyond the first page is still present", async () => {
    // A and B own the 1000 newest notes; C's are the oldest, so an unpaginated
    // read would drop C from the roster completely.
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 1000; i += 1) {
      rows.push(note(`new${String(i).padStart(5, "0")}`, i % 2 ? A : B, `recent ${i}`,
        "2026-06-01T00:00:00Z"));
    }
    for (let i = 0; i < 5; i += 1) {
      rows.push(note(`old${i}`, C, `C note ${i}`, "2020-01-01T00:00:00Z"));
    }
    dataset = sorted(rows);

    const out = await getPinnedNotesByClient(STUDIO, [A, B, C]);

    expect(out.has(C), "client C vanished past the row cap").toBe(true);
    expect(out.get(C)).toHaveLength(5);
  });

  it("EQUAL created_at values cannot duplicate or skip a row across a page edge", async () => {
    // Every note shares one timestamp, so only the id tiebreak gives a total
    // order. Without it a row can appear on two pages and another on none.
    const rows = Array.from({ length: 1200 }, (_, i) =>
      note(`tie${String(i).padStart(5, "0")}`, A, `tied ${i}`, "2026-05-05T05:05:05Z"),
    );
    dataset = sorted(rows);

    const out = await getPinnedNotesByClient(STUDIO, [A]);
    const ids = (out.get(A) ?? []).map((n) => n.id);

    expect(ids).toHaveLength(1200);
    expect(new Set(ids).size, "a row was returned twice").toBe(1200);
    // Strictly descending by id — the total order actually held.
    const descending = [...ids].sort((x, y) => y.localeCompare(x));
    expect(ids).toEqual(descending);
  });

  it("an exactly-full final page does not silently end the read", async () => {
    dataset = sorted(Array.from({ length: PAGE }, (_, i) =>
      note(`ex${String(i).padStart(5, "0")}`, A, `n${i}`, "2026-04-04T00:00:00Z"),
    ));
    const out = await getPinnedNotesByClient(STUDIO, [A]);
    expect(out.get(A)).toHaveLength(PAGE);
    // One extra cheap request proves the end rather than assuming it.
    expect(rangeCalls.length).toBe(2);
  });
});

describe("failure is never partial success", () => {
  it("THROWS when a later page fails instead of returning the earlier pages", async () => {
    dataset = sorted(Array.from({ length: 2500 }, (_, i) =>
      note(`f${String(i).padStart(5, "0")}`, A, `n${i}`,
        `2026-02-02T00:00:${String(i % 60).padStart(2, "0")}Z`),
    ));
    failOnPage = 1;   // the SECOND page fails; the first already succeeded

    await expect(getPinnedNotesByClient(STUDIO, [A])).rejects.toThrow(
      /Failed to load pinned notes: page read failed/,
    );
  });

  it("surfaces a first-page failure too", async () => {
    failOnPage = 0;
    await expect(getPinnedNotesByClient(STUDIO, [A])).rejects.toThrow(
      /Failed to load pinned notes/,
    );
  });
});

describe("no N+1", () => {
  it("issues ONE query chain for the whole roster, regardless of client count", async () => {
    dataset = sorted([
      note("a1", A, "A", "2026-01-02T00:00:00Z"),
      note("b1", B, "B", "2026-01-01T00:00:00Z"),
      note("c1", C, "C", "2026-01-03T00:00:00Z"),
    ]);
    await getPinnedNotesByClient(STUDIO, [A, B, C]);
    expect(from).toHaveBeenCalledTimes(1);
    expect(inFn).toHaveBeenCalledTimes(1);
    // Requests follow the number of NOTES, never the number of clients.
    expect(rangeCalls.length).toBe(1);
  });
});
