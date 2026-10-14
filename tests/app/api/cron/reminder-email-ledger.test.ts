import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ===========================================================================
// DELIVERY-VISIBILITY-01 — the reminder email pass joins the delivery ledger.
// SOURCE CONTRACT, in the style of reminder-email-claim.test.ts.
//
// The ledger row is begun only AFTER the 0080 claim, the live status re-check
// and the "nothing to send" exit, so it always describes a send that is about
// to happen. It tags BOTH sends the window can make, and it is settled BEFORE
// the claim result is recorded. Its behaviour against a real database is in
// tests/db/email-delivery-events.db.test.ts and tests/db/delivery-incidents.db.test.ts.
// ===========================================================================

const ROUTE = readFileSync(
  path.resolve(__dirname, "../../../../app/api/cron/appointment-reminders/route.ts"),
  "utf8",
);
const CODE = ROUTE.split("\n")
  .filter((line) => !/^\s*\/\//.test(line))
  .join("\n");
const PASS = CODE.slice(CODE.indexOf("async function sendReminderPass"), CODE.indexOf("async function sendSmsReminderPass"));

describe("reminder email pass: begin, tag, settle", () => {
  it("the pass slice is real", () => {
    expect(PASS.length).toBeGreaterThan(2000);
    expect(PASS).toContain("await claimEmailSend(admin, appt.id, emailType)");
  });

  it("begins the ledger row after the claim, the status re-check and the nothing-to-send exit", () => {
    const begin = PASS.indexOf("await beginAppointmentEmailMessage(admin, {");
    expect(begin).toBeGreaterThan(PASS.indexOf("await claimEmailSend(admin, appt.id, emailType)"));
    expect(begin).toBeGreaterThan(PASS.indexOf('fresh.status !== "confirmed"'));
    expect(begin).toBeGreaterThan(PASS.indexOf("if (!wantsReminder && !intakeIncomplete)"));
    expect(begin).toBeLessThan(PASS.indexOf("result = await sendFn("));
  });

  it("tags both sends the window can make", () => {
    expect(PASS.match(/ledgerMessageId,\n/g)).toHaveLength(2);
  });

  it("settles before the claim result is recorded, and only a row it began", () => {
    const settle = PASS.indexOf("await settleEmailMessage(admin, ledgerMessageId, settleOutcomeForEmailSend(result))");
    expect(settle).toBeGreaterThan(PASS.indexOf("result = await sendIntakeReminderToClient("));
    expect(settle).toBeLessThan(PASS.indexOf("await recordEmailResult(admin, appt.id, emailType, result.ok)"));
    expect(PASS.slice(settle - 40, settle)).toContain("if (ledgerMessageId)");
  });

  it("names the window's own purpose", () => {
    expect(PASS).toContain('purpose: opts.kind === "24h" ? "appointment_reminder_24h" : "appointment_reminder_2h"');
  });
});
