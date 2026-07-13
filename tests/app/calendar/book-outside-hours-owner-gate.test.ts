import { describe, it, expect, vi, beforeEach } from "vitest";

// Owner-only availability-bypass — direct behaviour test of the SERVER gate in
// bookAppointmentForClientAction (shared by the calendar Quick Book and the
// client-profile Book flow). The gate is authoritative and enforced on the
// server-resolved role ONLY: allow_outside_availability=true requires owner,
// and NO client-supplied signal (duration, source, mode, UI route) is trusted as
// authorization. See docs/reviews/booking-availability-authorization.md.

const practitionerState: { role: string; active: boolean } = {
  role: "owner",
  active: true,
};

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "prac-1", role: practitionerState.role, active: practitionerState.active },
    studio: {
      id: "studio-1",
      timezone: "America/Toronto",
      default_appointment_duration_minutes: 30,
      buffer_minutes: 0,
    },
  }),
}));

// A chainable Supabase stub whose services lookup returns no row, so the action
// returns "Service not found." immediately AFTER the owner gate — proving the
// call passed (or did not pass) the gate without exercising insert/email paths.
vi.mock("@/lib/supabase/server", () => {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.maybeSingle = async () => ({ data: null, error: null });
  return { createClient: async () => ({ from: () => q }) };
});

import { bookAppointmentForClientAction } from "@/app/(app)/calendar/actions";

const OWNER_ERROR = /only the studio owner can book outside/i;

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

const future = "2099-01-01T15:00:00.000Z";
const base = { client_id: "c1", service_id: "s1", starts_at: future };
// Reaching the stubbed service lookup ("Service not found") proves the request
// passed the owner gate; getting OWNER_ERROR proves it was rejected at the gate.
const PAST_GATE = /service not found/i;

beforeEach(() => {
  practitionerState.role = "owner";
  practitionerState.active = true;
});

describe("intentional outside-hours override is owner-only", () => {
  it("rejects a NON-OWNER intentional override (no custom duration)", async () => {
    practitionerState.role = "practitioner";
    const r = await bookAppointmentForClientAction(
      fd({ ...base, allow_outside_availability: "true" }),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(OWNER_ERROR);
  });

  it("allows the OWNER to override (passes the gate → reaches the service lookup)", async () => {
    practitionerState.role = "owner";
    const r = await bookAppointmentForClientAction(
      fd({ ...base, allow_outside_availability: "true" }),
    );
    expect(r.ok).toBe(false);
    // Past the gate: the next failure is the stubbed missing service.
    expect(!r.ok && r.error).not.toMatch(OWNER_ERROR);
    expect(!r.ok && r.error).toMatch(/service not found/i);
  });
});

describe("no client-supplied field is trusted as authorization", () => {
  it("a non-owner CANNOT bypass by supplying a custom duration", async () => {
    practitionerState.role = "practitioner";
    const r = await bookAppointmentForClientAction(
      fd({
        ...base,
        allow_outside_availability: "true",
        duration_minutes_override: "45",
      }),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(OWNER_ERROR);
  });

  it("a non-owner CANNOT bypass by forging a source/mode label", async () => {
    practitionerState.role = "practitioner";
    const r = await bookAppointmentForClientAction(
      fd({
        ...base,
        allow_outside_availability: "true",
        source: "calendar",
        mode: "drag",
      }),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(OWNER_ERROR);
  });

  it("an OWNER may bypass with a custom duration (owner passes on every path)", async () => {
    practitionerState.role = "owner";
    const r = await bookAppointmentForClientAction(
      fd({
        ...base,
        allow_outside_availability: "true",
        duration_minutes_override: "45",
      }),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).not.toMatch(OWNER_ERROR);
    expect(!r.ok && r.error).toMatch(PAST_GATE);
  });

  it("custom duration WITHOUT the availability bypass keeps existing behaviour (rejected, not owner-gated)", async () => {
    // The pre-existing contract: a custom length requires the bypass flag. A
    // non-owner sending only a duration is refused with the existing message,
    // NOT the owner error — confirming the gate is on the bypass, not duration.
    practitionerState.role = "practitioner";
    const r = await bookAppointmentForClientAction(
      fd({ ...base, duration_minutes_override: "45" }),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).not.toMatch(OWNER_ERROR);
    expect(!r.ok && r.error).toMatch(/custom duration requires the outside-availability override/i);
  });
});

describe("standard booking is unaffected", () => {
  it("a non-owner standard booking (no override) is not gated", async () => {
    practitionerState.role = "practitioner";
    const r = await bookAppointmentForClientAction(fd({ ...base }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).not.toMatch(OWNER_ERROR);
    expect(!r.ok && r.error).toMatch(/service not found/i);
  });

  it("an inactive practitioner is refused before the override gate", async () => {
    practitionerState.role = "owner";
    practitionerState.active = false;
    const r = await bookAppointmentForClientAction(
      fd({ ...base, allow_outside_availability: "true" }),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/inactive/i);
  });
});
