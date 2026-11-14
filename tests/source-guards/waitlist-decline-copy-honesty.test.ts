import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// A decline writes an invitation and an entry row (0192) and nothing else: no email, no owner card, no dashboard item.
// So the declined screen must not say the studio was told. Spelling-based tripwire on the DeclinedView text, not proof that
// no notification exists elsewhere; if a notification is ever built, change this guard and the copy together.

const SRC = readFileSync("app/features/waitlist-invitation/InvitationScreen.tsx", "utf8");
const start = SRC.indexOf("function DeclinedView");
const view = SRC.slice(start, SRC.indexOf("\n}\n", start));
const text = view.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("declined screen makes no notification claim", () => {
  it("finds the DeclinedView body", () => {
    expect(start).toBeGreaterThan(0);
    expect(text).toContain("You’ve declined these times");
  });

  it("says nothing about the studio having been told, notified or informed", () => {
    expect(text.toLowerCase()).not.toMatch(/(been|were|was|is|are) (told|notified|informed|alerted)/);
    expect(text.toLowerCase()).not.toMatch(/(told|notified|informed|alerted|let) (the studio|them|us)/);
    expect(text.toLowerCase()).not.toMatch(/letting (us|them|the studio) know/);
    expect(text.toLowerCase()).not.toMatch(/studio (knows|will know|has been)/);
  });
});
