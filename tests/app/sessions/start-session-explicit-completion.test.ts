import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// HON-45 (Sam's decision, reversing PR #180): starting a chart does NOT complete the appointment.
// Completion is the practitioner's separate, explicit act (Finish appointment / Mark completed), which
// itself neither sends postcare nor takes payment. This file replaces the PR #180 pins and is the
// tripwire against the auto-complete coming back.

const ACTIONS = readFileSync(
  path.resolve(__dirname, "../../../app/(app)/clients/[id]/sessions/new/actions.ts"),
  "utf8",
);
const CODE = ACTIONS.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

describe("startSessionAction: explicit completion (HON-45)", () => {
  it("has no auto-complete helper", () => {
    expect(CODE).not.toMatch(/maybeMarkAppointmentCompletedOnSessionStart/);
    expect(CODE).not.toMatch(/session_start_auto_mark_complete/);
  });

  it("never names the completion command, the admin client or the postcare sender", () => {
    expect(CODE).not.toMatch(/mark_appointment_complete/);
    expect(CODE).not.toMatch(/admin-server|createAdminClient/);
    expect(CODE).not.toMatch(/autoSendPostcareOnComplete|postcare-auto-send/);
  });

  it("still refreshes the appointment page after linking the chart, after the session exists and before the redirect", () => {
    const reval = CODE.indexOf("revalidatePath(`/calendar/${appointmentId}`)");
    const redirectAt = CODE.lastIndexOf("redirect(`/clients/${clientId}/sessions/${sessionId}`)");
    expect(reval).toBeGreaterThan(-1);
    expect(redirectAt).toBeGreaterThan(reval);
  });

  it("states the decision where the next reader will look", () => {
    expect(ACTIONS).toMatch(/starting a chart does NOT complete the appointment/);
  });
});
