import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildWaitlistAnalytics } from "@/lib/business-analytics/waitlist-model";

const h = vi.hoisted(() => ({ role: "owner", read: vi.fn(), capacity: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({ requirePractitionerWithStudio: async () => ({ practitioner: { role: h.role }, studio: { id: "session-studio", timezone: "UTC" } }) }));
vi.mock("@/lib/business-analytics/server/waitlist-read", () => ({ loadWaitlistAnalytics: h.read }));
vi.mock("@/app/(app)/settings/waitlist/window-capacity-actions", () => ({ estimateWindowCapacityAction: h.capacity }));
import AnalyticsWaitlistPage from "@/app/(app)/financials/analytics/waitlist/page";
const view = buildWaitlistAnalytics({ now: new Date("2026-11-22T12:00:00Z"), timezone: "UTC", periodStartIso: "2026-10-23T12:00:00Z", command: null, outcomes: { total: 0, declined: 0, linkUsed: 0, expiredRecorded: 0, deadlinePassed: 0, released: 0, open: 0 }, pool: null, delivery: { accepted: null, refused: null, unknown: null, unrecorded: null } });
const read = () => ({ access: "granted", view, params: { days: 14, serviceId: "session-consult", notices: [] }, services: [{ id: "session-consult", name: "Consultation" }], servicesAvailable: true });
beforeEach(() => { vi.clearAllMocks(); h.role = "owner"; h.read.mockResolvedValue(read()); h.capacity.mockResolvedValue({ ok: false }); });
describe("Waitlist Analytics page", () => {
  it.each(["practitioner", "assistant", "admin", "", "OWNER"])('refuses %s before analytics or privileged capacity reads', async (role) => {
    h.role = role; const page = await AnalyticsWaitlistPage({ searchParams: Promise.resolve({}) });
    expect(JSON.stringify(page)).toContain("Only the studio owner can see Analytics.");
    expect(h.read).not.toHaveBeenCalled(); expect(h.capacity).not.toHaveBeenCalled();
  });
  it("uses the session studio and the loader's validated service rather than request identifiers", async () => {
    await AnalyticsWaitlistPage({ searchParams: Promise.resolve({ studio_id: "foreign-studio", service: "foreign-service", days: "900" }) });
    expect(h.read.mock.calls[0][1]).toEqual({ id: "session-studio", timezone: "UTC" });
    expect(h.capacity).toHaveBeenCalledWith({ serviceId: "session-consult", windowDays: 14, allowedWeekdays: null });
  });
  it("does not call capacity when no validated eligible service was selected", async () => {
    h.read.mockResolvedValue({ ...read(), params: { days: 7, serviceId: null, notices: ["Choose a consultation."] } });
    const tree = await AnalyticsWaitlistPage({ searchParams: Promise.resolve({ service: "foreign" }) });
    expect(h.capacity).not.toHaveBeenCalled(); expect(tree).not.toBeNull();
  });
  it("honours the loader's own refusal", async () => {
    h.read.mockResolvedValue({ access: "refused" });
    expect(await AnalyticsWaitlistPage({ searchParams: Promise.resolve({}) })).toBeNull(); expect(h.capacity).not.toHaveBeenCalled();
  });
});
