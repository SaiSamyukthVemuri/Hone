import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #180. Pin the auto-mark-completed-on-session-start path in
// startSessionAction. The helper lives in the same file so a future
// refactor cannot silently drop the call. The fail-soft contract is
// load-bearing: a failed auto-complete must NOT break session start
// because the practitioner still has the explicit Mark completed
// button to fall back on.

const ACTIONS_PATH = path.resolve(
  __dirname,
  "../../../app/(app)/clients/[id]/sessions/new/actions.ts",
);
const ACTIONS = readFileSync(ACTIONS_PATH, "utf8");

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const ACTIONS_CODE = codeOnly(ACTIONS);

describe("startSessionAction: PR #180 auto-mark-completed helper", () => {
  it("declares maybeMarkAppointmentCompletedOnSessionStart at module scope", () => {
    expect(ACTIONS).toMatch(
      /async function maybeMarkAppointmentCompletedOnSessionStart\(args: \{/,
    );
  });

  it("the helper accepts appointmentId, studioId, practitionerId, status, endsAt", () => {
    const block =
      ACTIONS.match(
        /async function maybeMarkAppointmentCompletedOnSessionStart\(args: \{[\s\S]{0,600}\}\)/,
      )?.[0] ?? "";
    expect(block).toMatch(/appointmentId: string/);
    expect(block).toMatch(/studioId: string/);
    expect(block).toMatch(/practitionerId: string/);
    expect(block).toMatch(/status: string/);
    expect(block).toMatch(/endsAt: string/);
  });

  it("the helper only proceeds when status === 'confirmed' (cancelled / no_show / completed skipped)", () => {
    expect(ACTIONS).toMatch(/args\.status !== "confirmed"/);
  });

  // B6 / 0175 — THE ASYMMETRY THAT MAKES EARLY COMPLETION SAFE.
  //
  // 0175 loosened mark_appointment_complete to `starts_at > now()`, so the RPC
  // itself would now accept a mid-visit appointment. The AUTOMATIC path must
  // not take advantage of that: starting to chart at 14:20 on a 14:00-15:00
  // visit must not silently complete the appointment, and must not fire
  // postcare as a side effect of that completion.
  //
  // The guard lives HERE, in the action, before the RPC is ever called — which
  // is why loosening the RPC could not change this path. Pinned so a future
  // "consistency" edit cannot align the two boundaries.
  it("T19/T20 — the AUTO path still requires the appointment to have ENDED", () => {
    expect(ACTIONS).toMatch(/endsAtMs > Date\.now\(\)/);
    // The auto path must never key off starts_at.
    expect(ACTIONS).not.toMatch(/startsAtMs/);
    // And the skip must happen BEFORE the RPC call, not after.
    const guardAt = ACTIONS.indexOf("endsAtMs > Date.now()");
    const rpcAt = ACTIONS.indexOf('rpc("mark_appointment_complete"');
    expect(guardAt).toBeGreaterThan(-1);
    expect(rpcAt).toBeGreaterThan(guardAt);
  });

  it("the helper skips future appointments (endsAtMs > Date.now())", () => {
    expect(ACTIONS).toMatch(/endsAtMs > Date\.now\(\)/);
  });

  it("the helper calls the mark_appointment_complete RPC via the admin client", () => {
    expect(ACTIONS).toMatch(
      /admin\.rpc\("mark_appointment_complete",\s*\{[\s\S]{0,300}p_appointment_id:\s*args\.appointmentId/,
    );
  });

  it("the helper imports the admin client dynamically (cold-path)", () => {
    expect(ACTIONS).toMatch(
      /await import\("@\/lib\/supabase\/admin-server"\)/,
    );
  });
});

describe("startSessionAction: PR #180 fail-soft contract", () => {
  it("the helper catches thrown errors and logs them without rethrowing", () => {
    expect(ACTIONS).toMatch(
      /catch \(err\)[\s\S]{0,600}session_start_auto_mark_complete_threw/,
    );
  });

  it("the helper logs an RPC error event when rpcErr is truthy", () => {
    expect(ACTIONS).toMatch(
      /if \(rpcErr\)[\s\S]{0,600}session_start_auto_mark_complete_rpc_error/,
    );
  });

  it("the helper does NOT throw on RPC failure (no `throw` inside the helper body)", () => {
    const body =
      ACTIONS.match(
        /async function maybeMarkAppointmentCompletedOnSessionStart\([\s\S]{0,4000}\n\}\n/,
      )?.[0] ?? "";
    expect(body).not.toMatch(/\bthrow\s/);
  });
});

describe("startSessionAction: appointment lookup widened to status + ends_at", () => {
  it("the appointment SELECT now includes status + ends_at", () => {
    expect(ACTIONS).toMatch(
      /\.select\("id, studio_id, client_id, practitioner_id, status, ends_at"\)/,
    );
  });

  it("appointmentStatus + appointmentEndsAt are captured from the row", () => {
    expect(ACTIONS).toMatch(/let appointmentStatus: string \| null = null;/);
    expect(ACTIONS).toMatch(/let appointmentEndsAt: string \| null = null;/);
  });
});

describe("startSessionAction: helper is invoked after session insert", () => {
  it("the call site appears AFTER the session insert + BEFORE the redirect", () => {
    // The redirect throws, so the auto-complete must be before it.
    const callIdx = ACTIONS.indexOf(
      "maybeMarkAppointmentCompletedOnSessionStart({",
    );
    // L18 Phase 3: the insert is now inside start_session (migration 0167);
    // the ordering property is unchanged and anchored to the command call.
    const insertIdx = ACTIONS.indexOf('rpc("start_session"');
    const redirectIdx = ACTIONS.lastIndexOf(
      "redirect(`/clients/${clientId}/sessions/${sessionId}`)",
    );
    expect(callIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(redirectIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(insertIdx);
    expect(callIdx).toBeLessThan(redirectIdx);
  });

  it("the call site is guarded by appointmentId + appointmentStatus + appointmentEndsAt all truthy", () => {
    expect(ACTIONS).toMatch(
      /if \(appointmentId && appointmentStatus && appointmentEndsAt\)\s*\{[\s\S]{0,800}maybeMarkAppointmentCompletedOnSessionStart\(\{/,
    );
  });

  it("the call site revalidates the calendar appointment detail path so the new status is visible", () => {
    expect(ACTIONS).toMatch(
      /maybeMarkAppointmentCompletedOnSessionStart\(\{[\s\S]{0,800}\}\);[\s\S]{0,300}revalidatePath\(`\/calendar\/\$\{appointmentId\}`\)/,
    );
  });
});

describe("startSessionAction: PR #180 scope (no Stripe / payment / SMS)", () => {
  it("does NOT call any Stripe SDK (code only)", () => {
    expect(ACTIONS_CODE).not.toMatch(
      /paymentIntents\.create|refunds\.create|charges\.create|checkout\.sessions|setupIntents\.create/,
    );
  });

  it("does NOT touch payment_charge_attempts directly", () => {
    expect(ACTIONS_CODE).not.toMatch(/payment_charge_attempts/);
  });

  it("does NOT send SMS or email", () => {
    expect(ACTIONS_CODE).not.toMatch(/sendEmailSafely|sendSms|twilio/i);
  });
});
