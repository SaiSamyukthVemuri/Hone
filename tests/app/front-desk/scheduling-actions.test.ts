import { beforeEach, describe, expect, it, vi } from "vitest";

// STUDIO-READY-02c (#824): the front-desk scheduling actions. The database
// command is the authority (tests/db/receptionist-scheduling.db.test.ts); this
// suite proves the action layer sends only what the command needs, refuses
// malformed or past input before any call, maps every sentinel to safe copy, and
// notifies only AFTER a committed result.

const STUDIO = { id: "11111111-1111-4111-8111-111111111111", name: "Studio", timezone: "America/Los_Angeles" };
const CLIENT = "22222222-2222-4222-8222-222222222222";
const SERVICE = "33333333-3333-4333-8333-333333333333";
const PRACT = "44444444-4444-4444-8444-444444444444";
const APPT = "55555555-5555-4555-8555-555555555555";

const ctx = vi.hoisted(() => ({
  rpc: vi.fn(),
  adminFrom: vi.fn(),
  dispatch: vi.fn(),
  notifyMoved: vi.fn(),
  sendCancel: vi.fn(),
  guard: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: ctx.rpc }) }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({ from: ctx.adminFrom }) }));
vi.mock("@/lib/receptionist/identity", () => ({ requireReceptionistWithStudio: ctx.guard }));
vi.mock("@/lib/booking/booking-notifications", () => ({ dispatchBookingNotifications: ctx.dispatch }));
vi.mock("@/lib/email/notify-appointment-moved", () => ({ notifyAppointmentMoved: ctx.notifyMoved }));
vi.mock("@/lib/email/send-appointment", () => ({ sendCancellationEmail: ctx.sendCancel }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://app.test" }));

const { bookFrontDeskAppointmentAction, moveFrontDeskAppointmentAction, cancelFrontDeskAppointmentAction } = await import(
  "@/lib/receptionist/scheduling-actions"
);

/** A chainable admin query that resolves to `row` for any table. */
function adminRows(rows: Record<string, unknown>) {
  ctx.adminFrom.mockImplementation((table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: rows[table] ?? null, error: null });
    return b;
  });
}

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const future = { date: "2031-08-04", time: "10:00" };

beforeEach(() => {
  vi.clearAllMocks();
  ctx.guard.mockResolvedValue({ receptionist: { id: "r-1", displayName: "Front Desk" }, studio: STUDIO });
  adminRows({});
});

describe("booking", () => {
  const ok = { client_id: CLIENT, service_id: SERVICE, practitioner_id: PRACT, ...future };

  it("calls receptionist_create_appointment with the server-resolved studio and NO actor, override or note", async () => {
    ctx.rpc.mockResolvedValue({ data: [{ result: "created", appointment_id: APPT }], error: null });
    const r = await bookFrontDeskAppointmentAction(null, form({ ...ok, studio_id: "forged", actor: "forged", notes: "x" }));
    expect(r).toEqual({ ok: true, message: "Appointment booked." });
    expect(ctx.rpc).toHaveBeenCalledTimes(1);
    const [name, args] = ctx.rpc.mock.calls[0];
    expect(name).toBe("receptionist_create_appointment");
    expect(Object.keys(args).sort()).toEqual(
      ["p_cancellation_token_hash", "p_client_id", "p_service_id", "p_starts_at", "p_studio_id", "p_target_practitioner_id"].sort(),
    );
    expect(args.p_studio_id).toBe(STUDIO.id);
    expect(args.p_cancellation_token_hash).toMatch(/^[a-f0-9]{64}$/);
    // 10:00 in Los Angeles on 2031-08-04 (PDT, UTC-7).
    expect(args.p_starts_at).toBe("2031-08-04T17:00:00.000Z");
  });

  it("refuses malformed ids and missing or past times BEFORE any call", async () => {
    for (const bad of [
      { ...ok, client_id: "not-a-uuid" },
      { ...ok, service_id: "" },
      { ...ok, date: "tomorrow" },
      { ...ok, time: "" },
      { ...ok, date: "2020-01-01" },
    ]) {
      const r = await bookFrontDeskAppointmentAction(null, form(bad));
      expect(r?.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(ctx.rpc).not.toHaveBeenCalled();
  });

  it("maps the command's refusals to safe copy and never notifies", async () => {
    for (const [result, copy] of [
      ["not_authorized", /no longer have front-desk access/],
      ["invalid_practitioner", /isn't available/],
      ["outside_availability", /outside the practitioner's availability/],
      ["buffer_conflict", /too close to another appointment/],
      ["not_eligible", /isn't set up for this service/],
      ["something_new", /Something went wrong/],
    ] as const) {
      ctx.rpc.mockResolvedValueOnce({ data: [{ result, appointment_id: null }], error: null });
      const r = await bookFrontDeskAppointmentAction(null, form(ok));
      expect(r?.ok).toBe(false);
      expect(r?.message).toMatch(copy);
    }
    expect(ctx.adminFrom).not.toHaveBeenCalled();
    expect(ctx.dispatch).not.toHaveBeenCalled();
  });

  it("a slot collision (23P01) is the slot-taken copy; other errors are generic and never echo the database", async () => {
    ctx.rpc.mockResolvedValueOnce({ data: null, error: { code: "23P01", message: "conflicting key value" } });
    expect((await bookFrontDeskAppointmentAction(null, form(ok)))?.message).toMatch(/no longer available/);
    ctx.rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "secret detail" } });
    const r = await bookFrontDeskAppointmentAction(null, form(ok));
    expect(r?.message).not.toMatch(/secret/);
    expect(ctx.dispatch).not.toHaveBeenCalled();
  });

  it("after a COMMITTED booking it sends the same notifications, naming the TREATING practitioner", async () => {
    ctx.rpc.mockResolvedValue({ data: [{ result: "created", appointment_id: APPT }], error: null });
    adminRows({
      appointments: { id: APPT, client_id: CLIENT, service_id: SERVICE, practitioner_id: PRACT, starts_at: "2031-08-04T17:00:00Z" },
      studios: { id: STUDIO.id, name: "Studio" },
      services: { id: SERVICE, name: "Electrolysis" },
      clients: { name: "Client One", email: "c@example.test", phone: null, sms_consent_at: null, sms_opted_out_at: null },
      practitioners: { display_name: "Pat", email: "pat@example.test" },
    });
    await bookFrontDeskAppointmentAction(null, form(ok));
    expect(ctx.dispatch).toHaveBeenCalledTimes(1);
    expect(ctx.dispatch.mock.calls[0][0]).toMatchObject({ practitionerName: "Pat", clientName: "Client One", notes: null });
  });

  it("a notification failure never turns a committed booking into a failure", async () => {
    ctx.rpc.mockResolvedValue({ data: [{ result: "created", appointment_id: APPT }], error: null });
    adminRows({
      appointments: { id: APPT, client_id: CLIENT, service_id: SERVICE, practitioner_id: PRACT },
      studios: { id: STUDIO.id },
      services: { id: SERVICE },
      clients: { name: "C" },
      practitioners: { email: "p@example.test" },
    });
    ctx.dispatch.mockRejectedValueOnce(new TypeError("provider down"));
    expect(await bookFrontDeskAppointmentAction(null, form(ok))).toEqual({ ok: true, message: "Appointment booked." });
  });
});

describe("moving", () => {
  const ok = {
    appointment_id: APPT,
    expected_starts_at: "2031-08-04T17:00:00Z",
    expected_ends_at: "2031-08-04T17:30:00Z",
    ...future,
    time: "13:00",
  };

  it("keeps the current practitioner when none is chosen, and sends no actor", async () => {
    ctx.rpc.mockResolvedValue({ data: [{ result: "moved" }], error: null });
    ctx.notifyMoved.mockResolvedValue("sent");
    const r = await moveFrontDeskAppointmentAction(null, form({ ...ok, practitioner_id: "" }));
    expect(r).toEqual({ ok: true, message: "Appointment moved." });
    const [name, args] = ctx.rpc.mock.calls[0];
    expect(name).toBe("receptionist_move_appointment");
    expect(args).toMatchObject({ p_studio_id: STUDIO.id, p_appointment_id: APPT, p_target_practitioner_id: null });
    expect(JSON.stringify(Object.keys(args))).not.toMatch(/actor|override|outside/);
    expect(ctx.notifyMoved.mock.calls[0][1]).toMatchObject({ appointmentId: APPT, studioId: STUDIO.id, resultKind: "moved" });
  });

  it("reports a reassignment truthfully, and a degraded notification honestly", async () => {
    ctx.rpc.mockResolvedValue({ data: [{ result: "moved_and_reassigned" }], error: null });
    ctx.notifyMoved.mockResolvedValue("degraded");
    const r = await moveFrontDeskAppointmentAction(null, form({ ...ok, practitioner_id: PRACT }));
    expect(r?.message).toBe("Appointment moved and reassigned, but the client notification could not be delivered.");
  });

  it("refuses stale and deactivated-practitioner moves with safe copy and no notification", async () => {
    for (const [result, copy] of [
      ["stale_appointment", /changed in another window/],
      ["practitioner_reassignment_required", /no longer active/],
      ["not_authorized", /no longer have front-desk access/],
    ] as const) {
      ctx.rpc.mockResolvedValueOnce({ data: [{ result }], error: null });
      expect((await moveFrontDeskAppointmentAction(null, form(ok)))?.message).toMatch(copy);
    }
    expect(ctx.notifyMoved).not.toHaveBeenCalled();
  });
});

describe("cancelling", () => {
  it("cancels through receptionist_cancel_appointment and emails the client naming the FRONT DESK", async () => {
    ctx.rpc.mockResolvedValue({ data: "cancelled", error: null });
    adminRows({
      appointments: {
        starts_at: "2031-08-04T17:00:00Z",
        duration_minutes: 30,
        client: { name: "Client One", email: "c@example.test" },
        service: { name: "Electrolysis" },
        studio: { id: STUDIO.id, name: "Studio", slug: "studio" },
      },
    });
    const r = await cancelFrontDeskAppointmentAction(null, form({ appointment_id: APPT, reason: "client called" }));
    expect(r).toEqual({ ok: true, message: "Appointment cancelled." });
    expect(ctx.rpc.mock.calls[0]).toEqual([
      "receptionist_cancel_appointment",
      { p_studio_id: STUDIO.id, p_appointment_id: APPT, p_reason: "client called" },
    ]);
    expect(ctx.sendCancel.mock.calls[0][0]).toMatchObject({
      to: "c@example.test",
      actorRole: "receptionist",
      actorName: "Front Desk",
      rebookUrl: "https://app.test/book/studio",
    });
  });

  it("already cancelled is idempotent success; a refusal sends nothing", async () => {
    ctx.rpc.mockResolvedValueOnce({ data: "already_cancelled", error: null });
    expect((await cancelFrontDeskAppointmentAction(null, form({ appointment_id: APPT })))?.ok).toBe(true);
    ctx.rpc.mockResolvedValueOnce({ data: "not_cancelable", error: null });
    expect((await cancelFrontDeskAppointmentAction(null, form({ appointment_id: APPT })))?.message).toMatch(/can't be cancelled/);
    expect(ctx.sendCancel).not.toHaveBeenCalled();
  });

  it("refuses a malformed id before any call", async () => {
    expect((await cancelFrontDeskAppointmentAction(null, form({ appointment_id: "x" })))?.ok).toBe(false);
    expect(ctx.rpc).not.toHaveBeenCalled();
  });
});
