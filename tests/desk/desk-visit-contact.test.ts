import { beforeEach, describe, expect, it, vi } from "vitest";

const { guard, rpc } = vi.hoisted(() => ({ guard: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/desk/guard", () => ({ requireReceptionistWithStudio: guard }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc }) }));
import { getDeskAppointmentContactAction } from "@/app/(desk)/desk/contact-actions";

const studioId = "00000000-0000-4000-8000-000000000001";
const appointmentId = "00000000-0000-4000-8000-000000000002";
beforeEach(() => {
  vi.resetAllMocks();
  guard.mockResolvedValue({ studioId });
});

describe("opening the receptionist appointment contact", () => {
  it("requests the selected appointment and returns only its contacts", async () => {
    rpc.mockResolvedValue({ data: [{ email: " client@example.test ", phone: null, name: "excluded", note: "excluded" }], error: null });
    expect(await getDeskAppointmentContactAction({ studioId, appointmentId })).toEqual({ ok: true, email: "client@example.test", phone: null });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("receptionist_appointment_contact", { p_studio_id: studioId, p_appointment_id: appointmentId });
  });

  it("requires the guard, the correct studio and a valid appointment", async () => {
    for (const args of [{ studioId: "other", appointmentId }, { studioId, appointmentId: "invalid" }]) {
      expect((await getDeskAppointmentContactAction(args)).ok).toBe(false);
    }
    expect(guard).toHaveBeenCalledTimes(2);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("handles stale appointments, unavailable migrations, and unexpected replies", async () => {
    for (const data of [[], null, [{}], [{ email: null, phone: null }, { email: null, phone: null }]]) {
      rpc.mockResolvedValueOnce({ data, error: null });
      expect((await getDeskAppointmentContactAction({ studioId, appointmentId })).ok).toBe(false);
    }
    rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202" } });
    expect((await getDeskAppointmentContactAction({ studioId, appointmentId })).ok).toBe(false);
  });
});
