import { beforeEach, describe, expect, it, vi } from "vitest";

// A closed week is a real ZERO; a failed lookup is not. Both used to come back as the same `{ ok: false }`, so a studio with no open weekday was told
// "We couldn't check availability" and could not invite anyone beyond the estimate.

const h = vi.hoisted(() => ({
  range: { ok: true, slots: [], scanned: [], skippedOutsideHorizon: [] } as Record<string, unknown>,
  studio: { data: { slug: "s", timezone: "UTC", buffer_minutes: 0 }, error: null } as { data: unknown; error: unknown },
}));
vi.mock("@/lib/booking/public-slot-range", () => ({ fetchPublicSlotsForDates: async () => h.range }));

const { computeConsultationFit } = await import("@/lib/waitlist/send-time-fit");
const admin = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => h.studio }) }) }) } as never;
const input = { admin, studioId: "st", serviceId: "sv", windowDays: 14, allowedWeekdays: null };

beforeEach(() => {
  h.range = { ok: true, slots: [], scanned: [], skippedOutsideHorizon: [] };
  h.studio = { data: { slug: "s", timezone: "UTC", buffer_minutes: 0 }, error: null };
});

describe("computeConsultationFit: no open days vs a failed lookup", () => {
  it("a studio with no open weekday is ok with a fit of zero", async () => {
    h.range = { ok: false, error: "This studio is not accepting bookings online.", reason: "no_open_days" };
    const r = await computeConsultationFit(input);
    expect(r).toMatchObject({ ok: true, fit: 0 });
    expect((r as { firstDate: string }).firstDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("a failed availability read stays a failure", async () => {
    h.range = { ok: false, error: "Availability could not be read." };
    expect(await computeConsultationFit(input)).toEqual({ ok: false });
  });
  it("a studio with no bookable service (no reason given) stays a failure", async () => {
    h.range = { ok: false, error: "This studio is not accepting bookings online." };
    expect(await computeConsultationFit(input)).toEqual({ ok: false });
  });
  it("an unreadable studio stays a failure", async () => {
    h.studio = { data: null, error: { code: "XX000" } };
    expect(await computeConsultationFit(input)).toEqual({ ok: false });
  });
  it("a studio that throws stays a failure", async () => {
    h.range = null as never;
    expect(await computeConsultationFit(input)).toEqual({ ok: false });
  });
  it("open days with no openings in the window is still a zero (unchanged)", async () => {
    expect(await computeConsultationFit(input)).toMatchObject({ ok: true, fit: 0 });
  });
});
