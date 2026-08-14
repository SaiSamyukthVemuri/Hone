import { describe, expect, it } from "vitest";
import { mergeMemoryBlockRows } from "@/lib/search/treatment-memory-merge";

// Global Search finds a treatment-memory block down two paths, the block's own
// text columns (DIRECT) and its structured treatment areas (CHILD). This module
// is the pure half that turns two overlapping candidate lists into one ordered,
// capped, deduplicated result set. Everything here is behavioural: real inputs
// through the real function, no source greps.

type Row = {
  id: string;
  created_at?: string | null;
  primary_area?: string | null;
  block_name?: string | null;
};

const row = (id: string, created_at: string | null = "2026-01-01T00:00:00Z"): Row => ({
  id,
  created_at,
});

describe("direct-only and child-only matches both produce results", () => {
  it("returns the direct matches when there is no child match", () => {
    const out = mergeMemoryBlockRows([row("a"), row("b")], [], 4);
    expect(out.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("returns the child matches when there is no direct match", () => {
    // The whole point of the fix: a block whose ONLY match is a secondary
    // structured area still becomes a result.
    const out = mergeMemoryBlockRows([], [row("sideburn-block")], 4);
    expect(out.map((r) => r.id)).toEqual(["sideburn-block"]);
  });

  it("returns the union when the two paths find different blocks", () => {
    const out = mergeMemoryBlockRows(
      [row("direct", "2026-03-01T00:00:00Z")],
      [row("child", "2026-02-01T00:00:00Z")],
      4,
    );
    expect(out.map((r) => r.id)).toEqual(["direct", "child"]);
  });

  it("an empty child result changes nothing", () => {
    const direct = [row("a"), row("b")];
    expect(mergeMemoryBlockRows(direct, [], 4)).toHaveLength(2);
    expect(mergeMemoryBlockRows(direct, null, 4)).toHaveLength(2);
    expect(mergeMemoryBlockRows(direct, undefined, 4)).toHaveLength(2);
  });

  it("both paths empty yields nothing, never a throw", () => {
    expect(mergeMemoryBlockRows([], [], 4)).toEqual([]);
    expect(mergeMemoryBlockRows(null, null, 4)).toEqual([]);
    expect(mergeMemoryBlockRows(undefined, undefined, 4)).toEqual([]);
  });
});

describe("the same block found down both paths is ONE result", () => {
  it("dedupes by block id", () => {
    // Searching "Cheek" matches the legacy primary_area AND the structured
    // child row for the same treatment. One treatment, one result.
    const out = mergeMemoryBlockRows([row("same")], [row("same")], 4);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("same");
  });

  it("collapses a block matched by SEVERAL of its own areas", () => {
    // "Left Cheek" + "Right Cheek" are two child rows pointing at one block.
    const out = mergeMemoryBlockRows([], [row("b1"), row("b1"), row("b1")], 4);
    expect(out).toHaveLength(1);
  });

  it("keeps the RICHER row when the two paths carry different detail", () => {
    const sparse: Row = { id: "b1", created_at: "2026-01-01T00:00:00Z" };
    const rich: Row = {
      id: "b1",
      created_at: "2026-01-01T00:00:00Z",
      primary_area: "Cheek",
      block_name: "Upper lip",
    };
    expect(mergeMemoryBlockRows([sparse], [rich], 4)[0]).toBe(rich);
    // ...and symmetrically, so argument order does not decide richness.
    expect(mergeMemoryBlockRows([rich], [sparse], 4)[0]).toBe(rich);
  });

  it("keeps the DIRECT row on an exact richness tie (documented tiebreak)", () => {
    const direct: Row = { id: "b1", created_at: "2026-01-01T00:00:00Z" };
    const child: Row = { id: "b1", created_at: "2026-01-01T00:00:00Z" };
    expect(mergeMemoryBlockRows([direct], [child], 4)[0]).toBe(direct);
  });
});

describe("deterministic newest-first ranking", () => {
  it("orders newest created_at first, across both paths", () => {
    const out = mergeMemoryBlockRows(
      [row("old", "2026-01-01T00:00:00Z"), row("newest", "2026-06-01T00:00:00Z")],
      [row("middle", "2026-03-01T00:00:00Z")],
      4,
    );
    expect(out.map((r) => r.id)).toEqual(["newest", "middle", "old"]);
  });

  it("breaks timestamp ties by id, stably and identically on repeat calls", () => {
    const t = "2026-01-01T00:00:00Z";
    const first = mergeMemoryBlockRows([row("c", t), row("a", t)], [row("b", t)], 4);
    const second = mergeMemoryBlockRows([row("c", t), row("a", t)], [row("b", t)], 4);
    expect(first.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
  });

  it("sorts undated rows LAST rather than treating them as newest", () => {
    const out = mergeMemoryBlockRows(
      [row("undated", null), row("dated", "2020-01-01T00:00:00Z")],
      [],
      4,
    );
    expect(out.map((r) => r.id)).toEqual(["dated", "undated"]);
  });

  it("two undated rows still fall back to the stable id order", () => {
    // Regression guard: ranking undated rows by subtraction yields NaN, which
    // makes the comparator inconsistent and silently drops the id tiebreak.
    const out = mergeMemoryBlockRows([row("z", null), row("a", null)], [], 4);
    expect(out.map((r) => r.id)).toEqual(["a", "z"]);
  });

  it("ranks a Date the same as its ISO string, driver shape must not matter", () => {
    // node-postgres returns a real Date where PostgREST returns a string. The
    // DB lane reuses this helper, and treating a Date as undated silently
    // collapsed newest-first into the id tiebreak without failing anything.
    const out = mergeMemoryBlockRows(
      [
        { id: "old", created_at: new Date("2026-01-01T00:00:00Z") },
        { id: "new", created_at: new Date("2026-06-01T00:00:00Z") },
      ],
      [{ id: "mid", created_at: "2026-03-01T00:00:00Z" }],
      4,
    );
    expect(out.map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });

  it("an invalid Date is undated, not NaN-ranked", () => {
    const out = mergeMemoryBlockRows(
      [
        { id: "bad", created_at: new Date("nonsense") },
        { id: "good", created_at: "2026-01-01T00:00:00Z" },
      ],
      [],
      4,
    );
    expect(out.map((r) => r.id)).toEqual(["good", "bad"]);
  });

  it("an unparseable timestamp is treated as undated, not as an error", () => {
    const out = mergeMemoryBlockRows(
      [row("bad", "not-a-date"), row("good", "2026-01-01T00:00:00Z")],
      [],
      4,
    );
    expect(out.map((r) => r.id)).toEqual(["good", "bad"]);
  });
});

describe("the cap is applied AFTER deduplication", () => {
  it("a duplicate never consumes a slot that a distinct block could fill", () => {
    // The failure this pins: cap first, and the two copies of "dup" eat two of
    // the four slots, hiding a real fourth treatment.
    const direct = [
      row("dup", "2026-05-01T00:00:00Z"),
      row("b", "2026-04-01T00:00:00Z"),
      row("c", "2026-03-01T00:00:00Z"),
    ];
    const child = [row("dup", "2026-05-01T00:00:00Z"), row("d", "2026-02-01T00:00:00Z")];
    const out = mergeMemoryBlockRows(direct, child, 4);
    expect(out.map((r) => r.id)).toEqual(["dup", "b", "c", "d"]);
    expect(new Set(out.map((r) => r.id)).size).toBe(4);
  });

  it("truncates to the cap, keeping the newest", () => {
    const rows = [
      row("n1", "2026-06-01T00:00:00Z"),
      row("n2", "2026-05-01T00:00:00Z"),
      row("n3", "2026-04-01T00:00:00Z"),
      row("n4", "2026-03-01T00:00:00Z"),
      row("n5", "2026-02-01T00:00:00Z"),
    ];
    expect(mergeMemoryBlockRows(rows, [], 4).map((r) => r.id)).toEqual([
      "n1",
      "n2",
      "n3",
      "n4",
    ]);
  });

  it("a cap of zero or below yields nothing, a cap must not fail open", () => {
    expect(mergeMemoryBlockRows([row("a")], [row("b")], 0)).toEqual([]);
    expect(mergeMemoryBlockRows([row("a")], [row("b")], -1)).toEqual([]);
    expect(mergeMemoryBlockRows([row("a")], [row("b")], Number.NaN)).toEqual([]);
  });
});

describe("malformed rows fail safe", () => {
  it("drops rows with no usable id instead of throwing", () => {
    const rows = [
      null,
      undefined,
      "not-an-object",
      { id: "" },
      { id: "   " },
      { id: 42 },
      { created_at: "2026-01-01T00:00:00Z" },
      row("good"),
    ] as unknown as Row[];
    const out = mergeMemoryBlockRows(rows, [], 4);
    expect(out.map((r) => r.id)).toEqual(["good"]);
  });

  it("one malformed row never suppresses the valid ones beside it", () => {
    const rows = [null, row("a"), undefined, row("b")] as unknown as Row[];
    expect(mergeMemoryBlockRows(rows, [], 4)).toHaveLength(2);
  });
});
