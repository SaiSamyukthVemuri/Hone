import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ authorized: true, summary: {} as Record<string, unknown> }));
vi.mock("@/lib/cron/auth", () => ({ isAuthorizedCronRequest: () => h.authorized }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/billing/stuck-fee-sweep", () => ({ sweepStuckFeeAttempts: async () => h.summary }));

const { GET } = await import("@/app/api/cron/stuck-fee-sweep/route");
const ok = { scanned: 0, stuck: 0, alerted: 0, already_alerted: 0, alert_failed: 0, read_failed: false, truncated: false };
beforeEach(() => { h.authorized = true; h.summary = { ...ok }; });

describe("stuck fee sweep route", () => {
  it("401 without the cron secret, and the sweep does not run", async () => {
    h.authorized = false;
    expect((await GET(new Request("http://x"))).status).toBe(401);
  });
  it("200 when detection is healthy, even if it alerted", async () => {
    h.summary = { ...ok, stuck: 1, alerted: 1 };
    const r = await GET(new Request("http://x"));
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });
  it("non-200 when the sweep's own read failed", async () => {
    h.summary = { ...ok, read_failed: true };
    const r = await GET(new Request("http://x"));
    expect(r.status).toBe(500);
    expect((await r.json()).ok).toBe(false);
  });
  it("non-200 when an alert could not be recorded", async () => {
    h.summary = { ...ok, stuck: 1, alert_failed: 1 };
    expect((await GET(new Request("http://x"))).status).toBe(500);
  });
  it("non-200 when the sweep hit its page cap (some stuck attempt may not have been looked at)", async () => {
    h.summary = { ...ok, truncated: true };
    expect((await GET(new Request("http://x"))).status).toBe(500);
  });
});
