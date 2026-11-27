import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ACK_PRESS } from "@/components/ui/control-base";

// HON-109: the pre-hydration press acknowledgement. It must stay a PRESS cue (CSS :active, a ring), never look like the spinner, and never gain a
// property that is unsafe on an arbitrary background (a fill, a scale, an opacity change: each makes a stacking context or hides a label).
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");

describe("ACK_PRESS", () => {
  const classes = ACK_PRESS.split(/\s+/);
  it("every utility is an :active state, so it paints only while pressed", () => {
    expect(classes.length).toBeGreaterThan(0);
    for (const c of classes) expect(c.startsWith("active:"), c).toBe(true);
  });
  it("is an inset outline in currentColor: visible on any background, no box, no stacking context", () => {
    expect(classes).toContain("active:outline-2");
    expect(classes).toContain("active:-outline-offset-2");
    expect(classes).toContain("active:outline-current");
    expect(ACK_PRESS).not.toMatch(/scale|opacity|transform|translate|bg-|shadow|ring-|animate|spin/);
  });
  it("is applied to exactly the measured controls and nowhere else", () => {
    expect(read("components/waitlist/waitlist-nav-link.tsx")).toMatch(/cx\("relative", ACK_PRESS, className\)/);
    expect(read("components/waitlist/workspace-queue.tsx")).toMatch(/\+ ACK_PRESS\}>Search<\/PendingSubmit>/);
    expect(read("components/pending-link.tsx")).not.toContain("ACK_PRESS");
    expect(read("components/pending-get-form.tsx")).not.toContain("ACK_PRESS");
  });
});
