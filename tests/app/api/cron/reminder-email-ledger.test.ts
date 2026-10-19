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
    const begin = PASS.indexOf("await beginAppointmentEmailMessage(admin, ledgerRef)");
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeGreaterThan(PASS.indexOf("await claimEmailSend(admin, appt.id, emailType)"));
    expect(begin).toBeGreaterThan(PASS.indexOf('fresh.status !== "confirmed"'));
    expect(begin).toBeGreaterThan(PASS.indexOf("if (!wantsReminder && !intakeIncomplete)"));
    expect(begin).toBeLessThan(PASS.indexOf("result = await sendFn("));
  });

  it("begins it after ALL PREPARATION, so no path can leave a claimed row (Codex P2 4307698580)", () => {
    // `begin` leaves the row `claimed`, and nothing reports a row stuck there.
    // Two paths used to skip the settle entirely: an unmintable token
    // `continue`s the loop, and `getTreatmentTimeContextForEmail` can THROW.
    // Both sat BETWEEN the old begin and the send.
    const begin = PASS.indexOf("await beginAppointmentEmailMessage(admin, ledgerRef)");
    expect(begin).toBeGreaterThan(PASS.indexOf("generateCancellationToken(appt.id"));
    expect(begin).toBeGreaterThan(PASS.indexOf("await getTreatmentTimeContextForEmail("));
    // ...and nothing that could leave the loop sits between the first begin and
    // the send it is for. A `continue` there is the leak in its purest form.
    const send = PASS.indexOf("result = await sendFn(");
    expect(send).toBeGreaterThan(begin);
    // FROM AFTER the begin LINE: slicing from `begin` includes the begin call
    // itself, whose own `await` makes "no await between" trivially false. My
    // first version did exactly that and failed on its own boundary.
    const afterBegin = PASS.indexOf("\n", begin) + 1;
    expect(PASS.slice(afterBegin, send)).not.toContain("continue");
    expect(PASS.slice(afterBegin, send)).not.toContain("await ");
  });

  it("each branch begins its OWN row, immediately before its own provider call", () => {
    // Two sends, two begins — one per branch — rather than one begin shared
    // across a decision that can still fail.
    expect(PASS.match(/await beginAppointmentEmailMessage\(admin, ledgerRef\)/g)).toHaveLength(2);
    const intakeBegin = PASS.lastIndexOf("await beginAppointmentEmailMessage(admin, ledgerRef)");
    const intakeSend = PASS.indexOf("result = await sendIntakeReminderToClient(");
    expect(intakeBegin).toBeLessThan(intakeSend);
    const afterIntakeBegin = PASS.indexOf("\n", intakeBegin) + 1;
    expect(PASS.slice(afterIntakeBegin, intakeSend)).not.toContain("await ");
    expect(PASS.slice(afterIntakeBegin, intakeSend)).not.toContain("continue");
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
    // Computed ONCE into `ledgerRef`, so both branches cannot disagree about
    // which window they are reporting.
    expect(PASS).toContain('? ("appointment_reminder_24h" as const)');
    expect(PASS).toContain(': ("appointment_reminder_2h" as const)');
    expect(PASS).toContain("const ledgerRef = {");
    expect(PASS).toContain("appointmentId: appt.id");
  });
});
