import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// HON-45 (Sam): Finish, Send postcare and Charge are three SEPARATE, clearly labelled actions. Finish never charges.
const root = path.resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const PAGE = read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx");
const POSTCARE_BUTTON = read("app/(app)/calendar/PostcareSendButton.tsx");
const PAYMENT_CARD = read("components/session-payment-prepare-card.tsx");
const MARK_COMPLETE = read("components/appointment/mark-complete-control.tsx");
const COMPLETE_ACTION = read("app/(app)/calendar/actions.ts");
const ELIGIBILITY = read("lib/billing/session-payment-eligibility.ts");

describe("three distinct actions, three distinct labels", () => {
  it("postcare is labelled Send/Resend postcare; the charge is labelled Run charge; neither word appears on the other", () => {
    expect(POSTCARE_BUTTON).toMatch(/isResend \? "Resend postcare" : "Send postcare"/);
    expect(PAYMENT_CARD).toMatch(/"Run charge"/);
    expect(POSTCARE_BUTTON).not.toMatch(/Run charge/);
    expect(PAYMENT_CARD).not.toMatch(/Send postcare|Resend postcare/);
  });

  it("the completion control is its own labelled control, with no postcare or charge wording", () => {
    expect(MARK_COMPLETE).toMatch(/Mark completed|Mark complete/);
    expect(MARK_COMPLETE).not.toMatch(/Send postcare|Run charge|Charge card/);
  });

  it("the Finish panel names completion and postcare as separate sections and offers no charge button of its own", () => {
    const finish = PAGE.slice(PAGE.indexOf("Finish appointment"));
    expect(finish).toMatch(/Appointment completed/);
    expect(finish).toMatch(/Postcare email/);
    // The panel hands payment to the existing payment card component; it does not render a charge button itself.
    expect(PAGE).not.toMatch(/>\s*Run charge\s*</);
  });
});

describe("Finish writes completion only; the other actions stay available after it", () => {
  it("the completion action never references payments or charges", () => {
    const start = COMPLETE_ACTION.indexOf("export async function markAppointmentCompleteAction");
    const end = COMPLETE_ACTION.indexOf("export async function markAppointmentNoShowAction");
    const body = COMPLETE_ACTION.slice(start, end);
    expect(body).not.toMatch(/payment|charge|stripe|refund/i);
  });

  it("a charge becomes AVAILABLE only once the appointment is completed, with the reason stated before that", () => {
    expect(ELIGIBILITY).toMatch(/appointmentSummary\.status !== "completed"/);
    expect(ELIGIBILITY).toMatch(/Mark the appointment complete before preparing a session payment/);
  });

  it("postcare is sendable by hand after completion: the send command refuses anything but a completed appointment", () => {
    expect(read("app/(app)/calendar/postcare-auto-send.ts")).toMatch(/refuses any\s*\/\/\s*status other than 'completed'|status other than 'completed'/);
  });
});
