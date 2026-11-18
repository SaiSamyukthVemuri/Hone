import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ rpc: vi.fn(), boom: false }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    rpc: (...a: unknown[]) => {
      if (h.boom) throw new Error("synthetic");
      return h.rpc(...a);
    },
  }),
}));
import { markEntryBookedManually } from "@/lib/waitlist/booked-manually";
import {
  BOOKED_MANUALLY_COPY,
  BOOKED_MANUALLY_RESULTS,
  bookedManuallyNoticeFrom,
  bookedManuallyOk,
  waitlistBookedManuallyEnabled,
} from "@/lib/waitlist/booked-manually-notice";

const S = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const E = "33333333-3333-4333-8333-333333333333";
const A = "44444444-4444-4444-8444-444444444444";
beforeEach(() => {
  h.rpc.mockReset();
  h.boom = false;
});
const row = (result: unknown) => ({ data: [{ result, appointment_id: A, closed_invitations: 1, closed_followups: 1 }], error: null });

describe("markEntryBookedManually", () => {
  it("calls the one command with the session's studio and actor, the entry, the appointment and the explicit confirmation", async () => {
    h.rpc.mockResolvedValue(row("booked"));
    expect(await markEntryBookedManually(S, U, E, A, true)).toBe("booked");
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith("mark_waitlist_entry_booked_manually", {
      p_studio_id: S,
      p_actor_user_id: U,
      p_entry_id: E,
      p_appointment_id: A,
      p_confirm_email_mismatch: true,
    });
  });
  it("the mismatch confirmation is false unless it is exactly true", async () => {
    h.rpc.mockResolvedValue(row("booked"));
    await markEntryBookedManually(S, U, E, A, false);
    await markEntryBookedManually(S, U, E, A, "yes" as unknown as boolean);
    expect(h.rpc.mock.calls.map((c) => (c[1] as { p_confirm_email_mismatch: boolean }).p_confirm_email_mismatch)).toEqual([false, false]);
  });
  it.each(BOOKED_MANUALLY_RESULTS)("passes the closed result %s through unchanged", async (r) => {
    h.rpc.mockResolvedValue(row(r));
    expect(await markEntryBookedManually(S, U, E, A, false)).toBe(r);
  });
  it.each([
    ["an error", { data: null, error: { message: "x" } }],
    ["no rows", { data: [], error: null }],
    ["two rows", { data: [{ result: "booked" }, { result: "booked" }], error: null }],
    ["a non-array", { data: { result: "booked" }, error: null }],
    ["a missing result", { data: [{}], error: null }],
    ["an unknown result", row("success")],
    ["a non-string result", row(true)],
  ])("%s is unavailable, never success", async (_n, resp) => {
    h.rpc.mockResolvedValue(resp);
    expect(await markEntryBookedManually(S, U, E, A, false)).toBe("unavailable");
  });
  it("a thrown error is unavailable", async () => {
    h.boom = true;
    expect(await markEntryBookedManually(S, U, E, A, false)).toBe("unavailable");
  });
});

describe("the notice copy", () => {
  it("has a sentence for every result and for unavailable, none with an email, an id or a name placeholder", () => {
    for (const r of [...BOOKED_MANUALLY_RESULTS, "unavailable"] as const) {
      const t = BOOKED_MANUALLY_COPY[r];
      expect(t.length, r).toBeGreaterThan(10);
      expect(t, r).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}/i);
    }
  });
  it("only booked and already_booked read as success", () => {
    for (const r of [...BOOKED_MANUALLY_RESULTS, "unavailable"] as const) {
      expect(bookedManuallyOk(r)).toBe(r === "booked" || r === "already_booked");
    }
  });
  it("the invitation_redeemed and email_mismatch copy says what to do next", () => {
    expect(BOOKED_MANUALLY_COPY.invitation_redeemed).toMatch(/Open their booking/);
    expect(BOOKED_MANUALLY_COPY.email_mismatch).toMatch(/tick the confirmation/);
  });
  it("the page code reads back only known codes; anything else reads as a failure, never success", () => {
    expect(bookedManuallyNoticeFrom(undefined)).toBeNull();
    expect(bookedManuallyNoticeFrom("")).toBeNull();
    expect(bookedManuallyNoticeFrom("booked")).toBe("booked");
    expect(bookedManuallyNoticeFrom("<script>")).toBe("unavailable");
    expect(bookedManuallyNoticeFrom(["booked"])).toBe("unavailable");
  });
  it("is off unless the flag is exactly 1", () => {
    const old = process.env.WAITLIST_BOOKED_MANUALLY;
    try {
      delete process.env.WAITLIST_BOOKED_MANUALLY;
      expect(waitlistBookedManuallyEnabled()).toBe(false);
      for (const v of ["", "true", "on", "0", " 1"]) {
        process.env.WAITLIST_BOOKED_MANUALLY = v;
        expect(waitlistBookedManuallyEnabled(), v).toBe(false);
      }
      process.env.WAITLIST_BOOKED_MANUALLY = "1";
      expect(waitlistBookedManuallyEnabled()).toBe(true);
    } finally {
      if (old === undefined) delete process.env.WAITLIST_BOOKED_MANUALLY;
      else process.env.WAITLIST_BOOKED_MANUALLY = old;
    }
  });
});
