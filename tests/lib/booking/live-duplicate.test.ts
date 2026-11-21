import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { findLiveDuplicateAppointment, isLiveRepeatViolation, LIVE_REPEAT_INDEX } = await import("@/lib/booking/live-duplicate");

function fakeAdmin(result: { data: unknown; error: unknown }) {
  const calls: [string, unknown][] = [];
  const q: Record<string, unknown> = {
    select: () => q,
    eq: (k: string, v: unknown) => { calls.push([k, v]); return q; },
    limit: async () => result,
  };
  return { admin: { from: () => q } as never, calls };
}
const Q = { studioId: "s", clientId: "c", serviceId: "v", startsAtIso: "2099-01-01T15:00:00.000Z" };

describe("findLiveDuplicateAppointment", () => {
  it("finds the live appointment for this client, service and exact start", async () => {
    const { admin, calls } = fakeAdmin({ data: [{ id: "a1" }], error: null });
    expect(await findLiveDuplicateAppointment(admin, Q)).toEqual({ state: "found", appointmentId: "a1" });
    expect(Object.fromEntries(calls)).toEqual({ studio_id: "s", client_id: "c", service_id: "v", starts_at: Q.startsAtIso, status: "confirmed" });
  });
  it("adds the practitioner only when one is named", async () => {
    const { admin, calls } = fakeAdmin({ data: [], error: null });
    await findLiveDuplicateAppointment(admin, { ...Q, practitionerId: "p" });
    expect(Object.fromEntries(calls)).toHaveProperty("practitioner_id", "p");
  });
  it("only a confirmed appointment is live: history is never a repeat", async () => {
    const { admin, calls } = fakeAdmin({ data: [], error: null });
    await findLiveDuplicateAppointment(admin, Q);
    expect(calls).toContainEqual(["status", "confirmed"]);
  });
  it("none found", async () => {
    expect(await findLiveDuplicateAppointment(fakeAdmin({ data: [], error: null }).admin, Q)).toEqual({ state: "none" });
  });
  it("an unreadable lookup is its own answer, never 'none'", async () => {
    expect(await findLiveDuplicateAppointment(fakeAdmin({ data: null, error: { message: "x" } }).admin, Q)).toEqual({ state: "unreadable" });
  });
});

describe("isLiveRepeatViolation", () => {
  it("is the unique violation on the one-live-appointment rule, by SQLSTATE and the rule's name", () => {
    expect(isLiveRepeatViolation({ code: "23505", message: `duplicate key value violates unique constraint "${LIVE_REPEAT_INDEX}"` })).toBe(true);
    expect(isLiveRepeatViolation({ code: "23505", message: "x", details: `Key (client_id)... ${LIVE_REPEAT_INDEX}` })).toBe(true);
  });
  it("is never another unique violation, another SQLSTATE or no error", () => {
    expect(isLiveRepeatViolation({ code: "23505", message: 'violates unique constraint "clients_studio_email_key"' })).toBe(false);
    expect(isLiveRepeatViolation({ code: "23P01", message: LIVE_REPEAT_INDEX })).toBe(false);
    expect(isLiveRepeatViolation({ message: LIVE_REPEAT_INDEX })).toBe(false);
    expect(isLiveRepeatViolation(null)).toBe(false);
    expect(isLiveRepeatViolation(undefined)).toBe(false);
  });
});
