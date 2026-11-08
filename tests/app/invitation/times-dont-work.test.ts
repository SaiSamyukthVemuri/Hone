import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 0319 app wiring — SOURCE guards. Behaviour is proved in
// tests/db/waitlist-times-unsuitable.db.test.ts.

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const ACTIONS = read("app/invitation/[token]/actions.ts");
const LIB = read("lib/booking/waitlist-invitation.ts");
const SCREEN = read("app/features/waitlist-invitation/InvitationScreen.tsx");
const FLAG = read("lib/waitlist/times-feedback.ts");

const action = (() => {
  const i = ACTIONS.indexOf("export async function timesDontWorkAction");
  const j = ACTIONS.indexOf("export async function bookInvitationSlotAction", i);
  return ACTIONS.slice(i, j > i ? j : undefined);
})();

describe("0319 times-don't-work wiring", () => {
  it("is off unless the flag is exactly '1'", () => {
    expect(FLAG).toMatch(/process\.env\.WAITLIST_TIMES_FEEDBACK === "1"/);
  });

  it("flag off performs no write: it returns the current offer before any command", () => {
    const off = action.indexOf("if (!waitlistTimesFeedbackEnabled()) return loadInvitationAction(rawToken);");
    expect(off).toBeGreaterThan(0);
    expect(off).toBeLessThan(action.indexOf("declineTimesUnsuitable("));
  });

  it("the kept-on-list confirmation is returned only on returned_to_waiting", () => {
    expect((action.match(/keptOnList: true/g) ?? []).length).toBe(1);
    const k = action.indexOf("keptOnList: true");
    const guard = action.lastIndexOf('out.kind === "returned_to_waiting"', k);
    expect(guard).toBeGreaterThan(0);
    expect(k - guard).toBeLessThan(120);
  });

  it("never logs or echoes the recipient's text", () => {
    expect(action).not.toMatch(/console\.|logger|log\w*\(/);
    expect(action).not.toMatch(/note\s*[:,]\s*trimmed[^\n]*kind:/);
  });

  it("the wrapper fails closed and calls the 0319 command by name", () => {
    expect(LIB).toMatch(/rpc\("decline_waitlist_invitation_times_unsuitable"/);
    const w = LIB.slice(LIB.indexOf("export async function declineTimesUnsuitable"));
    expect(w).toMatch(/if \(error\) return \{ kind: "unavailable" \}/);
    expect(w).toMatch(/default:\s*return \{ kind: "unavailable" \}/);
  });

  it("the screen caps the text at the database cap and states the original place is kept", () => {
    expect(SCREEN).toMatch(/maxLength=\{500\}/);
    expect(SCREEN).toContain("original place");
    expect(SCREEN).toContain("nothing is booked or held in the meantime");
  });

  it("the existing decline stays as the flag-off footer", () => {
    expect(SCREEN).toContain("I can’t make any of these");
  });
});
