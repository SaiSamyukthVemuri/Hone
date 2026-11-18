import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// lib/waitlist/booked-manually.ts does not check the caller's role itself: the owner-only action does, before calling it. So that action must be its
// ONLY importer; a second caller would have to bring its own role check and its own review.
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === ".next" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}
describe("booked-manually.ts has exactly one importer", () => {
  it("is imported only by the owner-only action", () => {
    const importers = [...walk("app"), ...walk("lib"), ...walk("components")].filter((f) =>
      /from\s+["']@\/lib\/waitlist\/booked-manually["']/.test(readFileSync(f, "utf8")),
    );
    expect(importers).toEqual([join("app", "(app)", "settings", "waitlist", "booked-manually-actions.ts")]);
  });
  it("and that action checks the owner role before it calls the command", () => {
    const s = readFileSync("app/(app)/settings/waitlist/booked-manually-actions.ts", "utf8");
    expect(s.indexOf('practitioner.role !== "owner"')).toBeGreaterThan(-1);
    expect(s.indexOf('practitioner.role !== "owner"')).toBeLessThan(s.indexOf("markEntryBookedManually("));
  });
});
