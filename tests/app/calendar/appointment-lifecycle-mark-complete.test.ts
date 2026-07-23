import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #180. Source-grep tests pin the load-bearing shape of the
// re-introduced "Mark completed" button on the appointment lifecycle
// surface. The action + RPC predate PR #180; the regression risk
// here is the BUTTON, which was deliberately removed earlier and is
// now back. Tests pin: button presence, gating, two-click confirm,
// success message, and the absence of any cancelled/no-show flip.

const COMPONENT_PATH = path.resolve(
  __dirname,
  "../../../app/(app)/calendar/AppointmentLifecycleActions.tsx",
);
const COMPONENT = readFileSync(COMPONENT_PATH, "utf8");

const ACTIONS_PATH = path.resolve(
  __dirname,
  "../../../app/(app)/calendar/actions.ts",
);
const ACTIONS = readFileSync(ACTIONS_PATH, "utf8");

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

describe("AppointmentLifecycleActions: Mark completed button restoration", () => {
  it("imports markAppointmentCompleteAction from the calendar actions module", () => {
    expect(COMPONENT).toMatch(
      /import \{\s*\n?\s*markAppointmentCompleteAction,\s*\n?\s*markAppointmentNoShowAction,\s*\n?\s*\} from "\.\/actions"/,
    );
  });

  it("renders a 'Mark completed' button", () => {
    expect(COMPONENT).toMatch(/>\s*Mark completed\s*</);
  });

  it("the Mark completed button uses the primary (filled) styling so it is obvious", () => {
    // The primary styling is `bg-neutral-900 ... text-white`; pin
    // that the Mark completed button uses it rather than the
    // outline-only variant used by Mark no-show.
    const block =
      COMPONENT.match(
        /<button[\s\S]{0,2000}onClick=\{runComplete\}[\s\S]{0,2000}Mark completed/,
      )?.[0] ?? "";
    expect(block).toMatch(/bg-neutral-900/);
    expect(block).toMatch(/text-white/);
  });
});

describe("AppointmentLifecycleActions: Mark completed gating", () => {
  it("the component returns null for non-confirmed statuses", () => {
    expect(COMPONENT).toMatch(/if \(status !== "confirmed"\) return null;/);
  });

  it("the Mark completed button is disabled when pending OR !hasEnded", () => {
    const block =
      COMPONENT.match(
        /<button[\s\S]{0,2000}onClick=\{runComplete\}[\s\S]{0,2000}Mark completed/,
      )?.[0] ?? "";
    expect(block).toMatch(/disabled=\{pending \|\| !hasEnded\}/);
  });

  it("the disabled-title copy matches the future-appointment guidance", () => {
    // PR #180 patch. Original copy ("after the start time") was
    // inaccurate -- the gate is ends_at <= now() (the RPC requires
    // the appointment to have ENDED, not merely started). Corrected
    // copy is pinned here.
    const block =
      COMPONENT.match(
        /onClick=\{runComplete\}[\s\S]{0,2000}Mark completed/,
      )?.[0] ?? "";
    expect(block).toMatch(
      /Appointment can be marked completed after the appointment has ended\./,
    );
  });

  it("hasEnded is computed from endsAtMs <= nowTick (already-ended check)", () => {
    expect(COMPONENT).toMatch(/const hasEnded = /);
    expect(COMPONENT).toMatch(/endsAtMs <= nowTick/);
  });
});

describe("AppointmentLifecycleActions: confirmation dialog (replaces window.confirm)", () => {
  // Chloe workflow fix. The confirmation step is now an in-DOM accessible
  // dialog, not native window.confirm(), because window.confirm can be
  // silently suppressed on iOS Safari (returns false with nothing shown),
  // which the old code treated as a Cancel — so "Mark completed" did nothing.

  it("imports and renders the accessible ConfirmDialog", () => {
    expect(COMPONENT).toMatch(
      /import \{ ConfirmDialog \} from "@\/components\/confirm-dialog"/,
    );
    // One dialog per action (complete + no-show).
    const dialogs = COMPONENT.match(/<ConfirmDialog\b/g) ?? [];
    expect(dialogs.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT use window.confirm anywhere (the iOS-suppressible API is gone)", () => {
    const code = codeOnly(COMPONENT);
    expect(code).not.toMatch(/window\.confirm/);
    expect(code).not.toMatch(/\bconfirm\(/);
  });

  it("declares COMPLETE_CONFIRM_MESSAGE with the exact confirm copy", () => {
    expect(COMPONENT).toMatch(
      /COMPLETE_CONFIRM_MESSAGE\s*=\s*[\s\S]{0,200}This marks the appointment completed and allows the session to be charged after charting\./,
    );
  });

  it("declares NO_SHOW_CONFIRM_MESSAGE with separate, truthful copy", () => {
    expect(COMPONENT).toMatch(
      /NO_SHOW_CONFIRM_MESSAGE\s*=\s*[\s\S]{0,200}records that the appointment was missed and cannot be undone from this screen\./,
    );
  });

  it("each dialog carries a distinct confirm label so the copy is action-specific", () => {
    expect(COMPONENT).toMatch(/confirmLabel="Mark completed"/);
    expect(COMPONENT).toMatch(/confirmLabel="Mark no-show"/);
  });

  it("the buttons OPEN the dialog and send NO request (setConfirming, no action call)", () => {
    // runComplete / runNoShow only set which dialog is open; they must not
    // call a server action directly.
    const runComplete =
      COMPONENT.match(/function runComplete\(\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? "";
    const runNoShow =
      COMPONENT.match(/function runNoShow\(\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? "";
    expect(runComplete).toMatch(/setConfirming\("complete"\)/);
    expect(runNoShow).toMatch(/setConfirming\("no_show"\)/);
    expect(runComplete).not.toMatch(/markAppointment(Complete|NoShow)Action/);
    expect(runNoShow).not.toMatch(/markAppointment(Complete|NoShow)Action/);
  });

  it("Cancel sends NO request: handleCancel closes and sets the calm hint only", () => {
    const handleCancel =
      COMPONENT.match(/function handleCancel\(\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? "";
    expect(handleCancel).toMatch(/setConfirming\(null\)/);
    expect(handleCancel).toMatch(/setHint\("Cancelled, no change made\."\)/);
    expect(handleCancel).not.toMatch(/markAppointment(Complete|NoShow)Action/);
    expect(handleCancel).not.toMatch(/startTransition/);
  });
});

describe("AppointmentLifecycleActions: confirm runs the action once", () => {
  const handleConfirm =
    COMPONENT.match(/function handleConfirm\(\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? "";

  it("handleConfirm forwards appointment_id via FormData", () => {
    expect(handleConfirm).toMatch(/fd\.set\("appointment_id", appointmentId\)/);
  });

  it("handleConfirm calls the correct action inside a transition", () => {
    expect(handleConfirm).toMatch(/startTransition\(async \(\) => \{/);
    expect(handleConfirm).toMatch(/markAppointmentCompleteAction\(fd\)/);
    expect(handleConfirm).toMatch(/markAppointmentNoShowAction\(fd\)/);
  });

  it("guards against a double request (early-return while pending; dialog disables Confirm)", () => {
    expect(handleConfirm).toMatch(/if \(pending\) return;/);
    // The dialog is told the pending state so its Confirm button is disabled
    // while a request is in flight — one request maximum per confirmation.
    expect(COMPONENT).toMatch(/pending=\{pending\}/);
  });

  it("sets the success hint 'Appointment marked completed.' and refreshes on success", () => {
    expect(handleConfirm).toMatch(/Appointment marked completed\./);
    expect(handleConfirm).toMatch(/router\.refresh\(\)/);
  });

  it("surfaces the action's own SAFE error (no raw DB/provider text) in the dialog", () => {
    // The server actions map every RPC failure to curated copy; the component
    // shows res.error (with a fixed fallback) and never fabricates DB text.
    expect(handleConfirm).toMatch(/setError\(res\.error \|\| GENERIC_FAILURE\)/);
  });
});

describe("AppointmentLifecycleActions: cancelled / no_show paths unchanged", () => {
  it("the no-show button still renders with its existing handler", () => {
    expect(COMPONENT).toMatch(
      /<button[\s\S]{0,2000}onClick=\{runNoShow\}[\s\S]{0,2000}Mark no-show/,
    );
  });

  it("cancelled / no_show / completed appointments return null (no buttons)", () => {
    // The early return guards every terminal-state appointment so
    // neither Mark completed nor Mark no-show renders.
    expect(COMPONENT).toMatch(/status !== "confirmed"/);
  });

  it("the component does NOT add any 'restore' / 'reopen' affordance", () => {
    // PR #180 deliberately does not introduce any way to reverse a
    // terminal status. The no-show confirm message legitimately
    // contains the word "undone" ("cannot be undone from this
    // screen"); pin only the truly forbidden words.
    expect(COMPONENT).not.toMatch(/\b(restore|reopen)\b/i);
  });
});

describe("markAppointmentCompleteAction (unchanged): RPC + scoping", () => {
  it("still calls the mark_appointment_complete RPC with p_appointment_id / p_studio_id / p_practitioner_id", () => {
    expect(ACTIONS).toMatch(
      /admin\.rpc\("mark_appointment_complete",\s*\{[\s\S]{0,400}p_appointment_id:\s*appointmentId[\s\S]{0,200}p_studio_id:\s*studio\.id[\s\S]{0,200}p_practitioner_id:\s*practitioner\.id/,
    );
  });

  it("still refuses inactive practitioners with a user-friendly message", () => {
    expect(ACTIONS).toMatch(
      /Inactive practitioners cannot mark appointments complete\./,
    );
  });

  it("still maps 'not yet ended' to a user-friendly message", () => {
    expect(ACTIONS).toMatch(/This appointment hasn't ended yet\./);
  });

  it("still maps 'not confirmed' to a user-friendly message", () => {
    expect(ACTIONS).toMatch(
      /Only confirmed appointments can be marked complete\./,
    );
  });

  it("still revalidates /calendar + /calendar/<id> on success", () => {
    expect(ACTIONS).toMatch(/revalidatePath\("\/calendar"\)/);
    expect(ACTIONS).toMatch(
      /revalidatePath\(`\/calendar\/\$\{appointmentId\}`\)/,
    );
  });
});

describe("AppointmentLifecycleActions: forbidden surface (PR #180 scope)", () => {
  it("does NOT introduce any Stripe SDK call (code only)", () => {
    const code = codeOnly(COMPONENT);
    expect(code).not.toMatch(/paymentIntents\.create|refunds\.create|charges\.create|checkout\.sessions/);
  });

  it("does NOT touch payment_charge_attempts or session_payment", () => {
    const code = codeOnly(COMPONENT);
    expect(code).not.toMatch(/payment_charge_attempts|session_payment_/);
  });

  it("does NOT add SMS / email triggers", () => {
    const code = codeOnly(COMPONENT);
    expect(code).not.toMatch(/sendEmailSafely|sendSms|twilio/i);
  });
});
