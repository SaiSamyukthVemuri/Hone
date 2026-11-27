import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// HON-109 (Records): "View session", "Open appointment", "Chart session" and the Last visit / Next appointment links on a client record opened a
// route whose server read takes 0.5 to 1.5 s, and gave NO acknowledgement for that whole time (measured: no cue in 80 of 80 runs, desktop and
// phone, cold and warm). They are PendingLinks now, the app's one navigation acknowledgement (pressed state, spinner mark, live region). A route
// `loading.tsx` was NOT used: DESIGN.md (SESSION-START-01) keeps it out, and pending-link.tsx records the measured stall it causes on query-only
// navigations. This pins the mechanism so a refactor back to a bare <Link> fails here, not in the practitioner's hands.
const FILES = [
  "components/client-appointment-timeline.tsx",
  "app/(app)/clients/[id]/_profile/VisitSummary.tsx",
];

describe("Records navigation links acknowledge the press", () => {
  for (const file of FILES) {
    const src = readFileSync(file, "utf8");
    it(`${file} navigates only through PendingLink`, () => {
      expect(src).toContain('import { PendingLink } from "@/components/pending-link"');
      expect(src).not.toMatch(/from "next\/link"/);
      expect(src).not.toMatch(/<Link[\s>]/);
      expect(src.match(/<PendingLink[\s>]/g)?.length ?? 0).toBeGreaterThan(0);
      expect(src.match(/<PendingLink[\s>]/g)?.length).toBe(src.match(/<\/PendingLink>/g)?.length);
    });
  }
  it("the Edit client links acknowledge the press too", () => {
    for (const file of ["app/(app)/clients/[id]/page.tsx", "app/(app)/clients/[id]/_profile/ContactSidebar.tsx"]) {
      const src = readFileSync(file, "utf8");
      expect(src).not.toMatch(/<Link\s+href=\{`\/clients\/\$\{(?:client\.id|clientId)\}\/edit`\}/);
      expect(src).toMatch(/<PendingLink\s+href=\{`\/clients\/\$\{(?:client\.id|clientId)\}\/edit`\}/);
    }
  });
  it("the timeline keeps all seven of its navigation buttons", () => {
    const src = readFileSync(FILES[0]!, "utf8");
    expect(src.match(/<PendingLink[\s>]/g)?.length).toBe(7);
  });
});
