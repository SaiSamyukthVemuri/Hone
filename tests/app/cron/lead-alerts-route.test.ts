import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// LEAD-ALERT-01 (#826): /api/cron/lead-alerts is the recovery sweep. It runs
// only for the real CRON_SECRET bearer, does nothing but sweep, and answers
// with counts alone.

const h = vi.hoisted(() => ({
  sweeps: 0,
  summary: {
    ok: true,
    expired: 0,
    blocked: null as string | null,
    blockedAlerts: 0,
    attempted: 1,
    accepted: 1,
    retryScheduled: 0,
    failed: 0,
    other: 0,
  },
}));

vi.mock("@/lib/platform-leads/alert-delivery", () => ({
  sweepPlatformLeadAlerts: async () => {
    h.sweeps += 1;
    return h.summary;
  },
}));

import { GET } from "@/app/api/cron/lead-alerts/route";

const SECRET = "lead-alert-route-test-secret";
const saved = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  h.sweeps = 0;
  h.summary.ok = true;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = saved;
});

const request = (auth?: string) =>
  new Request("https://hone.example/api/cron/lead-alerts", {
    headers: auth ? { authorization: auth } : {},
  });

describe("GET /api/cron/lead-alerts", () => {
  it("refuses without the bearer, or with the wrong one, and sweeps nothing", async () => {
    for (const auth of [undefined, "Bearer wrong", SECRET, `Basic ${SECRET}`]) {
      const res = await GET(request(auth));
      expect(res.status, String(auth)).toBe(401);
    }
    expect(h.sweeps).toBe(0);
  });

  it("refuses everything when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(request("Bearer undefined"))).status).toBe(401);
    expect(h.sweeps).toBe(0);
  });

  it("with the bearer: one sweep, and its counts as the answer", async () => {
    const res = await GET(request(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(h.summary);
    expect(h.sweeps).toBe(1);
  });

  it("a sweep whose database calls failed answers 500, so the scheduler sees it", async () => {
    h.summary.ok = false;
    expect((await GET(request(`Bearer ${SECRET}`))).status).toBe(500);
  });

  it("is registered as a DAILY Vercel cron (the plan's ceiling); more often needs the external scheduler", () => {
    const vercel = JSON.parse(readFileSync(path.join(process.cwd(), "vercel.json"), "utf8")) as {
      crons?: { path: string; schedule: string }[];
    };
    const entry = (vercel.crons ?? []).find((c) => c.path === "/api/cron/lead-alerts");
    expect(entry?.schedule).toMatch(/^\d+ \d+ \* \* \*$/);
  });
});
