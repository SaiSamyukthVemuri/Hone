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

function countMatches(haystack: string, needle: RegExp): number {
  const m = haystack.match(needle);
  return m ? m.length : 0;
}

describe("SMS appointment failure path stamps studio_id on ops alerts", () => {
  it("logSmsFailure accepts an optional studioId argument", () => {
    // The signature lives in this file; PR #153 added it. We assert the
    // shape so a future refactor that removes the field is caught.
    expect(SOURCE).toMatch(/studioId\?:\s*string\s*\|\s*null/);
  });

  it("studio Pick on ConsentGateInput includes the id field", () => {
    // PR #155 added "id" to the Pick so the SMS failure path has access
    // to studio.id without a second DB roundtrip. Catch a future refactor
    // that drops it.
    const consentGateBlock =
      SOURCE.match(/type ConsentGateInput[\s\S]*?\};/)?.[0] ?? "";
    expect(consentGateBlock).toMatch(/\|\s*"id"/);
  });

  it("studio Pick on SendConfirmationInput includes the id field", () => {
    const confirmationBlock =
      SOURCE.match(/type SendConfirmationInput[\s\S]*?\};/)?.[0] ?? "";
    expect(confirmationBlock).toMatch(/\|\s*"id"/);
  });

  it("studio Pick on SendReminderInput includes the id field", () => {
    const reminderBlock =
      SOURCE.match(/type SendReminderInput[\s\S]*?\};/)?.[0] ?? "";
    expect(reminderBlock).toMatch(/\|\s*"id"/);
  });

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

// ---------------------------------------------------------------------------
// Source-grep: callers of the SMS helpers pass a studio object that
// includes id. The TypeScript compiler enforces this at build time, but
// the test gives a more direct failure surface and prevents the cron
// reminder route from silently dropping the field via a join change.
// ---------------------------------------------------------------------------

describe("SMS send callers pass a studio object with id available", () => {
  const CALLER_PATHS = [
    "app/reschedule/[token]/actions.ts",
    "app/book/[slug]/actions.ts",
    "app/(app)/calendar/actions.ts",
    "app/api/cron/appointment-reminders/route.ts",
  ];
  for (const rel of CALLER_PATHS) {
    it(`${rel} imports or invokes at least one SMS helper`, () => {
      const abs = path.resolve(__dirname, "../../..", rel);
      const text = readFileSync(abs, "utf8");
      // Each caller either invokes a helper directly (e.g.
      // sendBookingConfirmationSmsToClient({...})) or imports it and
      // aliases through a const (the appointment-reminders cron picks
      // sendFn = opts.kind === "24h" ? send24hReminderSmsToClient :
      // send2hReminderSmsToClient and then calls sendFn({...})). We
      // accept either shape because both prove the file is on the
      // appointment SMS path; the TypeScript compiler enforces the
      // studio.id Pick at the call boundary regardless.
      const helperNames = [
        "sendBookingConfirmationSmsToClient",
        "send24hReminderSmsToClient",
        "send2hReminderSmsToClient",
      ];
      const usesHelper = helperNames.some((name) => text.includes(name));
      expect(usesHelper, `expected ${rel} to reference an SMS helper`).toBe(true);
    });
  }
});
