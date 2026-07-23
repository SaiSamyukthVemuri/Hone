import { describe, it, expect, beforeEach, vi } from "vitest";
import { utcInstantFromLocal } from "@/lib/booking/tz";

// Behavioural tests for the two Move server actions — the CLOSED mode contract,
// owner authorization for custom-time, and the server-side available-slot
// membership check. Every dependency that would touch auth/DB/RPC is mocked so we
// assert the action's DECISIONS (accept/reject, RPC called or short-circuited),
// never a real database.

const TZ = "America/Toronto";
// Derive a FUTURE date from the real clock — NOT a hardcoded year. A fixed future date
// silently becomes PAST once it passes, and moveAppointmentAction rejects past targets
// before the mocked RPC, which would turn this suite into a time bomb.
const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
  .format(new Date(Date.now() + 120 * 86_400_000));
const localISO = (hhmm: string) => utcInstantFromLocal(DAY, hhmm, TZ).toISOString();

type St = {
  practitioner: { id: string; role: string };
  studio: {
    id: string;
    timezone: string;
    default_appointment_duration_minutes: number;
    buffer_minutes: number;
  };
  appt: Record<string, unknown> | null;
  slots: Array<{ start: string; end: string; startLabel: string }>;
  rpcResult: unknown;
  rpcError: { code?: string } | null;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
};

const state: St = {
  practitioner: { id: "prac-1", role: "owner" },
  studio: { id: "studio-1", timezone: TZ, default_appointment_duration_minutes: 60, buffer_minutes: 0 },
  appt: null,
  slots: [],
  rpcResult: [{ result: "moved", new_starts_at: localISO("10:00"), new_ends_at: localISO("11:00") }],
  rpcError: null,
  rpcCalls: [],
};

const h = vi.hoisted(() => ({ getAvailableSlots: vi.fn(), notify: vi.fn() }));

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(async () => ({
    practitioner: state.practitioner,
    studio: state.studio,
  })),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => ({ data: state.appt });
    return {
      from: () => chain,
      rpc: async (name: string, args: Record<string, unknown>) => {
        state.rpcCalls.push({ name, args });
        return state.rpcError ? { data: null, error: state.rpcError } : { data: state.rpcResult, error: null };
      },
    };
  },
}));
vi.mock("@/lib/booking/slots", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getAvailableSlots: h.getAvailableSlots };
});
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://test.example" }));
vi.mock("@/lib/email/notify-appointment-moved", () => ({ notifyAppointmentMoved: h.notify }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { moveAppointmentAction, loadMoveSlotsAction } from "@/app/(app)/calendar/move-appointment-actions";

const APPT_ID = "11111111-1111-1111-1111-111111111111";
const EXPECT_START = localISO("09:00");
const EXPECT_END = localISO("10:00");

function baseMove(over: Record<string, unknown> = {}) {
  return {
    appointmentId: APPT_ID,
    expectedStartsAt: EXPECT_START,
    expectedEndsAt: EXPECT_END,
    localDate: DAY,
    localTime: "03:00", // 3 AM — outside typical hours; the action never checks hours
    mode: "custom_time" as const,
    outsideAvailabilityConfirmed: true,
    ...over,
  };
}

beforeEach(() => {
  state.practitioner = { id: "prac-1", role: "owner" };
  state.appt = { id: APPT_ID, status: "confirmed", starts_at: EXPECT_START, client_id: "client-1", duration_minutes: 60, practitioner_id: "pr-1" };
  state.slots = [
    { start: localISO("10:00"), end: localISO("11:00"), startLabel: "10:00 AM" },
    { start: localISO("14:00"), end: localISO("15:00"), startLabel: "2:00 PM" },
  ];
  state.rpcResult = [{ result: "moved", new_starts_at: localISO("03:00"), new_ends_at: localISO("04:00") }];
  state.rpcError = null;
  state.rpcCalls = [];
  h.getAvailableSlots.mockImplementation(async () => state.slots);
  h.notify.mockImplementation(async () => "sent");
});

// ---- §22 custom-time authorization + mode contract ----
describe("custom_time — owner authorization", () => {
  it("owner can move to a future outside-hours custom time (RPC called, ID preserved)", async () => {
    const res = await moveAppointmentAction(baseMove());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.appointmentId).toBe(APPT_ID);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].name).toBe("move_or_reassign_appointment");
    // Studio timezone is used (never the browser tz): 3 AM DAY Toronto -> its UTC instant.
    expect(state.rpcCalls[0].args.p_new_starts_at).toBe(localISO("03:00"));
    // custom_time does NOT gate on the generated slot list.
    expect(h.getAvailableSlots).not.toHaveBeenCalled();
  });

  it("non-owner cannot use custom_time; RPC is never called", async () => {
    state.practitioner = { id: "prac-2", role: "practitioner" };
    const res = await moveAppointmentAction(baseMove());
    expect(res).toEqual({ ok: false, error: "Only the studio owner can move appointments outside regular availability." });
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("ignores a browser-forged isOwner/role/studioId — server role is authoritative", async () => {
    state.practitioner = { id: "prac-2", role: "practitioner" };
    const res = await moveAppointmentAction(
      baseMove({ isOwner: true, role: "owner", canUseCustomTime: true, studioId: "other", practitionerId: "x" } as never),
    );
    expect(res.ok).toBe(false);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("custom_time without acknowledgement is rejected; RPC not called", async () => {
    const res = await moveAppointmentAction(baseMove({ outsideAvailabilityConfirmed: false }));
    expect(res).toEqual({ ok: false, error: "Confirm that you want to override regular availability." });
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("unknown mode is rejected", async () => {
    const res = await moveAppointmentAction(baseMove({ mode: "sneaky" as never }));
    expect(res).toEqual({ ok: false, error: "Invalid request." });
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("past custom time is rejected", async () => {
    const res = await moveAppointmentAction(baseMove({ localDate: "2020-01-02", localTime: "10:00" }));
    expect(res).toEqual({ ok: false, error: "Choose a valid future time." });
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("malformed date / time are rejected", async () => {
    expect(await moveAppointmentAction(baseMove({ localDate: "2027-6-15" }))).toEqual({ ok: false, error: "Invalid request." });
    expect(await moveAppointmentAction(baseMove({ localTime: "9:00" }))).toEqual({ ok: false, error: "Invalid request." });
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("forwards optimistic-concurrency endpoints and maps a stale RPC outcome", async () => {
    state.rpcResult = [{ result: "stale_appointment" }];
    const res = await moveAppointmentAction(baseMove());
    expect(res).toMatchObject({ ok: false, code: "stale" });
    expect(state.rpcCalls[0].args.p_expected_starts_at).toBe(EXPECT_START);
    expect(state.rpcCalls[0].args.p_expected_ends_at).toBe(EXPECT_END);
  });

  it("maps a 23P01 exclusion violation to the safe conflict copy (appointment unchanged)", async () => {
    state.rpcError = { code: "23P01" };
    const res = await moveAppointmentAction(baseMove());
    expect(res).toEqual({ ok: false, code: "conflict", error: "That time is no longer available. Choose another time." });
  });
});

// ---- §23 available-slot server verification ----
describe("available_slot — server-side membership verification", () => {
  const avail = (over: Record<string, unknown> = {}) =>
    baseMove({ mode: "available_slot", outsideAvailabilityConfirmed: false, localTime: "10:00", ...over });

  it("recomputes the offered slots server-side with the own-reservation exclusion", async () => {
    await moveAppointmentAction(avail());
    expect(h.getAvailableSlots).toHaveBeenCalledTimes(1);
    const call = h.getAvailableSlots.mock.calls[0];
    expect(call[4]).toEqual({ sourceKind: "appointment", sourceId: APPT_ID }); // exclusion arg
  });

  it("accepts a time that IS a currently-offered slot (RPC called)", async () => {
    const res = await moveAppointmentAction(avail({ localTime: "10:00" }));
    expect(res.ok).toBe(true);
    expect(state.rpcCalls).toHaveLength(1);
  });

  it("rejects an arbitrary time not present in the slot list; RPC never called", async () => {
    const res = await moveAppointmentAction(avail({ localTime: "13:37" }));
    expect(res).toEqual({ ok: false, code: "conflict", error: "That time is no longer available. Choose another time." });
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("a non-owner can still use available_slot mode", async () => {
    state.practitioner = { id: "prac-2", role: "practitioner" };
    const res = await moveAppointmentAction(avail({ localTime: "14:00" }));
    expect(res.ok).toBe(true);
  });
});

// ---- §6 loadMoveSlotsAction ----
describe("loadMoveSlotsAction — canUseCustomTime is server-derived", () => {
  it("owner → canUseCustomTime true; PHI-free slot list", async () => {
    state.practitioner = { id: "prac-1", role: "owner" };
    const res = await loadMoveSlotsAction({ appointmentId: APPT_ID, localDate: DAY });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.canUseCustomTime).toBe(true);
      expect(res.slots).toEqual([
        { start: localISO("10:00"), end: localISO("11:00"), label: "10:00 AM" },
        { start: localISO("14:00"), end: localISO("15:00"), label: "2:00 PM" },
      ]);
    }
  });

  it("non-owner → canUseCustomTime false", async () => {
    state.practitioner = { id: "prac-2", role: "practitioner" };
    const res = await loadMoveSlotsAction({ appointmentId: APPT_ID, localDate: DAY });
    expect(res.ok && res.canUseCustomTime).toBe(false);
  });
});
