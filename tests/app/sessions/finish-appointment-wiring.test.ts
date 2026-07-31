import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Structural contracts for the Finish appointment workflow. The pure states are
// proven in tests/lib/sessions/finish-appointment.test.ts; these prove the page
// ORDER, the SHARED controls, and that nothing was duplicated or auto-fired.

const read = (rel: string) =>
  readFileSync(path.resolve(__dirname, "../../..", rel), "utf8");

const PAGE = read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx");
const CONTROL = read("components/appointment/mark-complete-control.tsx");
const POSTCARE = read("components/appointment/postcare-section.tsx");
const CALENDAR_ACTIONS = read("app/(app)/calendar/AppointmentLifecycleActions.tsx");
const CALENDAR_PAGE = read("app/(app)/calendar/[id]/page.tsx");
const SEND_BUTTON = read("app/(app)/calendar/PostcareSendButton.tsx");
const DONE = read("app/(app)/clients/[id]/sessions/[sessionId]/DoneChartingButton.tsx");

const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

describe("page order: charting → Finish appointment → session payment", () => {
  it("renders the three in the practitioner's actual order", () => {
    const charting = PAGE.indexOf("<SessionBlocksView");
    const finish = PAGE.indexOf('data-testid="finish-appointment"');
    const payment = PAGE.indexOf('id="session-payment"');
    expect(charting).toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(charting);
    expect(payment).toBeGreaterThan(finish);
  });

  it("the payment block was MOVED, not rewritten — same wrapper, anchor, props", () => {
    const pay = PAGE.slice(
      PAGE.indexOf('id="session-payment"'),
      PAGE.indexOf("</div>", PAGE.indexOf("<SessionPaymentPrepareCard")),
    );
    for (const prop of [
      "sessionId={session.id}",
      "clientId={id}",
      "eligibility={sessionPaymentEligibility}",
      "defaultAmount={sessionPaymentDefault}",
      'isOwner={practitioner.role === "owner"}',
      "prepareAction={prepareSessionPaymentChargeAction}",
      "executeAction={executeSessionPaymentChargeAction}",
      "sendReceiptAction={sendPaymentChargeReceiptAction}",
      "refundAction={refundPaymentChargeAttemptAction}",
    ]) {
      expect(pay).toContain(prop);
    }
    // Exactly one payment card and one anchor.
    expect((PAGE.match(/<SessionPaymentPrepareCard/g) ?? []).length).toBe(1);
    // One rendered anchor DIV (the string also appears in the comment above it).
    expect((PAGE.match(/<div id="session-payment">/g) ?? []).length).toBe(1);
  });
});

describe("one control per fact", () => {
  it("exactly ONE practitioner-editable aftercare toggle on the page", () => {
    expect((PAGE.match(/<AftercareExplainedToggle/g) ?? []).length).toBe(1);
    // ...and it lives inside the Finish section.
    const finish = PAGE.slice(
      PAGE.indexOf('data-testid="finish-appointment"'),
      PAGE.indexOf('id="session-payment"'),
    );
    expect(finish).toContain("<AftercareExplainedToggle");
  });

  it("exactly ONE safe-exit control, at the foot of the Finish section", () => {
    expect((PAGE.match(/<DoneChartingButton/g) ?? []).length).toBe(1);
    const finish = PAGE.slice(
      PAGE.indexOf('data-testid="finish-appointment"'),
      PAGE.indexOf('id="session-payment"'),
    );
    expect(finish).toContain("<DoneChartingButton");
    expect(finish).toContain('label="Done — back to client"');
  });

  it("the safe-exit warning semantics are preserved intact", () => {
    // Never blocks, never auto-marks: both choices are explicit.
    expect(DONE).toMatch(/Continue without marking/);
    expect(DONE).toMatch(/aftercareExplained/);
    expect(code(DONE)).not.toMatch(/useEffect\([\s\S]{0,200}markAction/);
  });
});

describe("shared completion authority", () => {
  it("calendar and charting mount the SAME extracted control", () => {
    expect(CALENDAR_ACTIONS).toContain(
      'from "@/components/appointment/mark-complete-control"',
    );
    expect(PAGE).toContain('from "@/components/appointment/mark-complete-control"');
    expect(CALENDAR_ACTIONS).toContain("<MarkAppointmentCompleteControl");
    expect(PAGE).toContain("<MarkAppointmentCompleteControl");
  });

  it("the completion action + RPC logic is NOT duplicated", () => {
    // Exactly one component calls the action.
    for (const src of [PAGE, CALENDAR_ACTIONS, POSTCARE]) {
      expect(code(src)).not.toMatch(/markAppointmentCompleteAction\(/);
    }
    expect(code(CONTROL)).toMatch(/markAppointmentCompleteAction\(fd\)/);
    expect(code(PAGE)).not.toMatch(/mark_appointment_complete/);
  });

  it("calendar keeps Mark no-show; charting never shows it", () => {
    expect(CALENDAR_ACTIONS).toContain("Mark no-show");
    expect(code(CONTROL)).not.toMatch(/no-show/i);
    const finish = PAGE.slice(
      PAGE.indexOf('data-testid="finish-appointment"'),
      PAGE.indexOf('id="session-payment"'),
    );
    // Strip comments: the code explains WHY no-show is absent from charting,
    // and that prose must not be mistaken for a rendered control.
    expect(code(finish)).not.toMatch(/no-show/i);
    expect(code(PAGE)).not.toMatch(/markAppointmentNoShowAction/);
  });

  it("completion never navigates away — she must see the updated statuses", () => {
    const confirm =
      CONTROL.match(/function handleConfirm\(\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? "";
    expect(confirm).toMatch(/router\.refresh\(\)/);
    expect(confirm).not.toMatch(/router\.push|redirect\(|window\.location/);
  });

  it("completion never stamps aftercare and never sends postcare", () => {
    expect(code(CONTROL)).not.toMatch(/markAftercareExplainedAction|sendPostcareEmailAction/);
  });
});

describe("shared PostcareSection", () => {
  it("both surfaces mount ONE shared server component", () => {
    expect(CALENDAR_PAGE).toContain(
      'from "@/components/appointment/postcare-section"',
    );
    expect(PAGE).toContain('from "@/components/appointment/postcare-section"');
    // The calendar page's local implementation is gone.
    expect(CALENDAR_PAGE).not.toMatch(/function PostcareSection/);
    expect(PAGE).not.toMatch(/function PostcareSection/);
  });

  it("preview construction and configuration logic exist in exactly one place", () => {
    expect(POSTCARE).toContain("buildPostcareEmail({");
    expect(code(CALENDAR_PAGE)).not.toMatch(/buildPostcareEmail\(\{/);
    expect(code(PAGE)).not.toMatch(/buildPostcareEmail/);
    expect(POSTCARE).toMatch(/Configure postcare/);
    expect(code(PAGE)).not.toMatch(/Configure postcare/);
  });

  it("the no-client-email state is shared, explicit, and has no send button", () => {
    expect(POSTCARE).toContain("Postcare unavailable — no client email");
    expect(POSTCARE).toMatch(/hasClientEmail/);
    // Both surfaces pass the email so the shared state can render.
    expect(CALENDAR_PAGE).toMatch(/clientEmail=\{data\.client\?\.email \?\? null\}/);
    expect(PAGE).toMatch(/clientEmail=\{clientData\.client\.email \?\? null\}/);
  });

  it("carries no calendar-route coupling into the charting surface", () => {
    // It may import the send button (a client component) but must not link to,
    // redirect to, or assume the /calendar/[id] page.
    expect(code(POSTCARE)).not.toMatch(/href="\/calendar/);
    expect(code(POSTCARE)).not.toMatch(/redirect\(|useRouter|usePathname/);
  });
});

describe("durable postcare success", () => {
  it("a successful manual send refreshes the server-rendered parent", () => {
    expect(SEND_BUTTON).toMatch(/import \{ useRouter \} from "next\/navigation"/);
    const confirm = SEND_BUTTON.match(/function confirm\(\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? "";
    expect(confirm).toMatch(/router\.refresh\(\)/);
    // ...and ONLY after success: the failure branch returns before it.
    const failIdx = confirm.indexOf("setError(r.error)");
    const refreshIdx = confirm.indexOf("router.refresh()");
    expect(failIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(failIdx);
    expect(confirm.slice(failIdx, refreshIdx)).toMatch(/return;/);
  });

  it("'sent' is decided ONLY by postcare_email_sent_at", () => {
    // The durable label comes from alreadySentAt (the server-rendered
    // postcare_email_sent_at), never from the transient justSent state, the
    // claim, or the attempt count.
    expect(SEND_BUTTON).toMatch(/const isResend = alreadySentAt != null;/);
    expect(SEND_BUTTON).toMatch(/isResend \? "Resend postcare" : "Send postcare"/);
    expect(SEND_BUTTON).not.toMatch(/justSent \?[\s\S]{0,40}"Resend postcare"/);
  });
});

describe("scope containment", () => {
  it("no new completion/postcare server action was introduced", () => {
    const actions = read("app/(app)/calendar/actions.ts");
    expect(
      (actions.match(/export async function markAppointmentCompleteAction/g) ?? []).length,
    ).toBe(1);
    expect(
      (actions.match(/export async function sendPostcareEmailAction/g) ?? []).length,
    ).toBe(1);
    // And no combined one anywhere.
    expect(actions).not.toMatch(/completeAndSendPostcare|finishAppointmentAction/);
  });

  it("the appointment is joined by sessions.appointment_id, never by client id", () => {
    // The page's appointment id comes from the eligibility read, which embeds
    // appointments through sessions.appointment_id.
    expect(PAGE).toMatch(/sessionPaymentEligibility\.appointment\?\.id/);
    // The widened read is scoped by that id AND the studio.
    expect(PAGE).toMatch(/\.eq\("studio_id", studio\.id\)\s*\n\s*\.eq\("id", paymentApptId\)/);
    // No client-id-based appointment lookup.
    expect(code(PAGE)).not.toMatch(/from\("appointments"\)[\s\S]{0,300}eq\("client_id"/);
  });

  it("exactly ONE appointment read on the session page", () => {
    expect((PAGE.match(/from\("appointments"\)/g) ?? []).length).toBe(1);
  });

  it("the archived (finalized) record gets no Finish mutations", () => {
    const finish = PAGE.slice(
      PAGE.indexOf('data-testid="finish-appointment"'),
      PAGE.indexOf('id="session-payment"'),
    );
    // Every mutating control is behind !isFinalized.
    for (const guarded of [
      "<AftercareExplainedToggle",
      "<MarkAppointmentCompleteControl",
      "<PostcareSection",
      "<DoneChartingButton",
    ]) {
      const at = finish.indexOf(guarded);
      expect(at, `${guarded} present`).toBeGreaterThan(-1);
      expect(finish.slice(0, at)).toMatch(/!isFinalized|isFinalized \?/);
    }
    expect(finish).toContain("Back to sessions");
  });
});
