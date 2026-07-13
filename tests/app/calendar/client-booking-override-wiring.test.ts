import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Wiring guards for the client-page outside-hours booking parity (PR: booking
// parity). The security behaviour is proven in
// book-outside-hours-owner-gate.test.ts; these pin the UI + isolation contract.

const root = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const BOOK = read("app/(app)/clients/[id]/BookAppointment.tsx");
const ACTIONS = read("app/(app)/calendar/actions.ts");

describe("client-page override reuses the shared action + is owner-only in the UI", () => {
  it("uses the SAME server action as the calendar (no second implementation)", () => {
    expect(BOOK).toMatch(/import \{ bookAppointmentForClientAction \} from "\.\.\/\.\.\/calendar\/actions"/);
    expect(BOOK).toMatch(/allow_outside_availability/);
  });

  it("the override UI + payload is gated on isOwner (non-owners never see it)", () => {
    expect(BOOK).toMatch(/isOwner/);
    // The override block renders only when isOwner is true.
    expect(BOOK).toMatch(/isOwner &&/);
    // The override payload is only set when the owner-gated toggle is active.
    expect(BOOK).toMatch(/overrideActive/);
  });

  it("converts the local override time to a UTC instant with the shared tz helper", () => {
    expect(BOOK).toMatch(/utcInstantFromLocal\(date, overrideTime, timezone\)/);
  });
});

describe("server gate is authoritative + scoped to intentional outside-hours", () => {
  it("rejects a non-owner intentional override (no custom duration)", () => {
    expect(ACTIONS).toMatch(
      /allowOutsideAvailability &&\s*\n?\s*durationOverride == null &&\s*\n?\s*practitioner\.role !== "owner"/,
    );
    expect(ACTIONS).toMatch(/Only the studio owner can book outside/);
  });
});

describe("public booking cannot pass the override", () => {
  it("the public booking action does not read allow_outside_availability", () => {
    // Public booking lives in a separate file that must never honour the flag.
    const publicAction = read("app/book/[slug]/actions.ts");
    expect(publicAction).not.toMatch(/allow_outside_availability/);
  });
});
