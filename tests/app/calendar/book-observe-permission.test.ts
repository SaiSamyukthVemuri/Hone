import { beforeEach, describe, expect, it, vi } from "vitest";

// The Roles engine is OBSERVED on booking, never obeyed: bookAppointmentForClientAction must return exactly what it
// returned before the observe call existed, whatever the engine answers, and must ask the engine about the practitioner
// the appointment is being booked FOR (the own-scope context appt.book needs).

const state: { role: string; engine: { data: unknown; error: unknown } | "throws" } = {
  role: "practitioner",
  engine: { data: true, error: null },
};
const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => {
  if (state.engine === "throws") throw new Error("engine down");
  return state.engine;
});

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "prac-1", role: state.role, active: true },
    studio: { id: "studio-1", timezone: "America/Toronto", default_appointment_duration_minutes: 30, buffer_minutes: 0 },
  }),
}));

// The services lookup returns no row, so the action ends at "Service not found." right after the observe call.
vi.mock("@/lib/supabase/server", () => {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.maybeSingle = async () => ({ data: null, error: null });
  return { createClient: async () => ({ from: () => q, rpc }) };
});

import { bookAppointmentForClientAction } from "@/app/(app)/calendar/actions";

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}
const base = { client_id: "c1", service_id: "s1", starts_at: "2099-01-01T15:00:00.000Z" };

beforeEach(() => {
  rpc.mockClear();
  state.role = "practitioner";
  state.engine = { data: true, error: null };
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("booking observes the engine and never obeys it", () => {
  const answers: Array<[string, typeof state.engine]> = [
    ["allows", { data: true, error: null }],
    ["denies", { data: false, error: null }],
    ["is unreadable", { data: null, error: { code: "42501", message: "denied" } }],
    ["is absent", { data: null, error: { code: "PGRST202", message: "missing" } }],
    ["throws", "throws"],
  ];
  it.each(answers)("returns the same result when the engine %s", async (_name, engine) => {
    state.engine = engine;
    const r = await bookAppointmentForClientAction(fd(base));
    expect(r).toEqual({ ok: false, error: "Service not found." });
  });

  it("does not turn a legacy refusal into a success when the engine allows", async () => {
    state.role = "practitioner";
    const r = await bookAppointmentForClientAction(fd({ ...base, allow_outside_availability: "true" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/only the studio owner/i);
    // The legacy owner gate refused first, so the engine was never asked.
    expect(rpc).not.toHaveBeenCalled();
  });

  it("asks about the acting practitioner for a non-owner, even if another practitioner is submitted", async () => {
    state.role = "practitioner";
    await bookAppointmentForClientAction(fd({ ...base, practitioner_id: "prac-2" }));
    expect(rpc).toHaveBeenCalledWith("has_studio_permission", expect.objectContaining({ p_key: "appt.book", p_studio: "studio-1", p_practitioner: "prac-1", p_appointment: null }));
  });

  it("asks about the chosen practitioner when an owner books for someone else", async () => {
    state.role = "owner";
    await bookAppointmentForClientAction(fd({ ...base, practitioner_id: "prac-2" }));
    expect(rpc).toHaveBeenCalledWith("has_studio_permission", expect.objectContaining({ p_key: "appt.book", p_practitioner: "prac-2" }));
  });

  it("does not ask the engine for a request that is rejected as malformed", async () => {
    await bookAppointmentForClientAction(fd({ client_id: "c1" }));
    expect(rpc).not.toHaveBeenCalled();
  });
});
