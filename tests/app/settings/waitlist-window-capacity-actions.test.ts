import { beforeEach, describe, expect, it, vi } from "vitest";

// The capacity estimate's outstanding-invitation count (HON-7, 0323). The scope columns
// have no API grant, so the narrowed count comes from an owner-gated function; until it is
// applied the action falls back to counting every live invitation and says so.

const h = vi.hoisted(() => ({
  role: "owner" as string,
  rpc: vi.fn(),
  liveCount: { count: 0 as number | null, error: null as unknown },
  liveCalls: 0,
  slots: [] as { start: string; end: string }[],
}));

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { role: h.role }, studio: { id: "s-1" } }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { slug: "x", timezone: "UTC", buffer_minutes: 0 }, error: null }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/booking/public-slot-range", () => ({
  fetchPublicSlotsForDates: async () => ({ ok: true, slots: h.slots }),
}));
vi.mock("@/lib/supabase/server", () => {
  const chain: any = {
    eq: () => chain,
    is: () => chain,
    gt: async () => {
      h.liveCalls += 1;
      return h.liveCount;
    },
  };
  return {
    createClient: async () => ({ rpc: h.rpc, from: () => ({ select: () => chain }) }),
  };
});

import { estimateWindowCapacityAction } from "@/app/(app)/settings/waitlist/window-capacity-actions";

const SERVICE = "11111111-1111-4111-8111-111111111111";
const slot = (n: number) => ({
  start: new Date(Date.UTC(2030, 0, 1 + n, 9)).toISOString(),
  end: new Date(Date.UTC(2030, 0, 1 + n, 10)).toISOString(),
});

beforeEach(() => {
  h.role = "owner";
  h.rpc.mockReset();
  h.liveCount = { count: 7, error: null };
  h.liveCalls = 0;
  h.slots = [slot(0), slot(1), slot(2), slot(3), slot(4)];
});

describe("capacity estimate — outstanding invitations", () => {
  it("uses the owner-gated function when it exists and reports a window-scoped count", async () => {
    h.rpc.mockResolvedValue({ data: 2, error: null });
    const r = await estimateWindowCapacityAction({ serviceId: SERVICE, windowDays: 14, allowedWeekdays: [1, 3] });
    expect(r).toEqual({ ok: true, fit: 5, outstanding: 2, open: 3, outstandingScope: "window" });
    expect(h.rpc).toHaveBeenCalledTimes(1);
    const [name, args] = h.rpc.mock.calls[0];
    expect(name).toBe("count_competing_waitlist_invitations");
    expect(args).toMatchObject({ p_studio_id: "s-1", p_weekdays: [1, 3] });
    expect(args.p_to > args.p_from).toBe(true);
    expect(h.liveCalls).toBe(0);
  });

  it("passes null weekdays when every day is allowed", async () => {
    h.rpc.mockResolvedValue({ data: 0, error: null });
    await estimateWindowCapacityAction({ serviceId: SERVICE, windowDays: 7, allowedWeekdays: [] });
    expect(h.rpc.mock.calls[0][1].p_weekdays).toBeNull();
  });

  for (const code of ["PGRST202", "42883"]) {
    it(`falls back to counting every live invitation when the function is absent (${code})`, async () => {
      h.rpc.mockResolvedValue({ data: null, error: { code, message: "absent" } });
      const r = await estimateWindowCapacityAction({ serviceId: SERVICE, windowDays: 14, allowedWeekdays: null });
      expect(r).toEqual({ ok: true, fit: 5, outstanding: 7, open: 0, outstandingScope: "all" });
      expect(h.liveCalls).toBe(1);
    });
  }

  it("does NOT fall back on any other error: the estimate is unavailable", async () => {
    for (const code of ["42501", "22023", "57014", "XX000"]) {
      h.rpc.mockResolvedValue({ data: null, error: { code, message: "no" } });
      const r = await estimateWindowCapacityAction({ serviceId: SERVICE, windowDays: 14, allowedWeekdays: null });
      expect(r).toEqual({ ok: false });
    }
    expect(h.liveCalls).toBe(0);
  });

  it("is unavailable when the fallback count itself fails", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "absent" } });
    h.liveCount = { count: null, error: { code: "42501" } };
    expect(await estimateWindowCapacityAction({ serviceId: SERVICE, windowDays: 14, allowedWeekdays: null })).toEqual({ ok: false });
  });

  it("rejects a malformed function answer", async () => {
    for (const data of [null, -1, 1.5, "2"]) {
      h.rpc.mockResolvedValue({ data, error: null });
      expect(await estimateWindowCapacityAction({ serviceId: SERVICE, windowDays: 14, allowedWeekdays: null })).toEqual({ ok: false });
    }
  });

  it("never asks a non-owner", async () => {
    h.role = "assistant";
    expect(await estimateWindowCapacityAction({ serviceId: SERVICE, windowDays: 14, allowedWeekdays: null })).toEqual({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
