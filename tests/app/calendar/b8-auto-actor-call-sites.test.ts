import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// B8 / 0177 — the auto-send actor must be a REAL, server-resolved practitioner.
//
// claim_postcare_send authenticates the business actor in the database, so
// auto-send needs an identity that a human is accountable for. The tempting
// shortcuts are all wrong in the same way: they put a value in the boundary
// that nobody authorised.
//
//   * "system" / a hard-coded UUID — an identity no one is accountable for;
//   * service_role — the transport identity, not a business actor;
//   * appointment.practitioner_id read at the CALL SITE — the appointment's
//     assigned practitioner is not necessarily the person who completed it,
//     and reading it here would attribute the send to the wrong human;
//   * anything from client input — trivially forgeable.
//
// This is asserted at the SOURCE of both call sites rather than through a mock,
// because the property is about which value is passed, and a mock would happily
// accept whichever value the code chose.

const ROOT = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const CALL_SITES = [
  {
    file: "app/(app)/calendar/actions.ts",
    // markAppointmentCompleteAction resolves the practitioner via
    // getCurrentPractitionerWithStudio() before it does anything else.
    expected: "practitioner.id",
  },
] as const;
// HON-45: the session-start path (the second call site) was REMOVED with the PR #180 auto-complete.
// It is pinned as absent below so it cannot quietly come back.

describe("HON-45 — starting a chart never triggers postcare", () => {
  it("the session-start action has no auto-send call and no completion command", () => {
    const src = read("app/(app)/clients/[id]/sessions/new/actions.ts");
    expect(src).not.toMatch(/autoSendPostcareOnComplete/);
    expect(src).not.toMatch(/mark_appointment_complete/);
  });
});

describe("B8 — auto-send receives a server-resolved practitioner at every call site", () => {
  it.each(CALL_SITES)(
    "$file forwards $expected",
    ({ file, expected }) => {
      const src = read(file);
      const calls = [...src.matchAll(/autoSendPostcareOnComplete\(([^)]*)\)/g)].map((m) =>
        m[1].replace(/\s+/g, " ").trim(),
      );
      expect(calls.length, `${file} must still call autoSendPostcareOnComplete`).toBe(1);

      const args = calls[0].split(",").map((a) => a.trim());
      // (appointmentId, studioId, actorPractitionerId)
      expect(args.length, "the actor argument must be present").toBeGreaterThanOrEqual(3);
      expect(args[2], `${file}: third argument must be the resolved practitioner`).toBe(
        expected,
      );
    },
  );

  it("no call site substitutes a synthetic, transport or client-supplied actor", () => {
    const forbidden = [
      /autoSendPostcareOnComplete\([^)]*["']system["']/,
      /autoSendPostcareOnComplete\([^)]*["']service_role["']/,
      // A bare UUID literal in the argument list.
      /autoSendPostcareOnComplete\([^)]*["'][0-9a-f]{8}-[0-9a-f]{4}-/i,
      // The appointment's assigned practitioner read at the call site: the
      // person who completed the visit is not necessarily the assignee.
      /autoSendPostcareOnComplete\([^)]*appt\.practitioner_id/,
      /autoSendPostcareOnComplete\([^)]*appointment\.practitioner_id/,
      // Anything straight off a form.
      /autoSendPostcareOnComplete\([^)]*formData/,
    ];
    for (const { file } of CALL_SITES) {
      const src = read(file);
      for (const pattern of forbidden) {
        expect(pattern.test(src), `${file} must not pass ${pattern}`).toBe(false);
      }
    }
  });

  it("the helper still REQUIRES the actor — it cannot be quietly dropped", () => {
    // If the parameter became optional, a call site could stop passing it and
    // every assertion above would keep passing while the database received
    // undefined.
    const helper = read("app/(app)/calendar/postcare-auto-send.ts");
    expect(helper).toMatch(/actorPractitionerId: string,/);
    expect(helper, "the actor must not be optional").not.toMatch(
      /actorPractitionerId\?: string/,
    );
    // And it must be the value handed to the command, not a local substitute.
    expect(helper).toMatch(/p_actor_practitioner_id: actorPractitionerId/);
  });
});
