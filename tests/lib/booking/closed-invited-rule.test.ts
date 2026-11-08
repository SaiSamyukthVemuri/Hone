import { describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({ rpc }) }));

import {
  invitedBookingRefusalKind,
  newClientAdmissionInvitedRefusalKind,
  newClientAdmissionRefusesInvitedBooking,
  readClosedInvitedBookingRule,
  type ClosedInvitedRule,
} from "@/lib/booking/new-client-admission";

const adm = (mode: string) => ({ ok: true, mode, source: "persisted" }) as never;
const unreadable = { ok: false } as never;
const RULES: ClosedInvitedRule[] = ["applied", "absent", "unreadable"];

describe("the closed-invited rule (0323) — pure predicate", () => {
  it("open and waitlist never refuse an invited booking, whatever the rule says", () => {
    for (const mode of ["open", "waitlist"]) for (const r of RULES) {
      expect(newClientAdmissionRefusesInvitedBooking(adm(mode), r)).toBe(false);
      expect(newClientAdmissionInvitedRefusalKind(adm(mode), r)).toBeNull();
    }
  });

  it("an unreadable MODE always refuses, as unreadable, whatever the rule says", () => {
    for (const r of RULES) {
      expect(newClientAdmissionRefusesInvitedBooking(unreadable, r)).toBe(true);
      expect(newClientAdmissionInvitedRefusalKind(unreadable, r)).toBe("unreadable");
    }
  });

  it("closed: allowed only when the rule is applied; absent says closed; a failed read says unreadable", () => {
    expect(newClientAdmissionInvitedRefusalKind(adm("closed"), "applied")).toBeNull();
    expect(newClientAdmissionInvitedRefusalKind(adm("closed"), "absent")).toBe("closed");
    expect(newClientAdmissionInvitedRefusalKind(adm("closed"), "unreadable")).toBe("unreadable");
  });
});

describe("readClosedInvitedBookingRule — detection through the marker", () => {
  it("true means applied", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    expect(await readClosedInvitedBookingRule()).toBe("applied");
    expect(rpc).toHaveBeenLastCalledWith("waitlist_closed_invited_booking_enabled");
  });
  it.each(["PGRST202", "42883"])("%s means absent", async (code) => {
    rpc.mockResolvedValue({ data: null, error: { code } });
    expect(await readClosedInvitedBookingRule()).toBe("absent");
  });
  it("any other error, a non-true answer, or a throw fails closed as unreadable", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    expect(await readClosedInvitedBookingRule()).toBe("unreadable");
    rpc.mockResolvedValue({ data: false, error: null });
    expect(await readClosedInvitedBookingRule()).toBe("unreadable");
    rpc.mockRejectedValue(new Error("down"));
    expect(await readClosedInvitedBookingRule()).toBe("unreadable");
  });
});

describe("invitedBookingRefusalKind — reads the marker only for a closed studio", () => {
  it("does not call the database for open, waitlist or an unreadable mode", async () => {
    rpc.mockReset();
    for (const a of [adm("open"), adm("waitlist"), unreadable]) await invitedBookingRefusalKind(a);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("closed + applied lets it through; closed + absent refuses as closed", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    expect(await invitedBookingRefusalKind(adm("closed"))).toBeNull();
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    expect(await invitedBookingRefusalKind(adm("closed"))).toBe("closed");
  });
});
