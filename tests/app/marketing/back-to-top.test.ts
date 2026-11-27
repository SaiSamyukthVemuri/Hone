import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// HON-124 item 13. The behaviour is proved in a browser (e2e/back-to-top.spec.ts); these pin the wiring a browser run would only notice by accident.
const read = (p: string) => readFileSync(p, "utf8");
const BTT = read("app/_components/marketing/BackToTop.tsx");
const SURFACE = read("app/_components/marketing/primitives.tsx");

describe("Back to top", () => {
  it("is mounted once, by the surface every marketing and policy page uses, and that surface is its focus target", () => {
    expect(SURFACE).toMatch(/import \{ BackToTop, BACK_TO_TOP_TARGET_ID \} from "\.\/BackToTop"/);
    expect((SURFACE.match(/<BackToTop \/>/g) ?? []).length).toBe(1);
    expect(SURFACE).toMatch(/id=\{BACK_TO_TOP_TARGET_ID\}[\s\S]*tabIndex=\{-1\}/);
  });

  it("is a real button, hidden at the top, moves focus before it scrolls, and honours reduced motion", () => {
    expect(BTT).toMatch(/<button\s+type="button"/);
    expect(BTT).toMatch(/if \(!visible\) return null/);
    expect(BTT.indexOf(".focus({ preventScroll: true })")).toBeGreaterThan(-1);
    expect(BTT.indexOf(".focus({ preventScroll: true })")).toBeLessThan(BTT.indexOf("window.scrollTo"));
    expect(BTT).toMatch(/prefers-reduced-motion: reduce/);
    expect(BTT).toMatch(/behavior: reduce \? "auto" : "smooth"/);
  });

  it("is a touch-sized target that never prints", () => {
    expect(BTT).toMatch(/min-h-11/);
    expect(BTT).toMatch(/print:hidden/);
  });
});
