import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Privacy AI1 (0289): changing an existing performer is a CORRECTION through correct_session_performer with a reason, so 0289 cannot break
// the working feature (set_session_performer is first-attribution-only after 0289). A source-contract test; the behaviour is proved in
// tests/db/edit-record-protections-0289.db.test.ts (NOT RUN until the heavy slot).

const action = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/actions.ts", "utf8");
const body = action.slice(action.indexOf("export async function updateSessionPerformerAction"), action.indexOf("export type EditStartedAtResult"));
const line = readFileSync("components/session-performer-line.tsx", "utf8");

describe("the session performer change", () => {
  it("reads the current performer on the server and corrects an existing one with a reason", () => {
    expect(body).toContain('.select("performed_by_practitioner_id")');
    expect(body).toContain('rpc("correct_session_performer"');
    expect(body).toMatch(/p_reason: reason/);
    expect(body).toContain("give a reason for the correction");
  });
  it("only the first attribution uses set_session_performer, and the choice is not taken from the form", () => {
    expect(body).toContain('rpc("set_session_performer"');
    expect(body).toMatch(/current\.performed_by_practitioner_id === null/);
    expect(body).not.toMatch(/formData\.get\("(has_performer|mode)"\)/);
  });
  it("the page control asks for a reason before it corrects an existing performer", () => {
    expect(line).toContain("Reason for the correction");
    expect(line).toContain('fd.set("reason"');
    expect(line).toMatch(/if \(needsReason\) return;/);
  });
});
