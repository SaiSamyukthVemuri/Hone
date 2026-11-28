import { describe, expect, it } from "vitest";
import { jsonLeaves, leavesLeaking } from "../db/helpers/json-leaves";

// The deleted-pass assertions in tests/db/appointment-prep-memory.db.test.ts use this helper instead of a substring scan over the whole JSON.
describe("leavesLeaking", () => {
  const clean = { id: "8e1225ca-9999-4c3d-8e7f-0123456789ab", at: "2026-01-01T09999:00Z", hairs: 65, notes: ["First pass"] };

  it("does NOT trip on a '9999' inside an id or a timestamp (the flake this replaces)", () => {
    expect(JSON.stringify(clean)).toMatch(/9999/); // the old scan WOULD have failed here
    expect(leavesLeaking(clean, { numbers: [9999], texts: ["FORBIDDEN-DELETED-PASS"] })).toEqual([]);
  });

  it("DOES trip when the deleted pass's number leaks as a value", () => {
    expect(leavesLeaking({ areas: [{ outcome: { hairs: 9999 } }] }, { numbers: [9999] })).toEqual(["$.areas[0].outcome.hairs"]);
  });

  it("DOES trip when the deleted pass's note text leaks, even inside a longer string", () => {
    const leaked = { areas: [{ outcome: { notes: ["First pass", "see FORBIDDEN-DELETED-PASS here"] } }] };
    expect(leavesLeaking(leaked, { texts: ["FORBIDDEN-DELETED-PASS"] })).toEqual(["$.areas[0].outcome.notes[1]"]);
  });

  it("walks nested arrays and objects and ignores undefined and functions", () => {
    expect(jsonLeaves({ a: [1, { b: "x" }], c: undefined, d: () => 1 }).map((l) => l.path)).toEqual(["$.a[0]", "$.a[1].b"]);
  });
});
