import { describe, expect, it } from "vitest";
import {
  CANCEL_REASONS,
  UNKNOWN_FAILURE,
  cancelDeskBooking,
  createDeskBooking,
  isCancelReason,
  moveDeskBooking,
  readBookingOptions,
  readStudioTimezone,
} from "@/lib/desk/book";
import type { DeskRpc } from "@/lib/desk/read";

function rpcOf(data: unknown, error: unknown = null) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const db = { rpc: async (fn: string, args: Record<string, unknown>) => (calls.push({ fn, args }), { data, error }) } as unknown as DeskRpc;
  return { db, calls };
}

describe("booking options and studio clock", () => {
  it("reads names, lengths and colours only", async () => {
    const { db, calls } = rpcOf([
      { kind: "service", id: "s1", name: "Consultation", duration_minutes: 30, color: null, price: "SENTINEL" },
      { kind: "practitioner", id: "p1", name: "Pat", color: "#fff", duration_minutes: null },
      { kind: "other", id: "x", name: "ignored" },
      { kind: "service", id: "", name: "no id" },
    ]);
    const out = await readBookingOptions(db, "studio-1");
    expect(calls).toEqual([{ fn: "receptionist_booking_options", args: { p_studio_id: "studio-1" } }]);
    expect(out).toEqual({
      services: [{ id: "s1", name: "Consultation", durationMinutes: 30 }],
      practitioners: [{ id: "p1", name: "Pat", color: "#fff" }],
    });
    expect(JSON.stringify(out)).not.toContain("SENTINEL");
  });

  it("failures are fixed messages", async () => {
    await expect(readBookingOptions(rpcOf(null, { message: "secret@example.test" }).db, "s")).rejects.toThrow(/^Failed to load booking options$/);
    await expect(readStudioTimezone(rpcOf(null, { message: "x" }).db, "s")).rejects.toThrow(/^Failed to load studio clock$/);
    await expect(readStudioTimezone(rpcOf("").db, "s")).rejects.toThrow();
    expect(await readStudioTimezone(rpcOf("America/Toronto").db, "s")).toBe("America/Toronto");
  });
});

describe("create / move / cancel call the 0220 commands with no actor", () => {
  it("create passes exactly the command's arguments and treats only 'created' as success", async () => {
    const ok = rpcOf([{ result: "created" }]);
    expect(await createDeskBooking(ok.db, "st", { practitionerId: "p", clientId: "c", serviceId: "s", startsAtIso: "2031-01-01T10:00:00.000Z" })).toEqual({ ok: true });
    expect(ok.calls).toEqual([{ fn: "receptionist_create_appointment", args: { p_studio_id: "st", p_target_practitioner_id: "p", p_client_id: "c", p_service_id: "s", p_starts_at: "2031-01-01T10:00:00.000Z" } }]);
    const refused = await createDeskBooking(rpcOf([{ result: "not_eligible" }]).db, "st", { practitionerId: "p", clientId: "c", serviceId: "s", startsAtIso: "x" });
    expect(refused).toEqual({ ok: false, message: "That practitioner doesn't offer that service." });
    expect(await createDeskBooking(rpcOf([]).db, "st", { practitionerId: "p", clientId: "c", serviceId: "s", startsAtIso: "x" })).toEqual({ ok: false, message: UNKNOWN_FAILURE });
  });

  it("a taken slot (23P01) is its own message; any other error is the generic one with nothing echoed", async () => {
    const input = { practitionerId: "p", clientId: "c", serviceId: "s", startsAtIso: "x" };
    expect(await createDeskBooking(rpcOf(null, { code: "23P01", message: "conflict secret@example.test" }).db, "st", input)).toEqual({ ok: false, message: "That time was just taken. Choose another time." });
    const other = await createDeskBooking(rpcOf(null, { code: "XX000", message: "boom secret@example.test" }).db, "st", input);
    expect(other).toEqual({ ok: false, message: UNKNOWN_FAILURE });
  });

  it("move accepts the three success results and passes the stale-check interval", async () => {
    for (const result of ["moved", "reassigned", "moved_and_reassigned"]) {
      const r = rpcOf([{ result }]);
      expect(await moveDeskBooking(r.db, "st", { appointmentId: "a", practitionerId: "p", expectedStartsAtIso: "1", expectedEndsAtIso: "2", newStartsAtIso: "3" })).toEqual({ ok: true });
      expect(r.calls[0].args).toEqual({ p_studio_id: "st", p_appointment_id: "a", p_target_practitioner_id: "p", p_expected_starts_at: "1", p_expected_ends_at: "2", p_new_starts_at: "3" });
    }
    const stale = await moveDeskBooking(rpcOf([{ result: "stale_appointment" }]).db, "st", { appointmentId: "a", practitionerId: "p", expectedStartsAtIso: "1", expectedEndsAtIso: "2", newStartsAtIso: "3" });
    expect(stale.ok).toBe(false);
  });

  it("cancel sends the closed-list text and treats only 'cancelled' as success", async () => {
    const r = rpcOf("cancelled");
    expect(await cancelDeskBooking(r.db, "st", { appointmentId: "a", reason: "client_requested" })).toEqual({ ok: true });
    expect(r.calls).toEqual([{ fn: "receptionist_cancel_appointment", args: { p_studio_id: "st", p_appointment_id: "a", p_reason: CANCEL_REASONS.client_requested } }]);
    expect(await cancelDeskBooking(rpcOf("already_cancelled").db, "st", { appointmentId: "a", reason: "other" })).toEqual({ ok: false, message: "That appointment is already cancelled." });
  });

  it("the cancellation reason is a closed list", () => {
    expect(isCancelReason("other")).toBe(true);
    for (const bad of ["", "Client asked to cancel", "__proto__", "toString", 7, null]) expect(isCancelReason(bad)).toBe(false);
  });
});
