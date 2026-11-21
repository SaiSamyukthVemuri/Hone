import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/waitlist/over-invite-run", () => ({ OVER_INVITE_CRON_BUDGET_MS: 40_000, runRounds: async () => ({}) }));

// A Next.js route file may export only its HTTP handlers and Next's own config fields; anything else fails `next build` (not tsc, not lint).
describe("the background route's exports", () => {
  it("exports only GET and maxDuration", async () => {
    const mod = await import("@/app/api/cron/waitlist-invitation-batches/route");
    expect(Object.keys(mod).sort()).toEqual(["GET", "maxDuration"]);
    expect(readFileSync("app/api/cron/waitlist-invitation-batches/route.ts", "utf8")).not.toMatch(/export const OVER_INVITE/);
  });
});
