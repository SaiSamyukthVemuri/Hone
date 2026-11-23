import { beforeEach, describe, expect, it, vi } from "vitest";

// The same move submitted twice (a double click, a resubmitted form) must not send the client two "appointment moved" notices.
// The move is a compare-and-swap on the appointment's expected start and end: the first submission commits, the second finds the
// appointment already changed and is refused BEFORE any notice is attempted. A refused or unchanged move sends nothing, and the
// notice is never retried. The notifier is a spy: nothing is sent.

const h = vi.hoisted(() => ({
  rpcResults: [] as string[],
  notify: vi.fn<(admin: unknown, input: Record<string, unknown>) => Promise<string>>(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://app.example.test" }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "p-1", role: "owner", active: true, display_name: "Synthetic Ana", email: "ana@example.test" },
    studio: { id: "s-1", slug: "synthetic", timezone: "America/Toronto", practitioner_capacity_enabled: false },
  }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: { id: "a-1", status: "confirmed", starts_at: "2099-05-12T19:00:00Z", client_id: "c-1", duration_minutes: 30, practitioner_id: "p-1", service_id: "sv-1" },
          error: null,
        }),
      };
      return q;
    },
    rpc: async () => {
      const result = h.rpcResults.shift() ?? "moved";
      return { data: [{ result, new_starts_at: "2099-05-13T19:00:00Z", new_ends_at: "2099-05-13T19:30:00Z" }], error: null };
    },
  }),
}));
vi.mock("@/lib/email/notify-appointment-moved", () => ({ notifyAppointmentMoved: h.notify }));

import { moveAppointmentAction } from "@/app/(app)/calendar/move-appointment-actions";

const INPUT = {
  appointmentId: "11111111-1111-4111-8111-111111111111",
  expectedStartsAt: "2099-05-12T19:00:00.000Z",
  expectedEndsAt: "2099-05-12T19:30:00.000Z",
  localDate: "2099-05-13",
  localTime: "15:00",
  mode: "custom_time" as const,
  outsideAvailabilityConfirmed: true,
};

beforeEach(() => {
  h.rpcResults = [];
  h.notify.mockReset().mockResolvedValue("sent");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a move notifies the client once", () => {
  it("one successful move sends one notice", async () => {
    const r = await moveAppointmentAction(INPUT);
    expect(r.ok).toBe(true);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it.each(["stale_appointment", "no_change"])("the same move submitted again (%s) is refused and sends no second notice", async (second) => {
    h.rpcResults = ["moved", second];
    expect((await moveAppointmentAction(INPUT)).ok).toBe(true);
    expect((await moveAppointmentAction(INPUT)).ok).toBe(false);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it.each([
    "not_authorized",
    "appointment_not_found",
    "appointment_not_movable",
    "invalid_time",
    "booking_paused",
    "outside_availability",
    "buffer_conflict",
  ])("a move the command refuses (%s) sends nothing", async (result) => {
    h.rpcResults = [result];
    expect((await moveAppointmentAction(INPUT)).ok).toBe(false);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("a notice that could not be delivered is reported but NOT retried, and the move stands", async () => {
    h.notify.mockResolvedValue("degraded");
    const r = await moveAppointmentAction(INPUT);
    expect(r).toMatchObject({ ok: true, notificationStatus: "degraded" });
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("a studio that switched the notice off (the notifier skips) still completes the move with plain wording", async () => {
    h.notify.mockResolvedValue("skipped");
    const r = await moveAppointmentAction(INPUT);
    expect(r).toMatchObject({ ok: true, notificationStatus: "skipped", message: "Appointment moved." });
  });
});
