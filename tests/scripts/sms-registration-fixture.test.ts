import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise only the existing spec's seed functions. No Playwright test body,
// seed connection, browser, provider or local-env guard is executed.
const h = vi.hoisted(() => ({
  used: new Set<string>(), attempts: [] as Array<unknown[]>,
  failure: null as unknown, alwaysCollide: false,
}));
vi.mock("@playwright/test", () => ({ test: { describe: vi.fn() }, expect: vi.fn() }));
vi.mock("node:crypto", async (original) => ({ ...await original<typeof import("node:crypto")>(), randomInt: () => 0 }));
vi.mock("../../e2e/helpers/local-env", () => ({ E2E_APP_ORIGIN: "https://example.invalid" }));
vi.mock("../../e2e/helpers/mail", () => ({ listMessageIds: vi.fn(), waitForMagicLink: vi.fn() }));
vi.mock("../../e2e/helpers/seed", () => ({
  seedE2eStudio: async () => ({ studioId: "synthetic-studio" }), seedOperatorAuthUser: vi.fn(),
  sql: async (query: string, params: unknown[]) => {
    if (query.includes("select id from public.practitioners")) return [{ id: "synthetic-owner" }];
    if (!query.includes("insert into public.studio_sms_senders")) throw new Error("Unexpected fixture SQL");
    h.attempts.push(params);
    if (h.failure) throw h.failure;
    const phone = String(params[1]);
    if (h.alwaysCollide || h.used.has(phone)) throw Object.assign(new Error("synthetic duplicate"), { code: "23505", constraint: "studio_sms_senders_phone_number_unique" });
    h.used.add(phone);
    return [];
  },
}));
import { addActiveUsSender, seedStudioWithActiveUsSender } from "../../e2e/sms-registration-stale-form.spec";

beforeEach(() => {
  h.used = new Set(["+12125551000", "+12125551001"]); h.attempts = []; h.failure = null; h.alwaysCollide = false;
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => { vi.restoreAllMocks(); });

describe("SMS registration fixture allocates rather than guessing a free number", () => {
  it.each(["initial", "replacement"] as const)("%s retries collisions including retained released numbers", async (kind) => {
    const phone = kind === "initial" ? (await seedStudioWithActiveUsSender()).phone : await addActiveUsSender("synthetic-studio");
    expect(phone).toBe("+12125551002");
    expect(h.attempts.map((p) => p[1])).toEqual(["+12125551000", "+12125551001", "+12125551002"]);
    expect(h.attempts.every((p) => p[0] === "synthetic-studio")).toBe(true);
    expect([...h.used]).toEqual(["+12125551000", "+12125551001", "+12125551002"]);
  });
  it.each([
    ["other unique guard", { code: "23505", constraint: "studio_sms_senders_one_live_per_studio" }],
    ["check guard", { code: "23514", constraint: "studio_sms_senders_active_readiness_check" }],
    ["connection failure", { code: "ECONNREFUSED" }],
  ])("does not retry or hide %s", async (_label, detail) => {
    h.failure = Object.assign(new Error("synthetic real failure"), detail);
    await expect(addActiveUsSender("synthetic-studio")).rejects.toBe(h.failure);
    expect(h.attempts).toHaveLength(1);
  });
  it("fails visibly within a bound if every candidate collides", async () => {
    h.alwaysCollide = true;
    await expect(addActiveUsSender("synthetic-studio")).rejects.toThrow(/fixture number.*attempts/);
    expect(h.attempts.length).toBeGreaterThan(1);
    expect(h.attempts.length).toBeLessThanOrEqual(64);
    expect(new Set(h.attempts.map((p) => p[1])).size).toBe(h.attempts.length);
  });
});
