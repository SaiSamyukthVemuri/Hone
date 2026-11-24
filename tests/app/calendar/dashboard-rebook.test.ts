import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardRebookCalendarHref, withDashboardRebook } from "@/lib/calendar/dashboard-rebook";
import { loadDashboardRebook } from "@/app/(app)/calendar/load-dashboard-rebook";

const calls = vi.hoisted(() => ({
  from: vi.fn(), select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(), next: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: calls.from }) }));
vi.mock("@/lib/dashboard/next-visit-for-roster", () => ({ getNextVisitsForRoster: calls.next }));

const id = "ec1f43d5-3d33-4096-a3d1-3f37ebd4fa65";
const source = {
  id, client_id: "person", practitioner_id: "practitioner", service_id: "service",
  starts_at: "2030-01-16T01:00:00Z", ends_at: "2030-01-16T01:30:00Z",
  client: { name: "Morgan Lane", preferred_name: "Mo", archived_at: null },
};
const studio = { id: "studio-a", timezone: "America/Toronto" };
const load = (appointment: string | undefined = id, period = "week") =>
  loadDashboardRebook(appointment, period, studio, "2030-01-17", "24h");

beforeEach(() => {
  vi.resetAllMocks();
  const query = { select: calls.select, eq: calls.eq, maybeSingle: calls.maybeSingle };
  calls.from.mockReturnValue(query);
  calls.select.mockReturnValue(query);
  calls.eq.mockReturnValue(query);
  calls.maybeSingle.mockResolvedValue({ data: source, error: null });
  calls.next.mockResolvedValue(new Map());
});

describe("dashboard rebooking on the regular calendar", () => {
  it("retains origin across view, date and practitioner selections", () => {
    expect(dashboardRebookCalendarHref(id, "2030-01-15", "week")).toBe(
      `/calendar?view=week&day=2030-01-15&rebook=${id}&rebookPeriod=week`,
    );
    expect(withDashboardRebook("/calendar?view=day&people=123", { appointmentId: id }))
      .toBe(`/calendar?view=day&people=123&rebook=${id}`);
    expect(withDashboardRebook("/calendar?view=week", null)).toBe("/calendar?view=week");
    expect(withDashboardRebook("/calendar/upcoming", { appointmentId: id })).toBe("/calendar/upcoming");
  });

  it("scopes source to the current studio, resolving dates and the return path on the server", async () => {
    calls.next.mockResolvedValue(new Map([[id, { starts_at: "2030-02-04T01:30:00Z", service: {name: "Treatment"} }]]));
    expect(await load()).toEqual({
      appointmentId: id, clientId: "person", clientName: "Mo", practitionerId: "practitioner",
      serviceId: "service", durationMinutes: 30, period: "week",
      dashboardHref: `/dashboard?period=week&day=2030-01-15#appointment-${id}`,
      next: { day: "2030-02-03", label: expect.stringMatching(/Feb.*3.*2030.*20:30.*Treatment/) },
    });
    expect(calls.eq.mock.calls).toEqual([["studio_id", studio.id], ["id", id]]);
    expect(calls.select).toHaveBeenCalledWith(expect.stringContaining("clients!appointments_client_same_studio_fk"));
  });

  it("ignores arbitrary return paths and distinguishes no next visit from an unavailable read", async () => {
    expect(await load(id, "https://other.example")).toMatchObject({
      dashboardHref: `/dashboard?day=2030-01-15#appointment-${id}`, next: null,
    });
    calls.next.mockRejectedValue(new Error("unavailable"));
    expect((await load())?.next).toBe("unavailable");
  });

  it("returns no booking context for a missing, archived, or foreign visit", async () => {
    expect(await load("bad-id")).toBeNull();
    expect(calls.from).not.toHaveBeenCalled();
    calls.maybeSingle.mockResolvedValueOnce({data: null, error: null});
    expect(await load()).toBeNull();
    calls.maybeSingle.mockResolvedValueOnce({data: {...source, client: {...source.client, archived_at: "2030-01-17"}}, error: null});
    expect(await load()).toBeNull();
    expect(calls.next).not.toHaveBeenCalled();
  });
});
