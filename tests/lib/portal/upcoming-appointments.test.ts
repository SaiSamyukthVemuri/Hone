import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getPortalUpcomingAppointments } from "@/lib/portal/queries";

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: vi.fn() }));

function database(fetch: typeof globalThis.fetch) {
  vi.mocked(createAdminClient).mockReturnValue(createClient("http://fixture.test", "fixture", { global: { fetch } }));
}

afterEach(() => vi.restoreAllMocks());

describe("portal upcoming appointments", () => {
  it("reserves empty for a successful read with no appointments", async () => {
    database(async () => Response.json([]));
    expect(await getPortalUpcomingAppointments("studio", "client")).toEqual([]);
  });

  it.each([
    ["a rejected read", async () => Response.json({ code: "42501", message: "sensitive database detail" }, { status: 403 })],
    ["an unreadable body", async () => new Response(null, { status: 204 })],
    ["an aborted connection", async () => { throw new DOMException("sensitive network detail", "AbortError"); }],
  ] as const)("returns unavailable on %s without logging private data", async (_name, fetch) => {
    database(fetch);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getPortalUpcomingAppointments("private-studio", "private-client")).toBeNull();
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-(studio|client)|sensitive/);
  });

  it("fails the whole read when a later page cannot be loaded", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const urls: URL[] = [];
    database(async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      if (urls.length > 1) {
        return Response.json({ code: "42501", message: "unavailable" }, { status: 403 });
      }
      const pageLength = Number(url.searchParams.get("limit"));
      return Response.json(Array.from({ length: pageLength }, (_, index) => ({ id: "visit-" + index })));
    });
    expect(await getPortalUpcomingAppointments("studio", "client")).toBeNull();
    expect(urls).toHaveLength(2);
    expect(urls[1].searchParams.get("studio_id")).toBe("eq.studio");
    expect(urls[1].searchParams.get("client_id")).toBe("eq.client");
    expect(log).toHaveBeenCalledOnce();
  });

  it("includes a booking moved beyond the old 20-visit cutoff", async () => {
    const visits = Array.from({ length: 22 }, (_, i) => ({
      id: i === 21 ? "rescheduled" : "visit-" + i,
      starts_at: new Date(Date.UTC(2035, 0, i + 1, 10)).toISOString(),
      ends_at: new Date(Date.UTC(2035, 0, i + 1, 11)).toISOString(),
      duration_minutes: 60,
      service: { name: "Consultation" },
    }));
    database(async (input) => {
      const q = new URL(String(input)).searchParams;
      expect(q.get("studio_id")).toBe("eq.studio");
      expect(q.get("client_id")).toBe("eq.client");
      expect(q.get("status")).toBe("eq.confirmed");
      expect(q.get("starts_at")).toMatch(/^gt\.\d{4}-/);
      const offset = Number(q.get("offset") ?? 0);
      return Response.json(visits.slice(offset, offset + Number(q.get("limit") ?? 1000)));
    });
    const appointments = await getPortalUpcomingAppointments("studio", "client");
    expect(appointments?.map(a => a.id)).toEqual(visits.map(a => a.id));
  });
});
