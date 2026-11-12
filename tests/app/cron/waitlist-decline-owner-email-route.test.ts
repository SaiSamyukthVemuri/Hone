import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ dispatch: vi.fn(), retention: vi.fn() }));
vi.mock("@/lib/waitlist/decline-owner-email", () => ({ dispatchDeclineOwnerEmail: h.dispatch }));
vi.mock("@/lib/waitlist/retention-run", () => ({ runRetentionForCron: h.retention }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({}) }));
import { GET } from "@/app/api/cron/waitlist-decline-owner-email/route";
import { DeclineEmailFailedNotice } from "@/components/waitlist/decline-email-failed-notice";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "synthetic-secret";
  h.dispatch.mockResolvedValue({ sent: 2, failed: 1, cancelled: 0, skipped: 0, remaining: 7 });
  h.retention.mockResolvedValue({ ok: true, calls: 1, erasedAnswers: 3, failedAnswers: 0, remaining: 0 });
});
afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("the backstop route", () => {
  it("refuses a request without the cron secret and does nothing", async () => {
    expect((await GET(new Request("https://x.test/api/cron/waitlist-decline-owner-email"))).status).toBe(401);
    expect((await GET(new Request("https://x.test/a", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.retention).not.toHaveBeenCalled();
  });
  const authed = () => GET(new Request("https://x.test/a", { headers: { authorization: "Bearer synthetic-secret" } }));
  it("returns counts only", async () => {
    expect(await (await authed()).json()).toEqual({
      ok: true, sent: 2, failed: 1, cancelled: 0, skipped: 0, remaining: 7,
      retention: { ok: true, calls: 1, erasedAnswers: 3, failedAnswers: 0, remaining: 0 },
    });
  });
  it("calls the 0326 erase on every authorized run", async () => {
    await authed();
    expect(h.retention).toHaveBeenCalledTimes(1);
  });
  it("a sweep that throws is still surfaced, and the erase still ran", async () => {
    h.dispatch.mockRejectedValue(new Error("sweep down"));
    await expect(authed()).rejects.toThrow("sweep down");
    expect(h.retention).toHaveBeenCalledTimes(1);
  });
  it("the three earlier crons each run the shared health check with their own route path", () => {
    for (const name of ["materialize-recurring-breaks", "calendar-reconcile", "calendar-sync"]) {
      const src = read(`app/api/cron/${name}/route.ts`);
      expect(src, name).toContain("checkRetentionHealthForCron(");
      expect(src, name).toContain(`/api/cron/${name}`);
    }
  });
  it("declares a literal maxDuration equal to the constant the sweep budget was derived from, and the budget leaves room for one slow row", async () => {
    const { DECLINE_OWNER_EMAIL_ROUTE_MAX_DURATION_SECONDS, DECLINE_OWNER_EMAIL_SWEEP_BUDGET_MS } = await import("@/lib/waitlist/decline-owner-email-gate");
    expect(read("app/api/cron/waitlist-decline-owner-email/route.ts")).toContain(`export const maxDuration = ${DECLINE_OWNER_EMAIL_ROUTE_MAX_DURATION_SECONDS};`);
    expect(DECLINE_OWNER_EMAIL_ROUTE_MAX_DURATION_SECONDS).toBeLessThanOrEqual(60); // Hobby
    // worst case for one row: a 15s provider timeout, retried once under the same key
    expect(DECLINE_OWNER_EMAIL_SWEEP_BUDGET_MS + 30_000).toBeLessThan(DECLINE_OWNER_EMAIL_ROUTE_MAX_DURATION_SECONDS * 1000);
  });
  it("is scheduled in vercel.json", () => {
    const crons = JSON.parse(read("vercel.json")).crons as Array<{ path: string; schedule: string }>;
    expect(crons.filter((c) => c.path === "/api/cron/waitlist-decline-owner-email")).toHaveLength(1);
  });
  it("every cron runs at most once a day: the Vercel plan is Hobby, which rejects a sub-daily schedule and can fail the whole deploy", () => {
    const crons = JSON.parse(read("vercel.json")).crons as Array<{ path: string; schedule: string }>;
    for (const c of crons) {
      const [minute, hour, dom, month, dow] = c.schedule.trim().split(/\s+/);
      expect(`${c.path} ${c.schedule}`).toMatch(/^\S+ \d{1,2} \d{1,2} \* \* \*$/);
      expect(dom + month + dow).toBe("***");
      expect(/^\d+$/.test(minute) && /^\d+$/.test(hour)).toBe(true);
    }
  });
});

describe("what the owner sees when a send failed", () => {
  const html = (n: number) => renderToStaticMarkup(createElement(DeclineEmailFailedNotice, { failed: n }));
  it("renders nothing for zero or a bad count", () => {
    for (const n of [0, -1, Number.NaN]) expect(html(n)).toBe("");
  });
  it("renders a count and no person", () => {
    expect(html(1)).toContain("could not be delivered");
    expect(html(3)).toContain("3 emails");
  });
  it("is loaded for the owner only: after the role refusal, and through the helper, not an admin client in the page", () => {
    const src = read("app/(app)/settings/waitlist/page.tsx");
    expect(src.indexOf('practitioner.role !== "owner"')).toBeLessThan(src.indexOf("loadDeclineEmailStatus(studio.id, practitioner.user_id)"));
    expect(src).not.toContain("createAdminClient");
  });
});
