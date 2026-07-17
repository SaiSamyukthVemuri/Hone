import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// Permanent source guards for the practitioner Move appointment feature
// (migration 0133). These pin the safety + UX contract the DB tests cannot see:
//   * the move is ONE atomic same-record RPC (never cancel + rebook);
//   * tenant is resolved server-side (never a browser studio/practitioner id);
//   * closed outcomes map to safe copy and no raw DB/RPC error ever reaches a user;
//   * the app origin is validated BEFORE mutation; the client email is best-effort
//     AFTER commit and can never turn a committed move into a failure;
//   * the client components hold no service-role / admin / server-only code and
//     mutate only through the two exported server actions;
//   * nothing here touches Google Calendar sync, Stripe, or the one-time
//     confirmation email/SMS claim.

const ROOT = path.resolve(__dirname, "../..");

function read(rel: string): string {
  const full = path.join(ROOT, rel);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}
// Strip comments so "must NOT contain" assertions test CODE, not the prose in
// the file's own comments (which deliberately name the surfaces we forbid).
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const ACTIONS = "app/(app)/calendar/move-appointment-actions.ts";
const NOTIFY = "lib/email/notify-appointment-moved.ts";
const DIALOG = "app/(app)/calendar/MoveAppointmentDialog.tsx";
const BUTTON = "app/(app)/calendar/MoveAppointmentButton.tsx";

describe("move actions: atomic same-record move via the one RPC", () => {
  const c = code(ACTIONS);
  it("routes the move through practitioner_move_appointment and nothing else", () => {
    expect(c).toMatch(/rpc\(\s*["']practitioner_move_appointment["']/);
  });
  it("never cancels + rebooks — no appointment insert / cancel / delete in the move path", () => {
    expect(c).not.toMatch(/\.insert\(/);
    expect(c).not.toMatch(/\.delete\(/);
    expect(c).not.toMatch(/cancel_appointment|mark_appointment|cancelAppointment/i);
    // The appointment table is only READ (id/status/starts_at) + moved via the RPC.
    expect(c).not.toMatch(/\.update\(\s*{/);
  });
});

describe("move actions: server-resolved tenant, never browser-supplied", () => {
  const c = code(ACTIONS);
  it("resolves studio + practitioner via getCurrentPractitionerWithStudio", () => {
    expect(c).toMatch(/getCurrentPractitionerWithStudio\(/);
  });
  it("scopes the appointment read to the server-resolved studio.id", () => {
    expect(c).toMatch(/\.eq\(\s*["']studio_id["']\s*,\s*studio\.id\s*\)/);
  });
  it("passes the server-resolved practitioner.id + studio.id to the RPC", () => {
    expect(c).toMatch(/p_practitioner_id:\s*practitioner\.id/);
    expect(c).toMatch(/p_studio_id:\s*studio\.id/);
  });
});

describe("move actions: closed outcome mapping, no raw error leak", () => {
  const c = code(ACTIONS);
  it("maps a 23P01 exclusion violation to safe conflict copy", () => {
    expect(c).toMatch(/["']23P01["']/);
    expect(c).toMatch(/That time is no longer available/);
  });
  it("maps each RPC result string to a typed outcome", () => {
    for (const r of [
      "moved",
      "no_change",
      "stale_appointment",
      "not_authorized",
      "appointment_not_found",
      "appointment_not_movable",
      "invalid_time",
    ]) {
      expect(c).toContain(`"${r}"`);
    }
  });
  it("stale + no_change carry their specific copy", () => {
    expect(c).toMatch(/changed in another window/);
    expect(c).toMatch(/Choose a different appointment time/);
  });
  it("never surfaces a raw DB/RPC error message to the user", () => {
    // No returned error field is ever built from a provider .message / String(error).
    expect(c).not.toMatch(/\.message\b/);
    expect(c).not.toMatch(/String\(\s*error\s*\)/);
  });
});

describe("move actions: origin-before-mutation, notify-after-commit ordering", () => {
  const c = code(ACTIONS);
  const idxOrigin = c.indexOf("getRequiredAppOrigin(");
  const idxRpc = c.search(/rpc\(\s*["']practitioner_move_appointment["']/);
  const idxNotify = c.indexOf("notifyAppointmentMoved(");
  it("resolves + validates the app origin BEFORE the RPC mutation", () => {
    expect(idxOrigin).toBeGreaterThan(-1);
    expect(idxRpc).toBeGreaterThan(-1);
    expect(idxOrigin).toBeLessThan(idxRpc);
  });
  it("sends the client notification AFTER the commit", () => {
    expect(idxNotify).toBeGreaterThan(idxRpc);
  });
  it("revalidates the calendar, detail, client, and dashboard surfaces", () => {
    for (const p of ["/calendar", "/calendar/upcoming", "/dashboard"]) {
      expect(c).toContain(`revalidatePath("${p}")`);
    }
    expect(c).toMatch(/revalidatePath\(`\/calendar\/\$\{appointmentId\}`\)/);
    expect(c).toMatch(/revalidatePath\(`\/clients\/\$\{appt\.client_id\}`\)/);
  });
});

describe("move notification: best-effort, PHI-free, no confirmation-claim reuse", () => {
  const c = code(NOTIFY);
  it("is fail-open (wrapped in try/catch, returns degraded on failure)", () => {
    expect(c).toMatch(/try\s*{/);
    expect(c).toMatch(/return\s+["']degraded["']/);
  });
  it("does not reuse the one-time confirmation email/SMS claim slots", () => {
    expect(c).not.toMatch(/confirmation_sent_at|confirmation_claimed_at|confirmation_send/);
    expect(c).not.toMatch(/sendConfirmation|markConfirmation/);
  });
  it("sends no SMS for a move (email-only in this feature)", () => {
    expect(c).not.toMatch(/sendSms|sendSMS|twilio|passesConsentGate/i);
  });
  it("records only a PHI-free ops signal on failure (no client identity)", () => {
    // The safeDetails object carries only a static channel + reason CATEGORY —
    // never an interpolated value, an email address, or a client name.
    const safe = c.match(/safeDetails:\s*{[^}]*}/)?.[0] ?? "";
    expect(safe).toMatch(/channel/); // the block exists and was captured
    expect(safe).not.toMatch(/\$\{/); // no template interpolation of runtime values
    expect(safe).not.toMatch(/clientName|\bemail:|\.email\b/); // no client identity
  });
});

describe("move UI: client boundary holds no service-role / admin / server-only code", () => {
  for (const rel of [DIALOG, BUTTON]) {
    it(`${path.basename(rel)} is a client component with no admin/service-role import`, () => {
      const raw = read(rel);
      expect(raw).toMatch(/^["']use client["'];/m);
      expect(raw).not.toMatch(/admin-server|createAdminClient|service_role|server-only/);
      expect(raw).not.toMatch(/SUPABASE_SERVICE_ROLE|createClient\(/);
    });
  }
  it("the dialog mutates ONLY through the two exported server actions", () => {
    const raw = read(DIALOG);
    expect(raw).toMatch(/loadMoveSlotsAction/);
    expect(raw).toMatch(/moveAppointmentAction/);
  });
});

describe("move feature: no Google Calendar / Stripe entanglement", () => {
  it("neither the action nor the notification touches Google sync or Stripe state", () => {
    for (const rel of [ACTIONS, NOTIFY]) {
      const c = code(rel);
      expect(c).not.toMatch(/calendar_event|google|gcal|worker_enabled|outbox/i);
      expect(c).not.toMatch(/stripe|paymentIntent|refund|charge/i);
    }
  });
});

// ---- Custom-time follow-up: owner-only override + closed mode contract ----
describe("move: closed mode contract + owner-only custom time", () => {
  const c = code(ACTIONS);
  it("mode is a CLOSED set (available_slot | custom_time) and an unknown mode is rejected", () => {
    expect(c).toMatch(/"available_slot"\s*\|\s*"custom_time"/);
    // Rejects anything that is not one of the two modes.
    expect(c).toMatch(/mode !== "available_slot" && mode !== "custom_time"/);
  });
  it("custom_time is authorized on the LIVE server-resolved owner role (not the browser)", () => {
    expect(c).toMatch(/mode === "custom_time"/);
    expect(c).toMatch(/practitioner\.role !== "owner"/);
    // never trusts a browser-supplied role/isOwner/allow flag
    expect(c).not.toMatch(/input\.(isOwner|role|canUseCustomTime|allowOutsideAvailability|studioId|practitionerId)/);
  });
  it("custom_time requires the explicit override acknowledgement", () => {
    expect(c).toMatch(/outsideAvailabilityConfirmed/);
    expect(c).toMatch(/Confirm that you want to override regular availability/);
  });
  it("available_slot re-verifies the target against a server-recomputed slot list (by instant)", () => {
    expect(c).toMatch(/mode === "available_slot"/);
    expect(c).toMatch(/getAvailableSlots\(/);
    // membership is checked by comparing UTC instants, not just a formatted label
    expect(c).toMatch(/getTime\(\) ===\s*\n?\s*targetMs|=== targetMs/);
  });
  it("canUseCustomTime is derived ONLY from the server role", () => {
    expect(c).toMatch(/canUseCustomTime\s*=\s*practitioner\.role === "owner"/);
  });
  it("still ONE dialog, ONE action, ONE RPC — no second mutation path", () => {
    // Exactly one rpc call site to the move RPC.
    expect((code(ACTIONS).match(/rpc\(\s*["']practitioner_move_appointment["']/g) ?? []).length).toBe(1);
    // The dialog mutates only through the two exported actions.
    const dialog = read(DIALOG);
    expect(dialog).toMatch(/moveAppointmentAction/);
    expect(dialog).toMatch(/loadMoveSlotsAction/);
    expect(dialog).not.toMatch(/admin-server|createAdminClient|service_role/);
  });
  it("custom-time UI gates the button on acknowledgement + a valid time (owner-only render)", () => {
    const dialog = read(DIALOG);
    expect(dialog).toMatch(/canUseCustomTime &&/); // custom option renders only when server says owner
    expect(dialog).toMatch(/I understand this time overrides regular availability/);
    expect(dialog).toMatch(/ackOverride/);
  });
});

// ---- PR #433 cancellation-email actor code + tests remain present (§26) ----
describe("move follow-up leaves the PR #433 cancellation-email actor work intact", () => {
  it("cancellation-email actor code is still present", () => {
    const tpl = read("lib/email/templates/appointment.ts");
    expect(tpl).toMatch(/cancellationActorSummary/);
    expect(tpl).toMatch(/CancellationActorRole/);
    expect(tpl).toMatch(/Studio owner/);
  });
  it("cancellation-email actor tests are still present", () => {
    expect(existsSync(path.join(ROOT, "tests/lib/email/cancellation-actor.test.ts"))).toBe(true);
  });
});

// ---- Mobile submit-visibility hotfix: stable flex-shell footer + synchronous lock ----
describe("move dialog: footer stays painted + submit locks synchronously", () => {
  const raw = read(DIALOG);
  it("the action footer is NOT position:sticky (flex-shell, not sticky-in-overflow)", () => {
    // The iOS Safari repaint bug came from sticky header/footer inside an overflow
    // container. Neither may reappear.
    expect(raw).not.toMatch(/sticky\s+bottom-0/);
    expect(raw).not.toMatch(/sticky\s+top-0/);
  });
  it("header + footer are shrink-0 flex children; body is the only scroll region (min-h-0)", () => {
    expect(raw).toMatch(/flex shrink-0[^"]*items-center justify-end/); // footer
    expect(raw).toMatch(/min-h-0 flex-1 overflow-y-auto/); // body
  });
  it("submission lock is an EXPLICIT useState + one-shot ref, set synchronously (not only useTransition)", () => {
    expect(raw).toMatch(/const \[submitting, setSubmitting\] = useState\(false\)/);
    expect(raw).toMatch(/submittingRef = useRef\(false\)/);
    // The critical submit does NOT run through startSubmit/useTransition.
    expect(raw).not.toMatch(/startSubmit\(/);
    // Synchronous guard + lock at the top of confirm.
    expect(raw).toMatch(/if \(submittingRef\.current \|\| !canConfirm\) return/);
    expect(raw).toMatch(/submittingRef\.current = true;\s*\n\s*setSubmitting\(true\)/);
  });
  it("the submit button exposes aria-busy while submitting", () => {
    expect(raw).toMatch(/aria-busy=\{submitting\}/);
  });
});
