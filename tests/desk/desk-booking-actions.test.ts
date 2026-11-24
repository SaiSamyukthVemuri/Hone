import { beforeEach, describe, expect, it, vi } from "vitest";

const { guard, rpc, refresh } = vi.hoisted(() => ({ guard: vi.fn(), rpc: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/desk/guard", () => ({ requireReceptionistWithStudio: guard }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc }) }));
vi.mock("next/cache", () => ({ revalidatePath: refresh }));
import {
  bookDeskOpeningAction, findDeskOpeningsAction, getDeskBookingOptionsAction, searchDeskBookingClientsAction,
} from "@/app/(desk)/desk/booking-actions";

const id = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const studioId = id(1);
const serviceId = id(2);
const practitionerId = id(3);
const clientId = id(4);
const start = "2099-01-05T18:00:00.000Z";
const end = "2099-01-05T18:45:00.000Z";
const request = { studioId, serviceId, practitionerId, clientId, start, end };
const dates = { studioId, serviceId, practitionerIds: [practitionerId], earliest: "00:00", latestEnd: null, fromDate: "2099-01-05", toDate: "2099-01-06" };
beforeEach(() => {
  vi.resetAllMocks();
  guard.mockResolvedValue({ studioId, receptionistId: id(6) });
});

describe("receptionist booking", () => {
  it("reads only the permitted booking options and validated studio clock", async () => {
    rpc.mockImplementation(async (name: string) => ({ error: null, data: name === "receptionist_studio_timezone"
      ? "America/Toronto" : [{ id: serviceId, name: "Electrolysis", duration_minutes: 45, kind: "service", price: "SECRET" },
        { id: practitionerId, name: "Maya", kind: "practitioner", email: "PRIVATE" }] }));
    expect(await getDeskBookingOptionsAction()).toEqual({
      ok: true, studioId, timezone: "America/Toronto", services: [{ id: serviceId, name: "Electrolysis", durationMinutes: 45 }],
      practitioners: [{ id: practitionerId, name: "Maya" }],
    });
    expect(rpc).toHaveBeenCalledWith("receptionist_booking_options", { p_studio_id: studioId });
    expect(rpc).toHaveBeenCalledWith("receptionist_studio_timezone", { p_studio_id: studioId });
  });

  it("returns the scoped operational name and a masked contact hint from the versioned booking lookup", async () => {
    const rows = [
      { client_id: clientId, display_name: "Avery Rowan", phone: "555-222-1111", email: "avery@example.test" },
      { client_id: id(5), display_name: "Avery Walker", phone: null, email: "avery2@example.test" },
    ];
    rpc.mockResolvedValue({ data: rows, error: null });
    const result = await searchDeskBookingClientsAction({ studioId, query: "avery" });
    expect(result).toEqual({ ok: true, clients: [
      { id: clientId, displayName: "Avery Rowan", contactHint: "Phone ending in 1111" },
      { id: id(5), displayName: "Avery Walker", contactHint: "Email starts with a…" },
    ] });
    expect(rpc).toHaveBeenCalledWith("receptionist_booking_clients_v3", { p_studio_id: studioId, p_limit: 11, p_query: "avery" });
  });

  it("requires a narrower client search when the matching set cannot be fully disambiguated", async () => {
    rpc.mockResolvedValue({ data: Array.from({ length: 11 }, (_, i) => ({ client_id: id(i + 11), display_name: "Taylor", name_on_file: false })), error: null });
    expect((await searchDeskBookingClientsAction({ studioId, query: "Taylor" })).ok).toBe(false);
  });

  it("maps a selected opening, its precise instant, and whether the result was limited", async () => {
    rpc.mockResolvedValue({ data: [{ local_date: dates.fromDate, local_time: "13:00", practitioner_name: "Maya", practitioner_id: practitionerId,
      starts_at: start, ends_at: end, has_more: true, private_field: "PRIVATE" }], error: null });
    expect(await findDeskOpeningsAction(dates)).toEqual({ ok: true, limited: true, openings: [{
      date: dates.fromDate, localTime: "13:00", practitionerName: "Maya", practitionerId, serviceId, start, end,
    }] });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("receptionist_find_openings_v2", {
      p_studio_id: studioId, p_service_id: serviceId, p_practitioner_ids: [practitionerId], p_from_date: dates.fromDate, p_to_date: dates.toDate, p_earliest: "00:00", p_latest_end: null,
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("submits the displayed service, practitioner, start and end to the single guarded write", async () => {
    rpc.mockResolvedValue({ data: [{ result: "created", appointment_id: id(9) }], error: null });
    expect(await bookDeskOpeningAction(request)).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("receptionist_book_opening", {
      p_studio_id: studioId, p_client_id: clientId, p_service_id: serviceId, p_practitioner_id: practitionerId,
      p_start: start, p_expected_end: end,
    });
    expect(refresh).toHaveBeenCalledWith("/desk");
  });

  it("rejects a stale studio, over-wide date range or malformed dates before any RPC", async () => {
    expect((await bookDeskOpeningAction({ ...request, studioId: id(8) })).ok).toBe(false);
    expect((await findDeskOpeningsAction({ ...dates, toDate: "2099-01-13" })).ok).toBe(false);
    expect((await searchDeskBookingClientsAction({ studioId: id(8), query: "Avery" })).ok).toBe(false);
    expect((await findDeskOpeningsAction({ ...dates, earliest: "12:00", latestEnd: "12:00" })).ok).toBe(false);
    expect((await findDeskOpeningsAction({ ...dates, practitionerIds: [] })).ok).toBe(false);
    expect((await bookDeskOpeningAction({ ...request, start: "2099-01-05T13:00:00" })).ok).toBe(false);
    expect((await searchDeskBookingClientsAction({ studioId, query: "" })).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not disclose unreadable or inconsistent projections as free slots", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { details: "SENSITIVE" } })
      .mockResolvedValueOnce({ data: [{}], error: null });
    const first = await findDeskOpeningsAction(dates);
    expect(first.ok).toBe(false);
    expect(JSON.stringify(first)).not.toContain("SENSITIVE");
    expect((await findDeskOpeningsAction(dates)).ok).toBe(false);
  });

  it("distinguishes conflicts and an uncertain response without rerunning the writer", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "23P01" } })
      .mockResolvedValueOnce({ data: [{ result: "opening_unavailable" }], error: null })
      .mockRejectedValueOnce(new Error("PRIVATE"));
    const stale = { ok: false, error: "That opening is no longer available. Search for another time." };
    expect(await bookDeskOpeningAction(request)).toEqual(stale);
    expect(await bookDeskOpeningAction(request)).toEqual(stale);
    expect(await bookDeskOpeningAction(request)).toEqual({
      ok: false, error: "We couldn’t confirm whether this booking was saved. Check the desk schedule before trying again.",
    });
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("checks membership on every entry, even if a caller bypasses the page", async () => {
    guard.mockRejectedValue(new Error("no desk membership"));
    for (const call of [() => getDeskBookingOptionsAction(), () => bookDeskOpeningAction(request),
      () => findDeskOpeningsAction(dates), () => searchDeskBookingClientsAction({ studioId, query: "Avery" })]) {
      await expect(call()).rejects.toThrow("no desk membership");
    }
    expect(guard).toHaveBeenCalledTimes(4);
    expect(rpc).not.toHaveBeenCalled();
  });
});
