import { beforeEach, describe, expect, it, vi } from "vitest";

// Moving observes the Roles engine and never obeys it. A non-owner asking for custom_time is refused by the legacy
// owner gate straight after the observe calls, so the whole path can be driven with a stub and no mutation.

const state: { role: string; engine: { data: unknown; error: unknown } | "throws" } = { role: "practitioner", engine: { data: true, error: null } };
const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => {
  if (state.engine === "throws") throw new Error("engine down");
  return state.engine;
});

const APPT = "8a0c1a2e-1111-4222-8333-444455556666";
const CURRENT = "9b0c1a2e-1111-4222-8333-444455556666";
const OTHER = "7c0c1a2e-1111-4222-8333-444455556666";

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: CURRENT, role: state.role, active: true },
    studio: { id: "studio-1", timezone: "America/Toronto", practitioner_capacity_enabled: false },
  }),
}));
vi.mock("@/lib/supabase/admin-server", () => {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.maybeSingle = async () => ({
    data: { id: APPT, status: "confirmed", starts_at: "2099-01-01T15:00:00.000Z", client_id: "c1", duration_minutes: 30, practitioner_id: CURRENT, service_id: "s1" },
  });
  return { createAdminClient: () => ({ from: () => q }) };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc }) }));

import { moveAppointmentAction } from "@/app/(app)/calendar/move-appointment-actions";

const input = {
  appointmentId: APPT,
  expectedStartsAt: "2099-01-01T15:00:00.000Z",
  expectedEndsAt: "2099-01-01T15:30:00.000Z",
  localDate: "2099-01-01",
  localTime: "10:00",
  mode: "custom_time" as const,
  outsideAvailabilityConfirmed: true,
};
const keysAsked = () => rpc.mock.calls.map((c) => c[1].p_key);

beforeEach(() => {
  rpc.mockClear();
  state.role = "practitioner";
  state.engine = { data: true, error: null };
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("moving observes the engine and never obeys it", () => {
  const answers: Array<[string, typeof state.engine]> = [
    ["allows", { data: true, error: null }],
    ["denies", { data: false, error: null }],
    ["is absent", { data: null, error: { code: "PGRST202", message: "missing" } }],
    ["throws", "throws"],
  ];
  it.each(answers)("keeps the legacy owner-only refusal when the engine %s", async (_n, engine) => {
    state.engine = engine;
    const r = await moveAppointmentAction(input);
    expect(r).toEqual({ ok: false, error: "Only the studio owner can move appointments outside regular availability." });
  });

  it("asks appt.move about this appointment", async () => {
    await moveAppointmentAction(input);
    expect(rpc).toHaveBeenCalledWith("has_studio_permission", { p_studio: "studio-1", p_key: "appt.move", p_client: null, p_appointment: APPT, p_practitioner: null });
  });

  it("does not ask appt.reassign when no reassignment was requested, or the target is the current practitioner", async () => {
    await moveAppointmentAction(input);
    await moveAppointmentAction({ ...input, targetPractitionerId: CURRENT });
    expect(keysAsked()).toEqual(["appt.move", "appt.move"]);
  });

  it("asks appt.reassign, with no own-scope context, when a different practitioner is requested", async () => {
    await moveAppointmentAction({ ...input, targetPractitionerId: OTHER });
    expect(keysAsked()).toEqual(["appt.move", "appt.reassign"]);
    expect(rpc).toHaveBeenLastCalledWith("has_studio_permission", { p_studio: "studio-1", p_key: "appt.reassign", p_client: null, p_appointment: null, p_practitioner: null });
  });

  it("does not ask the engine about a malformed request", async () => {
    await moveAppointmentAction({ ...input, appointmentId: "not-a-uuid" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
