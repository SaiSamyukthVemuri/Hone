import { beforeEach, describe, expect, it, vi } from "vitest";

let identityError: Error | null = null;
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let results: Record<string, { data: unknown; error: unknown }> = {};
const revalidated: string[] = [];

vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidated.push(p) }));
vi.mock("@/lib/desk/guard", () => ({
  getReceptionistWithStudio: async () => {
    if (identityError) throw identityError;
    return { studioId: "studio-1", receptionistId: "r1", displayName: "Desk" };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return results[fn] ?? { data: null, error: { message: "unexpected" } };
    },
  }),
}));

import { bookAppointmentAction, cancelAppointmentAction, moveAppointmentAction, type DeskActionState } from "@/app/(desk)/desk/actions";

const idle: DeskActionState = { status: "idle" };
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";
const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
};

beforeEach(() => {
  identityError = null;
  rpcCalls.length = 0;
  revalidated.length = 0;
  results = { receptionist_studio_timezone: { data: "America/Toronto", error: null } };
});

describe("bookAppointmentAction", () => {
  const good = { clientId: U1, serviceId: U2, practitionerId: U3, date: "2031-01-15", time: "09:30" };

  it("books in the STUDIO's clock through the command, and revalidates the schedule", async () => {
    results.receptionist_create_appointment = { data: [{ result: "created" }], error: null };
    const out = await bookAppointmentAction(idle, form(good));
    expect(out).toEqual({ status: "ok", message: "Appointment booked." });
    const call = rpcCalls.find((c) => c.fn === "receptionist_create_appointment")!;
    expect(call.args).toEqual({ p_studio_id: "studio-1", p_target_practitioner_id: U3, p_client_id: U1, p_service_id: U2, p_starts_at: "2031-01-15T14:30:00.000Z" });
    expect(revalidated).toEqual(["/desk"]);
  });

  it("no form field can name the studio or the actor", async () => {
    results.receptionist_create_appointment = { data: [{ result: "created" }], error: null };
    await bookAppointmentAction(idle, form({ ...good, studioId: "other-studio", p_studio_id: "other-studio", receptionistId: "x" }));
    const call = rpcCalls.find((c) => c.fn === "receptionist_create_appointment")!;
    expect(call.args.p_studio_id).toBe("studio-1");
    expect(JSON.stringify(call.args)).not.toContain("other-studio");
  });

  it("bad ids and bad times never reach the command", async () => {
    expect((await bookAppointmentAction(idle, form({ ...good, clientId: "nope" }))).status).toBe("error");
    expect((await bookAppointmentAction(idle, form({ ...good, date: "2031-03-09", time: "02:30" }))).status).toBe("error"); // DST gap
    expect((await bookAppointmentAction(idle, form({ ...good, time: "" }))).status).toBe("error");
    expect(rpcCalls.some((c) => c.fn === "receptionist_create_appointment")).toBe(false);
  });

  it("a refusal, a taken slot and a thrown guard are fixed messages and do not revalidate", async () => {
    results.receptionist_create_appointment = { data: null, error: { code: "23P01", message: "secret@example.test" } };
    expect(await bookAppointmentAction(idle, form(good))).toEqual({ status: "error", message: "That time was just taken. Choose another time." });
    identityError = new Error("not a receptionist secret@example.test");
    const out = await bookAppointmentAction(idle, form(good));
    expect(out).toEqual({ status: "error", message: "That didn't go through. Try again." });
    expect(revalidated).toEqual([]);
  });
});

describe("moveAppointmentAction", () => {
  const good = { appointmentId: U1, practitionerId: U3, expectedStartsAt: "2031-01-15T14:30:00Z", expectedEndsAt: "2031-01-15T15:30:00Z", date: "2031-01-16", time: "10:00" };

  it("moves with the stale-check interval and a studio-clock start", async () => {
    results.receptionist_move_appointment = { data: [{ result: "moved" }], error: null };
    expect(await moveAppointmentAction(idle, form(good))).toEqual({ status: "ok", message: "Appointment moved." });
    expect(rpcCalls.find((c) => c.fn === "receptionist_move_appointment")!.args).toEqual({
      p_studio_id: "studio-1", p_appointment_id: U1, p_target_practitioner_id: U3,
      p_expected_starts_at: "2031-01-15T14:30:00.000Z", p_expected_ends_at: "2031-01-15T15:30:00.000Z", p_new_starts_at: "2031-01-16T15:00:00.000Z",
    });
  });

  it("a stale appointment is reported, and bad input never calls the command", async () => {
    results.receptionist_move_appointment = { data: [{ result: "stale_appointment" }], error: null };
    expect((await moveAppointmentAction(idle, form(good))).status).toBe("error");
    rpcCalls.length = 0;
    expect((await moveAppointmentAction(idle, form({ ...good, expectedStartsAt: "junk" }))).status).toBe("error");
    expect((await moveAppointmentAction(idle, form({ ...good, appointmentId: "x" }))).status).toBe("error");
    expect(rpcCalls.some((c) => c.fn === "receptionist_move_appointment")).toBe(false);
  });
});

describe("cancelAppointmentAction", () => {
  it("cancels with a closed-list reason", async () => {
    results.receptionist_cancel_appointment = { data: "cancelled", error: null };
    expect(await cancelAppointmentAction(idle, form({ appointmentId: U1, reason: "client_requested" }))).toEqual({ status: "ok", message: "Appointment cancelled." });
    expect(rpcCalls.find((c) => c.fn === "receptionist_cancel_appointment")!.args).toEqual({ p_studio_id: "studio-1", p_appointment_id: U1, p_reason: "Client asked to cancel" });
  });

  it("free text or an unknown reason never reaches the command", async () => {
    for (const reason of ["I do not like them (free text)", "", "__proto__"]) {
      expect((await cancelAppointmentAction(idle, form({ appointmentId: U1, reason }))).status).toBe("error");
    }
    expect(rpcCalls).toEqual([]);
  });
});
