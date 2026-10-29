import { describe, expect, it } from "vitest";
import { hashedNumberFor, makeNumberAllocator } from "../../db/helpers/sms-numbers";
import { readFileSync } from "node:fs";
import path from "node:path";

// Prod push run 40716437947: studio-sms-sender.db.test.ts "SUCCESSFUL_RENEWAL"
// failed with `expected false to be true` because two random studios hashed to
// the same claimed number and the second claim came back not_claimable.

function findHashCollision(): [string, string] {
  const seen = new Map<string, string>();
  for (let i = 0; i < 200_000; i++) {
    const id = `studio-${i}`;
    const n = hashedNumberFor(id, "A");
    const other = seen.get(n);
    if (other) return [other, id];
    seen.set(n, id);
  }
  throw new Error("no collision found");
}

describe("DB test claimed-number allocation", () => {
  it("NEGATIVE CONTROL: the old hash gives two different studios the same number", () => {
    const [x, y] = findHashCollision();
    expect(x).not.toBe(y);
    expect(hashedNumberFor(x, "A")).toBe(hashedNumberFor(y, "A"));
  });

  it("the allocator gives that same pair, and every other studio/slot, distinct numbers", () => {
    const [x, y] = findHashCollision();
    const alloc = makeNumberAllocator(0);
    expect(alloc(x, "A")).not.toBe(alloc(y, "A"));
    const all = new Set<string>();
    for (let i = 0; i < 500; i++) for (const s of ["A", "B"] as const) all.add(alloc(`s${i}`, s));
    expect(all.size).toBe(1000);
  });

  it("is stable for a repeated (studio, slot) and wraps without repeating inside the range", () => {
    const alloc = makeNumberAllocator(6990);
    const first = alloc("s", "A");
    expect(alloc("s", "A")).toBe(first);
    const seen = new Set<string>();
    for (let i = 0; i < 6999; i++) seen.add(alloc(`w${i}`, "A"));
    expect(seen.size).toBe(6999);
  });

  it("stays in the 556 exchange, clear of the fixed 555 numbers", () => {
    const n = makeNumberAllocator(6999)("s", "A");
    expect(n).toMatch(/^\+1416556\d{4}$/);
  });

  it("the DB test uses the allocator, not the hash", () => {
    const src = readFileSync(path.resolve(__dirname, "../../db/studio-sms-sender.db.test.ts"), "utf8");
    expect(src).toContain("makeNumberAllocator");
    expect(src).not.toMatch(/Math\.imul\(h \^/);
  });
});
