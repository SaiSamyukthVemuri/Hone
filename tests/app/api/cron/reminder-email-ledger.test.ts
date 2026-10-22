import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ===========================================================================
// DELIVERY-VISIBILITY-01: the reminder email pass joins the delivery ledger.
// SOURCE CONTRACT, in the style of reminder-email-claim.test.ts.
//
// 0247 (D8 extension): the route's email pass no longer begins, tags or
// settles a ledger row itself. The governed operation does, so the contract
// moves with it:
//   - the route pass makes no ledger call and reaches the provider only through
//     sendAppointmentReminderOperation;
//   - inside the operation, the row is begun only AFTER inspect, a successful
//     prepare and the complete render (so no path can leave a claimed row for a
//     send that preparation already refused), it is tagged before the payload
//     freeze, and it is settled through one helper.
// Two legacy invariants are DELIBERATELY changed, not lost (Willow E1/E2):
//   - begin -> SDK now spans the authorize RPC and the dispatch adapter. Every
//     in-process exit is settled SDK0 by the finally; a KILLED invocation
//     (function timeout) can still leave a claimed secondary row. That row is
//     observational only; the primary 0247 authority is unaffected.
//   - the secondary settle now runs AFTER the primary observe record, never
//     before it: secondary bookkeeping never replaces primary effect truth.
// Settlement behaviour (accepted / held SDK0 / lost grant) is proven in
// tests/lib/email/appointment-send-transport.test.ts; the database side in
// tests/db/email-delivery-events.db.test.ts and tests/db/delivery-incidents.db.test.ts.
// ===========================================================================

const codeOnly = (source: string) =>
  source
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
const ROUTE = codeOnly(
  readFileSync(path.resolve(__dirname, "../../../../app/api/cron/appointment-reminders/route.ts"), "utf8"),
);
const SEND = codeOnly(readFileSync(path.resolve(__dirname, "../../../../lib/email/send-appointment.ts"), "utf8"));
const PASS = ROUTE.slice(ROUTE.indexOf("async function sendReminderPass"), ROUTE.indexOf("async function sendSmsReminderPass"));
// To the next top-level declaration of ANY kind, so a trailing export cannot be
// credited to the operation.
const OP_START = SEND.indexOf("export async function sendAppointmentReminderOperation");
const OP_NEXT = SEND.slice(OP_START + 1).search(/\n(export |async function |function |const |type |interface )/);
const OP = SEND.slice(OP_START, OP_NEXT === -1 ? undefined : OP_START + 1 + OP_NEXT);

describe("reminder email pass: begin, tag, settle (0247 operation)", () => {
  it("the slices are real", () => {
    expect(PASS.length).toBeGreaterThan(200);
    expect(PASS).toContain("await sendAppointmentReminderOperation(admin, appt.studio_id, appt.id, emailType)");
    expect(OP_START).toBeGreaterThan(-1);
    expect(OP.length).toBeGreaterThan(2000);
  });

  it("the route pass makes no ledger call of its own", () => {
    for (const call of ["beginAppointmentEmailMessage(", "settleEmailMessage(", "ledgerMessageId", "claimEmailSend", "recordEmailResult("]) {
      expect(PASS).not.toContain(call);
    }
  });

  it("begins exactly one row, only after inspect, a successful prepare and the complete render", () => {
    expect(OP.match(/await beginAppointmentEmailMessage\(admin,/g)).toHaveLength(1);
    const begin = OP.indexOf("await beginAppointmentEmailMessage(admin,");
    expect(begin).toBeGreaterThan(OP.indexOf('admin.rpc("inspect_appointment_email_operation"'));
    expect(begin).toBeGreaterThan(OP.indexOf('if (prepared.data.kind === "held") return held;'));
    expect(begin).toBeGreaterThan(OP.indexOf("const payload = buildAppointmentEmailOperationPayload(render, purpose); if (!payload) return held;"));
    expect(begin).toBeLessThan(OP.indexOf('admin.rpc("authorize_appointment_email_operation"'));
  });

  it("tags the payload before the freeze and names the window's own purpose", () => {
    const begin = OP.indexOf("await beginAppointmentEmailMessage(admin,");
    const tag = OP.indexOf("tags: [{ name: EMAIL_LEDGER_TAG, value: ledgerMessageId }]");
    expect(tag).toBeGreaterThan(begin);
    expect(tag).toBeLessThan(OP.indexOf("createProjectedEmailOperationDispatchAdapter("));
    expect(OP).toContain('purpose === "reminder_24h" ? "appointment_reminder_24h" : "appointment_reminder_2h"');
  });

  it("settles through one helper, and settles a begun row that never reached the provider", () => {
    expect(OP.match(/await settleEmailMessage\(admin, ledgerMessageId, outcome\)/g)).toHaveLength(1);
    expect(OP).toContain('!sdkAttempted ? { outcome: "skipped" as const, skipReason: "operation_held" as const }');
    expect(OP).toContain("if (ledgerMessageId && !sdkAttempted && !ledgerSettlementAttempted) await settleSecondary();");
  });

  it("settles the secondary row only AFTER the primary observation is recorded", () => {
    const observe = OP.indexOf('admin.rpc("observe_appointment_email_operation"');
    expect(observe).toBeGreaterThan(-1);
    expect(OP.indexOf("finally { await settleSecondary(observation); }")).toBeGreaterThan(observe);
  });
});
