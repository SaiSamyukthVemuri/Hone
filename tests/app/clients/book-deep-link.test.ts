import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const book = readFileSync("app/(app)/clients/[id]/BookAppointment.tsx", "utf8");

describe("?book=1 deep link: the URL cleanup keeps the other params", () => {
  it("removes only `book` from the URL with router.replace and scroll:false, no anchor", () => {
    expect(book).toMatch(/next\.delete\("book"\)/);
    expect(book).toMatch(/router\.replace\([^)]*\{ scroll: false \}\)/);
    expect(book).not.toMatch(/router\.(push|replace)\([^)]*#/);
  });
  it("never reads URLSearchParams.size (undefined on older browsers: it would drop tab and returnTo)", () => {
    expect(book).not.toMatch(/\bnext\.size\b|searchParams\.size\b/);
    expect(book).toMatch(/const qs = next\.toString\(\);/);
    expect(book).toMatch(/router\.replace\(qs \? `\$\{pathname\}\?\$\{qs\}` : pathname/);
  });
});
