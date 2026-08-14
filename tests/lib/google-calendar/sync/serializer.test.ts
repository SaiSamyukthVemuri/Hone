import { describe, expect, it } from "vitest";
import { buildEventMarker } from "@/lib/google-calendar/sync/event-id";
import { buildAppointmentEventPayload } from "@/lib/google-calendar/sync/serializer";

// Phase B2.3-c1: the fixed, minimal appointment serializer (frozen v1 allow-list).

const LINK = "11111111-2222-3333-4444-555555555555";
const BASE = {
  startsAt: "2026-07-15T14:00:00.000Z",
  endsAt: "2026-07-15T15:00:00.000Z",
  studioTimezone: "America/New_York",
  linkId: LINK,
};

function payloadOf(over: Partial<typeof BASE> = {}) {
  const r = buildAppointmentEventPayload({ ...BASE, ...over });
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.payload as Record<string, unknown>;
}

describe("buildAppointmentEventPayload", () => {
  it("emits exactly the approved allow-list + the private marker", () => {
    const p = payloadOf();
    expect(p.summary).toBe("Hone appointment");
    expect(p.visibility).toBe("private");
    expect(p.transparency).toBe("opaque");
    expect(p.start).toEqual({ dateTime: "2026-07-15T14:00:00.000Z", timeZone: "America/New_York" });
    expect(p.end).toEqual({ dateTime: "2026-07-15T15:00:00.000Z", timeZone: "America/New_York" });
    expect(p.extendedProperties).toEqual({ private: buildEventMarker(LINK) });
  });

  it("omits reminders, attendees, recurrence, description, location, and the event id", () => {
    const p = payloadOf();
    for (const k of ["reminders", "attendees", "recurrence", "description", "location", "id"]) {
      expect(p[k]).toBeUndefined();
    }
  });

  it("carries no PHI / excluded fields", () => {
    const json = JSON.stringify(payloadOf());
    for (const bad of ["name", "email", "phone", "@", "price", "note", "reason", "address", "token"]) {
      expect(json.toLowerCase()).not.toContain(bad);
    }
  });

  it("uses offset-bearing RFC3339 (…Z) and preserves the exact instant / DST", () => {
    // A winter instant + a DST instant both round-trip to the same UTC instant.
    const winter = payloadOf({ startsAt: "2026-01-10T14:00:00Z", endsAt: "2026-01-10T15:00:00Z" });
    expect((winter.start as { dateTime: string }).dateTime).toBe("2026-01-10T14:00:00.000Z");
  });

  it("rejects end <= start and invalid datetimes and a missing timezone", () => {
    expect(buildAppointmentEventPayload({ ...BASE, endsAt: BASE.startsAt })).toEqual({ ok: false, reason: "end_not_after_start" });
    expect(buildAppointmentEventPayload({ ...BASE, endsAt: "2026-07-15T13:00:00Z" })).toEqual({ ok: false, reason: "end_not_after_start" });
    expect(buildAppointmentEventPayload({ ...BASE, startsAt: "not-a-date" })).toEqual({ ok: false, reason: "invalid_datetime" });
    expect(buildAppointmentEventPayload({ ...BASE, studioTimezone: "" })).toEqual({ ok: false, reason: "missing_studio_timezone" });
  });
});
