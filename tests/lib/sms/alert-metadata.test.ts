import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #155: logSmsFailure has accepted optional studioId since PR #153,
// but the appointment SMS path in lib/sms/send-appointment.ts was not
// passing it. ops_alerts rows for sms_send_failed were therefore landing
// with studio_id = null. This test codifies "the SMS failure path threads
// studio_id" as a textual invariant of the file so a regression PR that
// drops the field is caught by `npm test`.

const SOURCE_PATH = path.resolve(
  __dirname,
  "../../../lib/sms/send-appointment.ts",
);
const SOURCE = readFileSync(SOURCE_PATH, "utf8");

describe("SMS appointment failure path stamps studio_id on ops alerts", () => {
  it("every logSmsFailure call inside sendOne passes studioId", () => {
    // sendOne is the single private execution path every public SMS
    // helper funnels through. Both failure branches (non-OK Twilio
    // result + caught exception) must include studioId. Count the
    // logSmsFailure call sites and assert the studioId line appears at
    // least once per call.
    const logFailureCalls = SOURCE.match(/logSmsFailure\(\{[\s\S]*?\}\);/g) ?? [];
    expect(logFailureCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of logFailureCalls) {
      expect(call).toMatch(/studioId:\s*args\.studio\.id/);
    }
  });

  it("does not leak studioId from passesConsentGate's logic path", () => {
    // Sanity check: the consent gate function itself does not branch on
    // studio.id (the field is metadata only). If a future change makes
    // the gate consult studio.id we want to know.
    const consentFn =
      SOURCE.match(/function passesConsentGate[\s\S]*?\n\}/)?.[0] ?? "";
    expect(consentFn).not.toMatch(/studio\.id/);
  });
});
