import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// DESIGN.md LAW 5 / contract 1: a control a thumb presses is at least 44px tall. The Sterile Items and Disinfectants logbooks share ONE
// stock-status filter (All / In stock / Discarded). It was `min-h-9` (36px) with no vertical padding on every pointer, so a phone or a
// portrait iPad got a 36px target. The 44px floor is the DEFAULT; only a fine pointer (a mouse) may take the compact box, and it is chosen by
// pointer, never by width, so a portrait iPad keeps the full target.
const src = readFileSync("app/(app)/records/page.tsx", "utf8");
const body = /function StockFilters[\s\S]*?\n}\n/.exec(src)?.[0] ?? "";
const linkClass = /<PendingLink[\s\S]*?className=\{`([^`]*)`\}/.exec(body)?.[1] ?? "";
const classes = linkClass.replace(/\$\{[^}]*\}/g, " ").split(/\s+/).filter(Boolean);

describe("the shared stock filter keeps the 44px floor on a coarse pointer", () => {
  it("found the filter link's class list", () => {
    expect(body).toContain('aria-label="Stock status"');
    expect(classes).toContain("inline-flex"); // min-height is inert on an inline box
  });

  it("is min-h-11 by default", () => {
    expect(classes).toContain("min-h-11");
  });

  it("has no UNPREFIXED min-height below 44px, and no width-breakpoint min-height", () => {
    const bare = classes.filter((c) => /^min-h-/.test(c));
    expect(bare.filter((c) => c !== "min-h-11")).toEqual([]);
    expect(classes.filter((c) => /^(sm|md|lg|xl):min-h-/.test(c))).toEqual([]);
  });

  it("relaxes only for a fine pointer", () => {
    const compact = classes.filter((c) => /min-h-/.test(c) && c !== "min-h-11");
    expect(compact.length).toBeGreaterThan(0);
    for (const c of compact) expect(c.startsWith("pointer-fine:")).toBe(true);
  });
});
