import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #180. Source-grep tests pin the load-bearing shape of the
// re-introduced "Mark completed" button on the appointment lifecycle
// surface. The action + RPC predate PR #180; the regression risk
// here is the BUTTON, which was deliberately removed earlier and is
// now back. Tests pin: button presence, gating, two-click confirm,
// success message, and the absence of any cancelled/no-show flip.

// The completion control was EXTRACTED so the calendar surface and the
// charting "Finish appointment" workflow share one implementation instead of
// two lookalikes. Everything these tests pin still exists — it just lives in
// the shared control now, which is exactly the point: one place to regress.
const COMPONENT_PATH = path.resolve(
  __dirname,
  "../../../components/appointment/mark-complete-control.tsx",
);
const COMPONENT = readFileSync(COMPONENT_PATH, "utf8");

// The calendar surface itself, which still owns Mark no-show.
const CALENDAR_PATH = path.resolve(
  __dirname,
  "../../../app/(app)/calendar/AppointmentLifecycleActions.tsx",
);
const CALENDAR = readFileSync(CALENDAR_PATH, "utf8");

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
      /import \{\s*\n?\s*markAppointmentCompleteAction \} from "@\/app\/\(app\)\/calendar\/actions"/,
    );
    expect(CALENDAR).toMatch(
      /import \{ markAppointmentNoShowAction \} from "\.\/actions"/,
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
        /<button[\s\S]{0,2000}onClick=\{openConfirm\}[\s\S]{0,2000}Mark completed/,
      )?.[0] ?? "";
    expect(block).toMatch(/bg-neutral-900/);
    expect(block).toMatch(/text-white/);
  });
});

describe("AppointmentLifecycleActions: Mark completed gating", () => {
  it("the component returns null for non-confirmed statuses", () => {
    expect(CALENDAR).toMatch(/if \(status !== "confirmed"\) return null;/);
  });

  it("the Mark completed button is disabled when pending OR !hasEnded", () => {
    const block =
      COMPONENT.match(
        /<button[\s\S]{0,2000}onClick=\{openConfirm\}[\s\S]{0,2000}Mark completed/,
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
        /onClick=\{openConfirm\}[\s\S]{0,2000}Mark completed/,
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
    // One dialog per action, now one per owner: the shared completion control
    // carries the complete dialog, the calendar surface carries no-show.
    expect((COMPONENT.match(/<ConfirmDialog\b/g) ?? []).length).toBe(1);
    expect((CALENDAR.match(/<ConfirmDialog\b/g) ?? []).length).toBe(1);
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
    expect(CALENDAR).toMatch(
      /NO_SHOW_CONFIRM_MESSAGE\s*=\s*[\s\S]{0,200}records that the appointment was missed and cannot be undone from this screen\./,
    );
  });

  it("each dialog carries a distinct confirm label so the copy is action-specific", () => {
    expect(COMPONENT).toMatch(/confirmLabel="Mark completed"/);
    expect(CALENDAR).toMatch(/confirmLabel="Mark no-show"/);
    // Charting must never offer no-show: no button, no action, no dialog.
    const controlCode = COMPONENT.split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    expect(controlCode).not.toMatch(/no-show/i);
    expect(controlCode).not.toMatch(/NoShowAction/);
  });

  it("the buttons OPEN the dialog and send NO request (setConfirming, no action call)", () => {
    // runComplete / runNoShow only set which dialog is open; they must not
    // call a server action directly.
    const openConfirm =
      COMPONENT.match(/function openConfirm\(\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? "";
    const runNoShow =
      CALENDAR.match(/function runNoShow\(\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? "";
    expect(openConfirm).toMatch(/setConfirming\(true\)/);
    expect(runNoShow).toMatch(/setConfirming\(true\)/);
    expect(openConfirm).not.toMatch(/markAppointment(Complete|NoShow)Action/);
    expect(runNoShow).not.toMatch(/markAppointment(Complete|NoShow)Action/);
  });

  it("Cancel sends NO request: handleCancel closes and sets the calm hint only", () => {
    const handleCancel =
      COMPONENT.match(/function handleCancel\(\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? "";
    expect(handleCancel).toMatch(/setConfirming\(false\)/);
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
    expect(handleConfirm).not.toMatch(/markAppointmentNoShowAction/);
    const calendarConfirm =
      CALENDAR.match(/function handleConfirm\(\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? "";
    expect(calendarConfirm).toMatch(/markAppointmentNoShowAction\(fd\)/);
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
  it("the no-show button still renders with its existing handler (calendar only)", () => {
    expect(CALENDAR).toMatch(
      /<button[\s\S]{0,2000}onClick=\{runNoShow\}[\s\S]{0,2000}Mark no-show/,
    );
  });

  it("cancelled / no_show / completed appointments return null (no buttons)", () => {
    // The early return guards every terminal-state appointment so
    // neither Mark completed nor Mark no-show renders on the calendar. The
    // charting workflow reaches the same outcome through the pure presenter,
    // which returns a terminal completion state and mounts no control at all.
    expect(CALENDAR).toMatch(/status !== "confirmed"/);
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

// ===========================================================================
// Appointment boundary B2 — T6.8: the actions branch truthfully on EVERY
// sentinel the three lifecycle commands can return
// ===========================================================================
//
// `practitioner_cancel_appointment` and `mark_appointment_no_show` RETURN
// SENTINEL STRINGS rather than raising. That makes an unhandled branch
// invisible: an action that ignores the return value renders a refusal as
// success, with no error anywhere in the stack.
//
// The DB half of this contract — one behavioural case per sentinel — lives in
// tests/db/appointment-lifecycle-commands.db.test.ts. This half pins the
// APPLICATION's reading of them. B2 changes no application source; if a
// branch were found missing it would be recorded as a finding, not fixed here.
//
// The structural property that makes these actions safe is that each one
// treats a KNOWN success literal as the only success and falls through to an
// error for everything else. That is what makes a future, unrecognised result
// code fail closed instead of being reported as success.
// Every assertion below runs against codeOnly(...) — the source with `//`
// lines stripped. Asserting against RAW source is the vacuity trap this repo
// has already been bitten by: a refactor that consolidates the sentinel
// branches into a helper and leaves the old block behind AS A COMMENT would
// satisfy a raw-source grep completely while the real logic failed open.
const ACTIONS_CODE = codeOnly(ACTIONS);

function actionBody(name: string): string {
  return (
    ACTIONS_CODE.match(
      new RegExp(`export async function ${name}\\([\\s\\S]*?\\n\\}\\n`),
    )?.[0] ?? ""
  );
}

// Extract ONE `if (...) { ... }` branch, so an assertion can be made about
// what that branch RETURNS rather than merely that a literal appears
// somewhere in the same function. "the literal exists" and "the message
// exists" can both be true while the branch returns the opposite outcome.
function branchFor(body: string, condition: string): string {
  const escaped = condition.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.match(new RegExp(`if \\(${escaped}\\) \\{[\\s\\S]*?\\n  \\}`))?.[0] ?? "";
}

const CANCEL_BODY = actionBody("cancelAppointmentAction");
const NO_SHOW_BODY = actionBody("markAppointmentNoShowAction");
const COMPLETE_BODY = actionBody("markAppointmentCompleteAction");

describe("T6.8 the action bodies were located (anti-vacuity for every block below)", () => {
  it("all three server actions were extracted from comment-stripped source", () => {
    // Without this, a regex that stopped matching would turn every assertion
    // in this section into `expect("").toMatch(...)` — which fails loudly — or,
    // worse, into a `.not.toMatch` that passes vacuously.
    expect(CANCEL_BODY.length).toBeGreaterThan(500);
    expect(NO_SHOW_BODY.length).toBeGreaterThan(400);
    expect(COMPLETE_BODY.length).toBeGreaterThan(400);
    expect(CANCEL_BODY).toMatch(/practitioner_cancel_appointment/);
    expect(NO_SHOW_BODY).toMatch(/mark_appointment_no_show/);
    expect(COMPLETE_BODY).toMatch(/mark_appointment_complete/);
  });

  it("codeOnly() genuinely strips comments (the stripper itself is not a no-op)", () => {
    expect(codeOnly("// commented\nreal();")).toBe("real();");
    // And the real source did lose its comment lines.
    expect(ACTIONS).toMatch(/\/\/ P0-3: route the actual cancellation/);
    expect(ACTIONS_CODE).not.toMatch(/\/\/ P0-3: route the actual cancellation/);
  });
});

describe("T6.8 cancelAppointmentAction handles every practitioner_cancel_appointment sentinel", () => {
  it("'already_cancelled' is handled AND its branch returns success (idempotent)", () => {
    const b = branchFor(CANCEL_BODY, 'rpcResult === "already_cancelled"');
    expect(b, "the already_cancelled branch must exist").not.toBe("");
    // The outcome, not just the literal. Flipping this branch to an error
    // would break the documented two-tab / double-click race behaviour.
    expect(b).toMatch(/return \{ ok: true \}/);
    expect(b).not.toMatch(/ok: false/);
  });

  it("'not_authorized' is handled AND its branch returns an authorization error", () => {
    const b = branchFor(CANCEL_BODY, 'rpcResult === "not_authorized"');
    expect(b, "the not_authorized branch must exist").not.toBe("");
    expect(b).toMatch(/ok: false/);
    expect(b).toMatch(/not authorized to cancel this appointment/i);
  });

  it("'cancelled' is the ONLY value treated as success, and the fallthrough returns an error", () => {
    // The load-bearing shape. `!== "cancelled"` means 'not_cancelable' AND any
    // result code a future migration might add both land in the error branch.
    // A rewrite to `=== "not_cancelable"` would silently make an unknown code
    // succeed.
    const b = branchFor(CANCEL_BODY, 'rpcResult !== "cancelled"');
    expect(b, "the fail-closed fallthrough must exist").not.toBe("");
    expect(b).toMatch(/ok: false/);
    expect(b).toMatch(/cannot be cancelled from its current state/i);
  });

  it("an RPC-level error (a raise, not a sentinel) returns a failure", () => {
    const b = branchFor(CANCEL_BODY, "rpcErr");
    expect(b, "the rpcErr branch must exist").not.toBe("");
    expect(b).toMatch(/ok: false/);
    expect(b).toMatch(/Could not cancel this appointment/i);
  });

  it("the actor and studio passed to the RPC are SERVER-derived, never browser-supplied", () => {
    // practitioner_cancel_appointment's only authorization input is
    // p_practitioner_id, and it trusts it completely (it reads the role from
    // that row). If the action ever sourced it from FormData, a practitioner
    // could attribute a cancellation to a colleague and the DB would record
    // the forgery as fact. `practitioner` and `studio` come from
    // getCurrentPractitionerWithStudio().
    expect(CANCEL_BODY).toMatch(/p_studio_id:\s*studio\.id/);
    expect(CANCEL_BODY).toMatch(/p_practitioner_id:\s*practitioner\.id/);
    expect(CANCEL_BODY).toMatch(
      /const \{ practitioner, studio \} = await getCurrentPractitionerWithStudio\(\)/,
    );
    // Only the appointment id and the reason may come from the form.
    const formReads = CANCEL_BODY.match(/formDataStr\w*\(formData, "[a-z_]+"\)/g) ?? [];
    expect(formReads.length).toBeGreaterThan(0);
    for (const r of formReads) {
      expect(r, `unexpected FormData field read: ${r}`).toMatch(
        /"(appointment_id|reason)"/,
      );
    }
  });
});

describe("T6.8 markAppointmentNoShowAction handles every mark_appointment_no_show sentinel", () => {
  it("'too_early' is handled AND its branch returns an error with end-time guidance", () => {
    const b = branchFor(NO_SHOW_BODY, 'rpcResult === "too_early"');
    expect(b, "the too_early branch must exist").not.toBe("");
    expect(b).toMatch(/ok: false/);
    expect(b).toMatch(/after the appointment end time/i);
  });

  it("'not_authorized' is handled AND its branch returns an error", () => {
    const b = branchFor(NO_SHOW_BODY, 'rpcResult === "not_authorized"');
    expect(b, "the not_authorized branch must exist").not.toBe("");
    expect(b).toMatch(/ok: false/);
  });

  it("'marked' is the ONLY value treated as success — 'wrong_status' and anything new fall through", () => {
    const b = branchFor(NO_SHOW_BODY, 'rpcResult !== "marked"');
    expect(b, "the fail-closed fallthrough must exist").not.toBe("");
    expect(b).toMatch(/ok: false/);
    expect(b).toMatch(/Only confirmed appointments can be marked as no-show/i);
  });

  it("an RPC-level error returns a failure", () => {
    const b = branchFor(NO_SHOW_BODY, "rpcErr");
    expect(b, "the rpcErr branch must exist").not.toBe("");
    expect(b).toMatch(/ok: false/);
    expect(b).toMatch(/Could not mark this appointment as no-show/i);
  });

  it("the actor and studio passed to the RPC are SERVER-derived", () => {
    expect(NO_SHOW_BODY).toMatch(/p_studio_id:\s*studio\.id/);
    expect(NO_SHOW_BODY).toMatch(/p_practitioner_id:\s*practitioner\.id/);
    const formReads = NO_SHOW_BODY.match(/formDataStr\w*\(formData, "[a-z_]+"\)/g) ?? [];
    expect(formReads.length).toBeGreaterThan(0);
    for (const r of formReads) {
      expect(r, `unexpected FormData field read: ${r}`).toMatch(/"appointment_id"/);
    }
  });
});

describe("T6.8 markAppointmentCompleteAction handles the RAISING command's exceptions", () => {
  it("mark_appointment_complete RAISES rather than returning a sentinel, so the action branches on rpcErr", () => {
    // Unlike the two 0033 commands, 0032's mark_appointment_complete returns
    // void and signals refusal with 42501 / P0002 exceptions. The action must
    // therefore treat ANY rpcErr as a failure — there is no result value to
    // inspect, and it correctly does not destructure `data`.
    expect(COMPLETE_BODY).toMatch(
      /const \{ error: rpcErr \} = await admin\.rpc\(\s*"mark_appointment_complete"/,
    );
    const b = branchFor(COMPLETE_BODY, "rpcErr");
    expect(b, "the rpcErr branch must exist").not.toBe("");
    // Every path out of the error branch is a failure — no `ok: true` inside it.
    expect(b).not.toMatch(/ok: true/);
  });

  it("maps the two documented refusal messages, and falls back to a generic failure for the rest", () => {
    const b = branchFor(COMPLETE_BODY, "rpcErr");
    // 'appointment has not yet ended' (0032:4083)
    expect(b).toMatch(/not yet ended/);
    // 'appointment is not confirmed (current: …)' (0032:4080)
    expect(b).toMatch(/not confirmed/);
    // Everything else — including the 42501 active-membership raise and any
    // future errcode — reaches the generic failure. Fail-closed.
    expect(b).toMatch(/Could not mark this appointment complete/i);
  });

  it("returns ok only AFTER the RPC reported no error", () => {
    const errIndex = COMPLETE_BODY.indexOf("if (rpcErr)");
    const okIndex = COMPLETE_BODY.lastIndexOf("return { ok: true }");
    expect(errIndex).toBeGreaterThan(-1);
    expect(okIndex).toBeGreaterThan(errIndex);
  });

  it("refuses an inactive practitioner before calling the RPC at all", () => {
    expect(COMPLETE_BODY).toMatch(/if \(!practitioner\.active\)/);
    expect(COMPLETE_BODY).toMatch(
      /Inactive practitioners cannot mark appointments complete\./,
    );
  });

  it("the actor and studio passed to the RPC are SERVER-derived", () => {
    expect(COMPLETE_BODY).toMatch(/p_studio_id:\s*studio\.id/);
    expect(COMPLETE_BODY).toMatch(/p_practitioner_id:\s*practitioner\.id/);
  });
});

describe("T6.8 no lifecycle action can report success on an unknown result code", () => {
  it("each sentinel-returning action gates success on an exact literal, not on absence of a known failure", () => {
    // The single property that makes a NEW command result code safe by
    // default. If either action were rewritten to enumerate failures instead
    // (`if (rpcResult === "not_cancelable") return error; return { ok: true }`),
    // a code added by a later migration would be reported to the practitioner
    // as a completed action while the appointment never changed.
    for (const [name, body, successLiteral] of [
      ["cancelAppointmentAction", CANCEL_BODY, "cancelled"],
      ["markAppointmentNoShowAction", NO_SHOW_BODY, "marked"],
    ] as const) {
      expect(body, `${name} must gate on !== "${successLiteral}"`).toMatch(
        new RegExp(`rpcResult !== "${successLiteral}"`),
      );
    }
  });

  it("no equality comparison against rpcResult returns success except the documented idempotent one", () => {
    // Scans EVERY equality form — double quotes, single quotes, backticks, ==
    // and === — so adding `if (rpcResult === 'settled') return { ok: true };`
    // cannot slip past a double-quote-only regex.
    const EQ = /rpcResult\s*===?\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/g;

    for (const [name, body, allowedSuccess] of [
      ["cancelAppointmentAction", CANCEL_BODY, ["already_cancelled"]],
      ["markAppointmentNoShowAction", NO_SHOW_BODY, [] as string[]],
    ] as const) {
      const literals = [...body.matchAll(EQ)].map((m) => m[1] ?? m[2] ?? m[3]);
      // Anti-vacuity: if the regex ever stops matching, this loop would
      // iterate zero times and the test would pass while proving nothing.
      expect(
        literals.length,
        `${name}: expected at least one rpcResult equality branch`,
      ).toBeGreaterThan(0);

      for (const lit of literals) {
        const b = branchFor(body, `rpcResult === "${lit}"`);
        expect(b, `${name}: branch for "${lit}" must be locatable`).not.toBe("");
        if (!(allowedSuccess as readonly string[]).includes(lit)) {
          expect(
            b,
            `${name}: branch for "${lit}" must NOT report success`,
          ).not.toMatch(/ok: true/);
        }
      }
    }
  });

  it("neither sentinel action uses a switch on rpcResult (which could add a success arm unseen)", () => {
    expect(CANCEL_BODY).not.toMatch(/switch\s*\(\s*rpcResult/);
    expect(NO_SHOW_BODY).not.toMatch(/switch\s*\(\s*rpcResult/);
  });

  it("every explicit sentinel branch is reached BEFORE the catch-all that would shadow it", () => {
    // Order is load-bearing and is NOT implied by the branch-content assertions
    // above. Each `if` returns, so hoisting the `!== <success>` catch-all above
    // the explicit branches leaves all of them syntactically intact — and
    // permanently unreachable. Every explicit branch would still contain its
    // literal and its return, so a content-only check stays green while
    // 'already_cancelled' silently becomes a hard error on a double-click and
    // 'not_authorized' silently gets the generic message.
    const ordered = (
      body: string,
      earlier: string,
      later: string,
      label: string,
    ) => {
      const a = body.indexOf(earlier);
      const b = body.indexOf(later);
      expect(a, `${label}: "${earlier}" must be present`).toBeGreaterThan(-1);
      expect(b, `${label}: "${later}" must be present`).toBeGreaterThan(-1);
      expect(a, `${label}: "${earlier}" must come BEFORE "${later}"`).toBeLessThan(b);
    };

    ordered(
      CANCEL_BODY,
      'rpcResult === "already_cancelled"',
      'rpcResult !== "cancelled"',
      "cancelAppointmentAction",
    );
    ordered(
      CANCEL_BODY,
      'rpcResult === "not_authorized"',
      'rpcResult !== "cancelled"',
      "cancelAppointmentAction",
    );
    ordered(
      NO_SHOW_BODY,
      'rpcResult === "too_early"',
      'rpcResult !== "marked"',
      "markAppointmentNoShowAction",
    );
    ordered(
      NO_SHOW_BODY,
      'rpcResult === "not_authorized"',
      'rpcResult !== "marked"',
      "markAppointmentNoShowAction",
    );

    // And the RPC-error branch precedes every sentinel branch in both actions:
    // an rpcErr means there is no result value to read at all.
    ordered(CANCEL_BODY, "if (rpcErr)", 'rpcResult === "already_cancelled"', "cancel");
    ordered(NO_SHOW_BODY, "if (rpcErr)", 'rpcResult === "too_early"', "no-show");
  });

  it("the documented sentinel vocabulary is fully accounted for", () => {
    // Every literal the three commands can return, from their own sources:
    //   practitioner_cancel_appointment (0033:241) -> cancelled | already_cancelled
    //                                                 | not_cancelable | not_authorized
    //   mark_appointment_no_show        (0033:334) -> marked | too_early
    //                                                 | not_authorized | wrong_status
    //   mark_appointment_complete       (0032:4052) -> void, raises 42501 / P0002
    const CANCEL = ["cancelled", "already_cancelled", "not_cancelable", "not_authorized"];
    const NO_SHOW = ["marked", "too_early", "not_authorized", "wrong_status"];
    expect(CANCEL).toHaveLength(4);
    expect(NO_SHOW).toHaveLength(4);

    // Each sentinel is either named explicitly or provably covered by the
    // catch-all. 'not_cancelable' and 'wrong_status' are the catch-all cases:
    // they are NOT named, and that is correct precisely because the fallthrough
    // is `!== <success>` rather than an enumeration of failures.
    for (const s of CANCEL) {
      const named = CANCEL_BODY.includes(`"${s}"`);
      const covered =
        s === "not_cancelable" && /rpcResult !== "cancelled"/.test(CANCEL_BODY);
      expect(named || covered, `cancel sentinel "${s}" must be handled`).toBe(true);
    }
    for (const s of NO_SHOW) {
      const named = NO_SHOW_BODY.includes(`"${s}"`);
      const covered =
        s === "wrong_status" && /rpcResult !== "marked"/.test(NO_SHOW_BODY);
      expect(named || covered, `no-show sentinel "${s}" must be handled`).toBe(true);
    }
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
