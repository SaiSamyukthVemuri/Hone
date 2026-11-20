import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The Analytics screen, its charts, print and CSV use white, charcoal and neutral greys. No sage and no green, by name or by hex. A folder-wide scan, so a new
// file in either folder is covered without being listed. Statements is a separate surface with its own guard and is not scanned here.
const ROOTS = ["app/(app)/financials/analytics", "lib/business-analytics"];
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css)$/.test(n) ? [p] : [];
  });
/** A colour is green-ish when its green channel is the largest by even a small margin (sage greys such as #d6dbd3 and #edf1eb lean green by only 4 or 5): sage, olive and every green share that shape. Greys and charcoals (equal-ish channels, or blue-biased) are not. */
const greenish = (hex: string): boolean => {
  const h = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return g - Math.max(r, b) >= 3;
};
describe("Analytics carries no sage or green", () => {
  const all = ROOTS.flatMap(files);
  it("the scan really sees the screen and the charts", () => {
    expect(all.some((f) => f.endsWith("overview-screen.tsx"))).toBe(true);
    expect(all.some((f) => f.endsWith("charts.tsx"))).toBe(true);
  });
  for (const f of all.length ? all : ["none"]) {
    it(`${f} has no sage or green colour`, () => {
      const src = f === "none" ? "" : readFileSync(f, "utf8");
      const hexes = src.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) ?? [];
      expect(hexes.filter(greenish), "green-ish hex").toEqual([]);
      for (const known of ["#d6dbd3", "#5a6358", "#6f8a64", "#edf1eb"]) expect(src.toLowerCase(), known).not.toContain(known);
      expect(src).not.toMatch(/\bsage\b|\b(?:bg|text|border|fill|stroke|ring|from|to|via)-(?:green|emerald|lime|teal|sage)-\d/i);
    });
  }
  it("the detector flags the sage hexes and passes the neutral ones", () => {
    for (const bad of ["#d6dbd3", "#5a6358", "#6f8a64", "#edf1eb"]) expect(greenish(bad), bad).toBe(true);
    for (const ok of ["#1f2328", "#e3e5e8", "#5f6368", "#9aa0a6", "#fff", "#000"]) expect(greenish(ok), ok).toBe(false);
  });
});
