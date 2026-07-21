import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR B Part 4 — the internal booking action routes through the canonical
// command and never self-assigns or leaks raw DB text.

const ACTIONS = readFileSync(
  join(process.cwd(), "app/(app)/calendar/actions.ts"),
  "utf8",
);

describe("bookAppointmentForClientAction — canonical command wiring", () => {
  it("calls the v2 command via the admin (service_role) client with authoritative duration", () => {
    expect(ACTIONS).toMatch(/createAdminClient\(\)/);
    // Item 2: v2 derives the duration from the locked service row — no caller
    // p_duration_minutes; an owner-only override + availability bypass instead.
    expect(ACTIONS).toMatch(/\.rpc\(\s*"create_internal_appointment_v2"/);
    expect(ACTIONS).not.toMatch(/p_duration_minutes:/);
    expect(ACTIONS).toMatch(/p_duration_override_minutes: durationOverride/);
    expect(ACTIONS).toMatch(/p_allow_outside_availability: allowOutsideAvailability/);
  });

  it("passes an explicit actor + target practitioner (no silent self-assign in the insert)", () => {
    expect(ACTIONS).toMatch(/p_actor_practitioner_id: practitioner\.id/);
    expect(ACTIONS).toMatch(/p_target_practitioner_id: targetPractitionerId/);
    // The old direct insert that hard-coded practitioner_id is gone.
    expect(ACTIONS).not.toMatch(/\.from\("appointments"\)\s*\.insert\(/);
  });

  it("resolves the target only for a capacity-ON owner; everyone else books for self", () => {
    expect(ACTIONS).toMatch(/capacityOn && practitioner\.role === "owner" && submittedPractitionerId/);
  });

  it("never returns a raw DB message from the booking path", () => {
    // No `${...message}` interpolation and no bare `error: <ident>.message`.
    expect(ACTIONS.match(/error:\s*\w*Err\.message/g) ?? []).toEqual([]);
    expect(ACTIONS).toMatch(/function logBookingDbError/);
    expect(ACTIONS).toMatch(/booking_action_db_error:\$\{action\}:\$\{stage\}:\$\{code \?\? "unknown"\}/);
  });

  it("maps the command's result codes to fixed owner-facing copy", () => {
    expect(ACTIONS).toMatch(/function bookingResultMessage/);
    for (const code of [
      "booking_paused", "not_authorized", "invalid_practitioner", "not_eligible",
      "practitioner_closed", "outside_availability", "invalid_duration",
    ]) {
      expect(ACTIONS).toContain(`"${code}"`);
    }
  });
});
