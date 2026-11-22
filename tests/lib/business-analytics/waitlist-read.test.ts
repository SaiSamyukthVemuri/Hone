import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const h = vi.hoisted(() => ({
  create: vi.fn(), command: vi.fn(), outcomes: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: h.create }));
vi.mock("@/lib/waitlist/invitation-booking-summary-read", () => ({ loadCommandCounts: h.command, loadOutcomeCounts: h.outcomes }));
import { loadWaitlistAnalytics } from "@/lib/business-analytics/server/waitlist-read";
const now = new Date("2026-11-22T12:00:00Z");
const studio = { id: "own-studio", timezone: "UTC" };
function fake({ count = 1, rows = [{ status: "waiting", joined_at: "2026-11-20T12:00:00Z" }], error = null as unknown, servicesCount = 3, invitationsCount = 4 } = {}) {
  const calls: Array<{ table: string; selected?: string; filters: Array<[string, string, unknown]> }> = [];
  const db = { from: (table: string) => {
    const call = { table, selected: undefined as string | undefined, filters: [] as Array<[string, string, unknown]> }; calls.push(call);
    const result = () => table === "new_client_waitlist_entries" ? { data: rows, count, error } : table === "services" ? { data: [
      { id: "consult", name: "Consultation", modality: "consultation", active: true },
      { id: "treatment", name: "Treatment", modality: "thermolysis", active: true },
      { id: "inactive", name: "Consultation inactive", modality: "consultation", active: false },
    ], count: servicesCount, error } : call.selected === "entry_id" ? { data: [{ entry_id: "person-a" }, { entry_id: "person-a" }, { entry_id: "person-b" }, { entry_id: "person-c" }], count: invitationsCount, error } : { count: 2, error };
    type Query = { select: (s: string) => Query; order: () => Query; limit: () => Query; then: (resolve: (r: unknown) => unknown) => Promise<unknown> } & Record<"eq" | "in" | "gte" | "is", (column: string, value: unknown) => Query>;
    const filter = (op: string) => (column: string, value: unknown): Query => { call.filters.push([op, column, value]); return q; };
    const q: Query = { select: (s) => { call.selected = s; return q; }, order: () => q, limit: () => q, then: (resolve) => Promise.resolve(result()).then(resolve), eq: filter("eq"), in: filter("in"), gte: filter("gte"), is: filter("is") };
    return q;
  } } as unknown as SupabaseClient;
  return { db, calls };
}
beforeEach(() => {
  vi.clearAllMocks(); h.command.mockResolvedValue(null); h.outcomes.mockResolvedValue({ total: 4, declined: 1, linkUsed: 1, expiredRecorded: 0, released: 0, open: 2, deadlinePassed: 0 });
});
describe("waitlist owner session loader", () => {
  it.each(["practitioner", "assistant", "admin", "OWNER", ""])('refuses %s before creating or querying a client', async (role) => {
    expect(await loadWaitlistAnalytics({ role }, studio, {}, now)).toEqual({ access: "refused" });
    expect(h.create).not.toHaveBeenCalled(); expect(h.command).not.toHaveBeenCalled(); expect(h.outcomes).not.toHaveBeenCalled();
  });
  it("selects only status/time or service fields, with the session studio on every query, returning no prospect rows", async () => {
    const { db, calls } = fake(); const result = await loadWaitlistAnalytics({ role: "owner" }, studio, {}, now, db);
    expect(result.access).toBe("granted"); if (result.access !== "granted") throw new Error("owner refused");
    expect(result.services).toEqual([{ id: "consult", name: "Consultation" }]); expect(result.view.pool?.total).toBe(1);
    expect(calls.every((c) => c.filters.some((f) => f[1] === "studio_id" && f[2] === "own-studio"))).toBe(true);
    expect(calls.map((c) => c.selected).join(",")).not.toMatch(/email|phone|token|why_not_work|client_id/);
    expect(JSON.stringify(result)).not.toContain("2026-11-20T12:00:00Z");
    expect(h.command).toHaveBeenCalledWith(db, "own-studio", "2026-10-23T12:00:00.000Z");
    expect(result.view.conversion).toBeNull();
    expect(result.view.summary.peopleInvited).toBe(3);
    expect(JSON.stringify(result)).not.toContain("person-a");
  });
  it("fails the waiting figures closed when exact counts show truncation", async () => {
    const { db } = fake({ count: 1001 }); const r = await loadWaitlistAnalytics({ role: "owner" }, studio, {}, now, db);
    expect(r.access === "granted" && r.view.pool).toBeNull();
  });
  it("uses the aggregate command without reading entry references when available", async () => {
    h.command.mockResolvedValue({ invitationsTotal: 4, peopleInvited: 2, bookedLinkedLive: 1, bookedThenCancelled: 0, convertedUnlinked: 0 });
    const { db, calls } = fake();
    const r = await loadWaitlistAnalytics({ role: "owner" }, studio, {}, now, db);
    expect(r.access === "granted" && r.view.summary.peopleInvited).toBe(2);
    expect(calls.some((c) => c.selected === "entry_id")).toBe(false);
  });
  it("does not use a truncated eligible service list", async () => {
    const { db } = fake({ servicesCount: 1001 }); const r = await loadWaitlistAnalytics({ role: "owner" }, studio, {}, now, db);
    expect(r.access === "granted" && r.servicesAvailable).toBe(false);
    expect(r.access === "granted" && r.params.serviceId).toBeNull();
  });
  it("withholds distinct people when invitation rows are incomplete or no longer match the cohort", async () => {
    for (const invitationsCount of [1001, 5]) {
      const { db } = fake({ invitationsCount });
      const r = await loadWaitlistAnalytics({ role: "owner" }, studio, {}, now, db);
      expect(r.access === "granted" && r.view.summary.peopleInvited).toBeNull();
    }
  });
  it("failed reads are unknown, not zero, while unrelated invitation counts survive", async () => {
    const { db } = fake({ error: { code: "42501" } }); const r = await loadWaitlistAnalytics({ role: "owner" }, studio, {}, now, db);
    expect(r.access).toBe("granted"); if (r.access !== "granted") throw new Error("owner refused");
    expect(r.view.pool).toBeNull(); expect(r.view.delivery.accepted).toBeNull(); expect(r.view.summary.invitationsSent).toBe(4);
  });
});
