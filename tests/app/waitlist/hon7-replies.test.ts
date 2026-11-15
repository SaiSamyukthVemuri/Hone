import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

  it("the owner module logs nothing and never touches a table directly", () => {
    expect(LIB).not.toMatch(/console\.|logger|\.from\(/);
    expect(read("lib/waitlist/needs-attention.ts")).not.toMatch(/times_feedback/);
  });

  // TREE-WIDE: the allowlist says this module is imported only by the owner-gated
  // pages. That is enforced here, by walking every source file, not asserted.
  it("listTimesFeedback is imported ONLY by the replies page; the count only by the two owner pages", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const rel = `${dir}/${name}`;
        const st = statSync(join(ROOT, rel));
        if (st.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(name)) files.push(rel);
      }
    };
    for (const d of ["app", "lib", "components"]) walk(d);
    const importing = (sym: string) =>
      files.filter((f) => f !== "lib/waitlist/times-feedback-owner.ts" && new RegExp(`\\b${sym}\\b`).test(read(f))).sort();
    expect(importing("listTimesFeedback")).toEqual(["app/(app)/settings/waitlist/replies/page.tsx"]);
    expect(importing("countTimesFeedback")).toEqual([
      "app/(app)/settings/waitlist/page.tsx",
      "app/(app)/settings/waitlist/replies/page.tsx",
    ]);
    expect(importing("acknowledgeTimesFeedback")).toEqual(["app/(app)/settings/waitlist/replies/actions.ts"]);
  });

  it("a failed acknowledge is shown, and the flag-off page says it is not available yet", () => {
    expect(ACT).toContain("?ack=failed");
    expect(ACT).not.toMatch(/catch\s*\{\s*\}/);
    expect(PAGE).toContain('role="alert"');
    expect(PAGE).toContain("Not available yet.");
    expect(PAGE.indexOf("Not available yet.")).toBeGreaterThan(PAGE.indexOf('practitioner.role !== "owner"'));
  });

  it("says the list is capped when there are more than it shows", () => {
    expect(PAGE).toMatch(/Showing the oldest \{list\.rows\.length\} of \{total\.n\}/);
  });

  it("states what was true when they replied", () => {
    expect(PAGE).toContain("was returned to the");
    expect(PAGE).toContain("when they replied");
    expect(CARD).toContain("returned to the");
  });

  it("acknowledges by invitation id", () => {
    expect(LIB).toContain("p_invitation_id: invitationId");
    expect(ACT).toContain('formData.get("invitationId")');
  });
});
