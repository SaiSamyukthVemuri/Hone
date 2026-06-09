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

describe("AppointmentLifecycleActions: two-click confirm", () => {
  it("runComplete asks for confirmation via window.confirm before the action runs", () => {
    expect(COMPONENT).toMatch(
      /function runComplete\([\s\S]{0,2000}window\.confirm\(COMPLETE_CONFIRM_MESSAGE\)/,
    );
  });

  it("declares COMPLETE_CONFIRM_MESSAGE with the exact prompt copy", () => {
    expect(COMPONENT).toMatch(
      /COMPLETE_CONFIRM_MESSAGE\s*=\s*[\s\S]{0,200}This marks the appointment completed and allows the session to be charged after charting\./,
    );
  });

  it("a cancelled confirm sets the 'Cancelled, no change made.' hint", () => {
    // The cancel-confirm hint is shared by both runNoShow and
    // runComplete; we check there are at least two occurrences so
    // both runs surface the same UX.
    const matches =
      COMPONENT.match(/setHint\("Cancelled, no change made\.\"\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("AppointmentLifecycleActions: success message", () => {
  it("runComplete sets the success hint to 'Appointment marked completed.'", () => {
    expect(COMPONENT).toMatch(
      /setHint\("Appointment marked completed\."\)/,
    );
  });

  it("runComplete forwards appointment_id via FormData", () => {
    const block =
      COMPONENT.match(/function runComplete\([\s\S]{0,2000}router\.refresh/)?.[0] ??
      "";
    expect(block).toMatch(/fd\.set\("appointment_id", appointmentId\)/);
  });

  it("runComplete calls markAppointmentCompleteAction inside the transition", () => {
    expect(COMPONENT).toMatch(
      /startTransition\(async \(\) => \{[\s\S]{0,400}markAppointmentCompleteAction\(fd\)/,
    );
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
