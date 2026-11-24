import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requestClient, current } = vi.hoisted(() => ({
  requestClient: vi.fn(),
  current: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: requestClient }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: current }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => { throw new Error("Staff search must use the request's RLS client"); },
}));

import { findCalendarOpeningsAction } from "@/app/(app)/calendar/find-time-actions";

const studio = {
  id: "home", timezone: "America/Toronto", buffer_minutes: 0,
  practitioner_capacity_enabled: true, practitioner_capacity_booking_enabled: true,
};
const practitioner = { id: "owner", active: true, role: "owner" };
const input = { serviceId: "svc", fromDate: "2026-11-25", toDate: "2026-11-26" };
const tables: Record<string, Record<string, unknown>[]> = {};
const reads: string[] = [];
let unavailable: string | undefined;

function fixtureClient() {
  // Exercise the actual query builder, range loader and slot generator against a
  // small PostgREST fixture. No mock provides a precomputed available time.
  return createSupabaseClient("https://studio.example", "test", {
    global: { fetch: async (request, init) => {
      const url = new URL(String(request));
      const table = url.pathname.split("/").at(-1)!;
      reads.push(table);
      if (table === unavailable) return Response.json({ message: "private diagnostic", code: "42501" }, { status: 403 });
      let rows = tables[table] ?? [];
      for (const [column, filter] of url.searchParams) {
        if (column === "select" || column === "order" || column === "offset" || column === "limit") continue;
        const dot = filter.indexOf(".");
        const operator = filter.slice(0, dot);
        const value = filter.slice(dot + 1);
        rows = rows.filter(row => {
          const actual = String(row[column]);
          if (operator === "eq" || operator === "is") return actual === value;
          if (operator === "lt") return actual < value;
          if (operator === "gt") return actual > value;
          if (operator === "gte") return actual >= value;
          if (operator === "lte") return actual <= value;
          throw new Error("Unexpected fixture filter " + filter);
        });
      }
      const single = new Headers(init?.headers).get("accept")?.includes("pgrst.object");
      return Response.json(single ? (rows[0] ?? null) : rows);
    } },
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-25T17:30:00Z")); // 12:30 PM in Toronto
  reads.length = 0;
  unavailable = undefined;
  current.mockResolvedValue({ practitioner, studio });
  requestClient.mockResolvedValue(fixtureClient());
  tables.services = [{ id: "svc", studio_id: "home", active: true, default_duration_minutes: 45 }];
  tables.practitioners = [
    ["owner", "home", true, "svc"], ["maya", "home", true, "svc"],
    ["inactive", "home", false, "svc"], ["foreign", "away", true, "svc"],
    ["other-service", "home", true, "other"],
  ].map(([id, studio_id, active, service]) => ({ id, display_name: id, studio_id, active, "service_practitioners.service_id": service }));
  tables.studio_availability_default = [3, 4].map(day_of_week => ({
    studio_id: "home", practitioner_id: null, day_of_week, is_open: true, open_time: "12:00", close_time: "15:00",
  }));
  tables.studio_availability_overrides = [];
  tables.studio_calendar_reservations = [{
    studio_id: "home", resource_key: "owner", starts_at: "2026-11-25T18:00:00.000Z",
    ends_at: "2026-11-25T19:00:00.000Z", source_kind: "timed_block",
  }];
  tables.studio_blockouts = [];
});
afterEach(() => vi.useRealTimers());

describe("calendar opening search", () => {
  it("offers only future, eligible team slots across the requested days using studio-local times", async () => {
    const result = await findCalendarOpeningsAction(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...new Set(result.openings.map(s => s.practitionerId))].sort()).toEqual(["maya", "owner"]);
    expect([...new Set(result.openings.map(s => s.date))]).toEqual([input.fromDate, input.toDate]);
    expect(result.openings.every(s => Date.parse(s.start) > Date.now())).toBe(true);
    const matches = result.openings.filter(s => s.start === "2026-11-25T18:00:00.000Z");
    expect(matches).toEqual([{
      start: "2026-11-25T18:00:00.000Z", end: "2026-11-25T18:45:00.000Z", date: input.fromDate,
      localTime: "13:00", practitionerId: "maya", practitionerName: "maya", serviceId: "svc",
    }]);
    expect(result.openings.map(s => s.start)).toEqual(result.openings.map(s => s.start).sort());
  });

  it("uses one reservation range read per practitioner independently of the number of days", async () => {
    const one = await findCalendarOpeningsAction({ ...input, toDate: input.fromDate });
    expect(one.ok).toBe(true);
    const oneDay = reads.length;
    reads.length = 0;
    const week = await findCalendarOpeningsAction({ ...input, toDate: "2026-12-01" });
    expect(week.ok).toBe(true);
    expect(reads).toHaveLength(oneDay);
    expect(reads.filter(table => table === "studio_calendar_reservations")).toHaveLength(2);
  });

  it("bounds results per day, includes later dates and discloses the omitted offers", async () => {
    for (let i = 0; i < 50; i++) tables.practitioners.push({
      id: String(i), display_name: String(i), active: true, studio_id: "home", "service_practitioners.service_id": "svc",
    });
    const result = await findCalendarOpeningsAction(input);
    expect(result.ok && result.limited).toBe(true);
    if (!result.ok) return;
    for (const date of [input.fromDate, input.toDate]) {
      expect(result.openings.filter(slot => slot.date === date)).toHaveLength(48);
    }
  });

  it("keeps offered wall times inside the real Toronto spring-forward day", async () => {
    vi.setSystemTime(new Date("2027-03-14T05:00:00Z")); // midnight before the clock change
    tables.studio_availability_default = [{
      studio_id: "home", practitioner_id: null, day_of_week: 0, is_open: true, open_time: "01:00", close_time: "05:00",
    }];
    const result = await findCalendarOpeningsAction({ ...input, practitionerId: "maya", fromDate: "2027-03-14", toDate: "2027-03-14" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.openings.map(slot => slot.localTime)).toContain("03:00");
    expect(result.openings.some(slot => slot.localTime.startsWith("02:"))).toBe(false);
    expect(result.openings.every(slot => Date.parse(slot.end) - Date.parse(slot.start) === 45 * 60000)).toBe(true);
  });

  it("respects studio closure and a practitioner's own changed hours", async () => {
    tables.studio_blockouts = [{ studio_id: "home", starts_on: input.toDate, ends_on: input.toDate }];
    tables.studio_availability_overrides = [{
      studio_id: "home", practitioner_id: "maya", effective_date: input.fromDate, is_open: false,
    }];
    expect(await findCalendarOpeningsAction({ ...input, practitionerId: "maya" })).toEqual({ ok: true, openings: [] });
  });

  it("uses a single shared timeline across assignable practitioners in capacity-off studios", async () => {
    current.mockResolvedValue({ practitioner, studio: { ...studio, practitioner_capacity_enabled: false } });
    const result = await findCalendarOpeningsAction(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.openings.some(s => s.practitionerId === "other-service")).toBe(true);
    expect(result.openings.some(s => s.start === "2026-11-25T18:00:00.000Z")).toBe(false);
    expect(reads.filter(t => t === "studio_calendar_reservations")).toHaveLength(1);
  });

  it("limits a member to their own eligible schedule and refuses a forged team selection", async () => {
    current.mockResolvedValue({ studio, practitioner: { ...practitioner, role: "practitioner" } });
    expect((await findCalendarOpeningsAction({ ...input, practitionerId: "maya" })).ok).toBe(false);
    expect(reads).toHaveLength(0);
    const own = await findCalendarOpeningsAction(input);
    expect(own.ok && new Set(own.openings.map(s => s.practitionerId))).toEqual(new Set(["owner"]));
  });

  it("refuses paused booking, inactive services and failed reservation reads", async () => {
    current.mockResolvedValueOnce({ practitioner, studio: { ...studio, practitioner_capacity_booking_enabled: false } });
    expect((await findCalendarOpeningsAction(input)).ok).toBe(false);
    tables.services[0]!.active = false;
    expect((await findCalendarOpeningsAction(input)).ok).toBe(false);
    tables.services[0]!.active = true;
    unavailable = "studio_calendar_reservations";
    expect(await findCalendarOpeningsAction(input)).toEqual({ ok: false, error: "Could not load available times. Please try again." });
  });

  it.each([
    ["2026-02-30", "2026-03-01"], ["2026-11-26", "2026-11-25"], ["2026-11-25", "2026-12-02"],
  ])("refuses an invalid or oversized date range before reading schedules", async (fromDate, toDate) => {
    expect((await findCalendarOpeningsAction({ ...input, fromDate, toDate })).ok).toBe(false);
    expect(reads).toHaveLength(0);
  });
});
