import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 0319 owner surface — SOURCE guards (Privacy C6). Behaviour is in the DB tests.

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const LIB = read("lib/waitlist/times-feedback-owner.ts");
const PAGE = read("app/(app)/settings/waitlist/replies/page.tsx");
const ACT = read("app/(app)/settings/waitlist/replies/actions.ts");
const CARD = read("app/(app)/settings/waitlist/page.tsx");

describe("0319 owner replies surface", () => {
  it("takes the actor from the session, never from a form field", () => {
    expect(ACT).toMatch(/getCurrentPractitionerWithStudio\(\)/);
    expect(ACT).toMatch(/practitioner\.user_id/);
    expect(ACT).not.toMatch(/formData\.get\("(studioId|userId|actor)/);
    expect(ACT.indexOf('practitioner.role !== "owner"')).toBeLessThan(ACT.indexOf("acknowledgeTimesFeedback("));
  });

  it("the list page refuses a non-owner before it reads, and is flag-gated", () => {
    expect(PAGE.indexOf('practitioner.role !== "owner"')).toBeLessThan(PAGE.indexOf("listTimesFeedback("));
    expect(PAGE).toContain("waitlistTimesFeedbackEnabled()");
  });

  it("the settings card reads the COUNT only, and only behind the flag", () => {
    expect(CARD).toContain("countTimesFeedback(");
    expect(CARD).not.toMatch(/\blistTimesFeedback\b/);
    expect(CARD).toMatch(/waitlistTimesFeedbackEnabled\(\)\s*\? await countTimesFeedback/);
  });

  it("only the list page reads a note, and nothing logs or selects text elsewhere", () => {
    expect(LIB).not.toMatch(/console\.|logger|\.from\(/);
    expect((LIB.match(/\bnote\b/g) ?? []).length).toBeGreaterThan(0);
    expect(CARD).not.toMatch(/\.note\b/);
    expect(read("lib/waitlist/needs-attention.ts")).not.toMatch(/times_feedback/);
  });

  it("acknowledges by invitation id", () => {
    expect(LIB).toContain("p_invitation_id: invitationId");
    expect(ACT).toContain('formData.get("invitationId")');
  });
});
