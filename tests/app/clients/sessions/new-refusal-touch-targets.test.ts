import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// The refusal page is reached by someone who was just told "no" on a tablet or phone. Every link on it
// (the back arrow above the heading and each link inside the refusal notice) must be a tap target of at
// least 44 px, at 390 and 820 wide alike (measured 18 Nov 2026: they were text-height, about 20 px).
const SOURCE = readFileSync(path.resolve(__dirname, "../../../../app/(app)/clients/[id]/sessions/new/page.tsx"), "utf8");

/** The className of every <Link ...> opening tag in `text`, in order. */
function linkClassNames(text: string): string[] {
  return [...text.matchAll(/<Link\b[^>]*?className="([^"]*)"/gs)].map((m) => m[1]);
}

describe("new-session page: refusal links are 44 px tap targets", () => {
  const start = SOURCE.indexOf('data-testid="session-start-refusal"');
  const end = SOURCE.indexOf("</section>", start);
  const refusal = SOURCE.slice(start, end);

  it("finds the refusal notice and its links", () => {
    expect(start).toBeGreaterThan(0);
    expect(linkClassNames(refusal).length).toBeGreaterThanOrEqual(3);
  });

  it("every link inside the refusal notice is at least 44 px high and vertically centred", () => {
    for (const cls of linkClassNames(refusal)) {
      expect(cls, cls).toContain("min-h-[44px]");
      expect(cls, cls).toMatch(/\binline-flex\b/);
      expect(cls, cls).toMatch(/\bitems-center\b/);
    }
  });

  it("the back arrow above the heading is a 44 px tap target too", () => {
    const back = SOURCE.slice(Math.max(0, SOURCE.indexOf("<h1") - 600), SOURCE.indexOf("<h1"));
    const cls = linkClassNames(back).at(-1) ?? "";
    expect(cls).toContain("min-h-[44px]");
    expect(back).toContain("←");
  });
});
