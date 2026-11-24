import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #1757 removed `overflow-hidden` from the Appointments list, which had been clipping this control. The toggle's label carries the client's name
// ("View full last treatment for <name>"), and an unbroken 95-character name made the button 573px wide: the document scrolled sideways at 320 and 390
// (e2e/dashboard-phone-overflow.spec.ts, red before, green after). The control must wrap its own label rather than rely on a clipping ancestor.
const src = readFileSync("app/(app)/dashboard/dashboard-treatment-memory.tsx", "utf8");
const toggle = /data-testid="dashboard-memory-toggle"[\s\S]*?className="([^"]+)"/.exec(src)?.[1] ?? "";

describe("the Last treatment toggle wraps a long client name itself", () => {
  it("can shrink and break an unbroken word", () => {
    expect(toggle).toContain("min-w-0");
    expect(toggle).toContain("max-w-full");
    expect(toggle).toContain("[overflow-wrap:anywhere]");
  });
});
