import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// DN-29: what the public limiters do when Upstash is missing or errors. The shared counter is the held 0294 function; here it is
// a mock so the RULES are table-testable (which class refuses, which is bounded, what is counted, what is logged). The real
// counter, concurrency and multiple app instances are proven separately on an isolated stack (tests/db/rate-limit-fallback...).

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({ rpc }) }));

const ENV_KEYS = [
  "VERCEL",
  "VERCEL_ENV",
  "NODE_ENV",
  "HONE_LIMITER_OUTAGE_MODE",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  ...["BOOK_VISITOR_MAX", "BOOK_VISITOR_WINDOW_MIN", "BOOK_STUDIO_MAX", "SLOTS_VISITOR_MAX", "MARKETING_EMAIL_MAX"].map((k) => `HONE_LIMITER_FALLBACK_${k}`),
];
const saved: Record<string, string | undefined> = {};
let errors: string[] = [];

function env(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = v;
  }
}
beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete (process.env as Record<string, string | undefined>)[k];
  rpc.mockReset();
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.resetModules();
  const { resetOutageAlertThrottleForTests } = await import("@/lib/rate-limit/outage");
  resetOutageAlertThrottleForTests();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = saved[k];
  }
  vi.restoreAllMocks();
});

const ok = (count = 1) => ({ data: { allowed: true, count, retry_after_seconds: 30 }, error: null });
const over = (retry = 77) => ({ data: { allowed: false, count: 99, retry_after_seconds: retry }, error: null });

describe("fallbackParam: one validated parser, never unlimited", () => {
  it.each([
    [undefined, 5],
    ["", 5],
    ["7", 7],
    [" 7 ", 7],
    ["0", 5],
    ["-3", 5],
    ["5.5", 5],
    ["1e3", 5],
    ["abc", 5],
    ["1001", 5], // above the cap for this parameter
    ["99999999999", 5],
    ["1000", 1000],
  ])("HONE_LIMITER_FALLBACK_BOOK_VISITOR_MAX=%j -> %i", async (raw, expected) => {
    const { fallbackParam } = await import("@/lib/rate-limit/outage");
    expect(fallbackParam("HONE_LIMITER_FALLBACK_BOOK_VISITOR_MAX", { HONE_LIMITER_FALLBACK_BOOK_VISITOR_MAX: raw })).toBe(expected);
  });
  it("the defaults are the DN values", async () => {
    const { fallbackParam } = await import("@/lib/rate-limit/outage");
    const e = {};
    expect(fallbackParam("HONE_LIMITER_FALLBACK_BOOK_VISITOR_MAX", e)).toBe(5);
    expect(fallbackParam("HONE_LIMITER_FALLBACK_BOOK_VISITOR_WINDOW_MIN", e)).toBe(10);
    expect(fallbackParam("HONE_LIMITER_FALLBACK_BOOK_STUDIO_MAX", e)).toBe(30);
    expect(fallbackParam("HONE_LIMITER_FALLBACK_BOOK_STUDIO_WINDOW_MIN", e)).toBe(60);
    expect(fallbackParam("HONE_LIMITER_FALLBACK_SLOTS_VISITOR_MAX", e)).toBe(60);
    expect(fallbackParam("HONE_LIMITER_FALLBACK_MARKETING_VISITOR_MAX", e)).toBe(5);
    expect(fallbackParam("HONE_LIMITER_FALLBACK_MARKETING_EMAIL_MAX", e)).toBe(3);
  });
});

describe("outageMode: production enforces regardless of the environment variable (Q-E)", () => {
  it.each([
    ["Vercel production, NODE_ENV=production, mode=open", { VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production", HONE_LIMITER_OUTAGE_MODE: "open" }],
    ["Vercel production, NODE_ENV=production, no mode", { VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production" }],
    ["VERCEL_ENV=production alone, mode=open", { VERCEL_ENV: "production", HONE_LIMITER_OUTAGE_MODE: "open" }],
    ["Vercel preview, mode=open", { VERCEL: "1", VERCEL_ENV: "preview", HONE_LIMITER_OUTAGE_MODE: "open" }],
    ["VERCEL=1 only, mode=open", { VERCEL: "1", HONE_LIMITER_OUTAGE_MODE: "open" }],
    ["vercel dev, mode=open", { VERCEL_ENV: "development", HONE_LIMITER_OUTAGE_MODE: "open" }],
  ])("ENFORCES: %s", async (_l, vars) => {
    const { outageMode } = await import("@/lib/rate-limit/outage");
    expect(outageMode(vars as NodeJS.ProcessEnv)).toBe("enforce");
  });
  it("a local or CI process keeps today's open behaviour by default, and enforces when asked", async () => {
    const { outageMode } = await import("@/lib/rate-limit/outage");
    expect(outageMode({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe("open");
    expect(outageMode({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe("open");
    expect(outageMode({ NODE_ENV: "production", HONE_LIMITER_OUTAGE_MODE: "enforce" } as NodeJS.ProcessEnv)).toBe("enforce");
  });
});

describe("onLimiterUnavailable", () => {
  const book = { kind: "book", routeClass: "public_book", reason: "error", keys: { scope: "book", visitor: "vvv", studio: "sss" } } as const;

  it("open mode (local, not hosted): allows and never touches the counter", async () => {
    const { onLimiterUnavailable } = await import("@/lib/rate-limit/outage");
    expect(await onLimiterUnavailable(book)).toEqual({ allowed: true });
    expect(rpc).not.toHaveBeenCalled();
  });

  describe("enforcing", () => {
    beforeEach(() => env({ VERCEL_ENV: "production" }));

    it("refuse class: refused with a retry, counter untouched, one alert", async () => {
      const { onLimiterUnavailable } = await import("@/lib/rate-limit/outage");
      const r = await onLimiterUnavailable({ kind: "refuse", routeClass: "cancel_submit", reason: "error", err: new Error("boom raw secret") });
      expect(r).toEqual({ allowed: false, retryAfterSeconds: 60 });
      expect(rpc).not.toHaveBeenCalled();
      expect(errors.join("\n")).toContain("ratelimit_outage_fallback");
    });

    it("class D (open) stays open even when enforcing", async () => {
      const { onLimiterUnavailable } = await import("@/lib/rate-limit/outage");
      expect(await onLimiterUnavailable({ kind: "open", routeClass: "practitioner_client_email", reason: "error" })).toEqual({ allowed: true });
      expect(rpc).not.toHaveBeenCalled();
    });

    it("book: counts BOTH buckets with the DN limits and windows (5 per 10 min per visitor, 30 per hour per studio)", async () => {
      rpc.mockResolvedValue(ok());
      const { onLimiterUnavailable } = await import("@/lib/rate-limit/outage");
      expect(await onLimiterUnavailable(book)).toEqual({ allowed: true });
      const args = rpc.mock.calls.map((c) => c[1]);
      expect(args).toContainEqual({ p_scope: "book_visitor", p_key_hash: "vvv", p_window_seconds: 600, p_limit: 5 });
      expect(args).toContainEqual({ p_scope: "book_studio", p_key_hash: "sss", p_window_seconds: 3600, p_limit: 30 });
    });

    it("book: the visitor bucket over its limit refuses AND the studio bucket is still counted (every attempt counts)", async () => {
      rpc.mockImplementation(async (_n: string, a: { p_scope: string }) => (a.p_scope === "book_visitor" ? over(120) : ok()));
      const { onLimiterUnavailable } = await import("@/lib/rate-limit/outage");
      expect(await onLimiterUnavailable(book)).toEqual({ allowed: false, retryAfterSeconds: 120 });
      expect(rpc).toHaveBeenCalledTimes(2);
    });

    it("book: the studio bucket over its limit refuses a fresh visitor", async () => {
      rpc.mockImplementation(async (_n: string, a: { p_scope: string }) => (a.p_scope === "book_studio" ? over(900) : ok()));
      const { onLimiterUnavailable } = await import("@/lib/rate-limit/outage");
      expect(await onLimiterUnavailable(book)).toEqual({ allowed: false, retryAfterSeconds: 900 });
    });

    it("slots: its own larger bound (60 per visitor per 10 minutes), not the booking bound", async () => {
      rpc.mockResolvedValue(ok());
      const { onLimiterUnavailable } = await import("@/lib/rate-limit/outage");
      await onLimiterUnavailable({ kind: "slots", routeClass: "public_slots", reason: "disabled", keys: { scope: "slots", visitor: "vvv" } });
      expect(rpc.mock.calls.map((c) => c[1])).toEqual([{ p_scope: "slots_visitor", p_key_hash: "vvv", p_window_seconds: 600, p_limit: 60 }]);
    });

    it("marketing: 5 per visitor per hour and 3 per email per day", async () => {
      rpc.mockResolvedValue(ok());
      const { onLimiterUnavailable } = await import("@/lib/rate-limit/outage");
      await onLimiterUnavailable({ kind: "marketing", routeClass: "waitlist", reason: "error", keys: { scope: "waitlist", visitor: "vvv", email: "eee" } });
      const args = rpc.mock.calls.map((c) => c[1]);
      expect(args).toContainEqual({ p_scope: "waitlist_visitor", p_key_hash: "vvv", p_window_seconds: 3600, p_limit: 5 });
      expect(args).toContainEqual({ p_scope: "waitlist_email", p_key_hash: "eee", p_window_seconds: 86400, p_limit: 3 });
    });

    it("operator overrides apply, and a malformed override falls back to the DN value", async () => {
      env({ HONE_LIMITER_FALLBACK_BOOK_VISITOR_MAX: "8", HONE_LIMITER_FALLBACK_BOOK_STUDIO_MAX: "unlimited" });
      rpc.mockResolvedValue(ok());
      const { onLimiterUnavailable } = await import("@/lib/rate-limit/outage");
      await onLimiterUnavailable(book);
      const args = rpc.mock.calls.map((c) => c[1]);
      expect(args).toContainEqual({ p_scope: "book_visitor", p_key_hash: "vvv", p_window_seconds: 600, p_limit: 8 });
      expect(args).toContainEqual({ p_scope: "book_studio", p_key_hash: "sss", p_window_seconds: 3600, p_limit: 30 });
    });

    it.each([
      ["rpc returns an error", async () => ({ data: null, error: { message: "db down" } })],
      ["rpc rejects", async () => Promise.reject(new Error("network"))],
      ["rpc answers nonsense", async () => ({ data: { allowed: "yes" }, error: null })],
      ["rpc answers null", async () => ({ data: null, error: null })],
    ])("REFUSES when the counter is unreachable: %s", async (_l, impl) => {
      rpc.mockImplementation(impl);
      const { onLimiterUnavailable } = await import("@/lib/rate-limit/outage");
      expect(await onLimiterUnavailable(book)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    });

    it("REFUSES a fallback class that lacks the keys it needs (it cannot be bounded)", async () => {
      const { onLimiterUnavailable } = await import("@/lib/rate-limit/outage");
      expect(await onLimiterUnavailable({ kind: "book", routeClass: "public_book", reason: "error", keys: { scope: "book", visitor: "vvv" } })).toEqual({ allowed: false, retryAfterSeconds: 60 });
      expect(rpc).not.toHaveBeenCalled();
    });

    it("the alert event carries no identifier, hash, slug, email or error text", async () => {
      rpc.mockResolvedValue(over());
      const { onLimiterUnavailable } = await import("@/lib/rate-limit/outage");
      await onLimiterUnavailable({ kind: "book", routeClass: "public_book", reason: "error", err: new Error("secret-text-123 victim@example.com"), keys: { scope: "book", visitor: "HASHED-VISITOR-XYZ", studio: "studio-slug-abc" } });
      const logged = errors.join("\n");
      expect(logged).toContain("ratelimit_outage_fallback");
      for (const forbidden of ["HASHED-VISITOR-XYZ", "studio-slug-abc", "secret-text-123", "victim@example.com"]) expect(logged).not.toContain(forbidden);
      const event = JSON.parse(errors.find((e) => e.includes("ratelimit_outage_fallback"))!);
      expect(Object.keys(event).sort()).toEqual(["environment", "errorClass", "event", "kind", "mode", "outcome", "reason", "routeClass", "timestamp"]);
    });
  });
});

describe("through the real limiter functions (Upstash unconfigured)", () => {
  const headers = new Headers({ "x-real-ip": "203.0.113.9" });

  it("hosted production: token routes and portal sign-in REFUSE; booking and slots use the counter; staff limiter stays open", async () => {
    env({ VERCEL_ENV: "production", NODE_ENV: "production", HONE_LIMITER_OUTAGE_MODE: "open" }); // the bypass attempt is ignored
    rpc.mockResolvedValue(ok());
    const m = await import("@/lib/rate-limit/public");
    expect(await m.limitTokenRoute({ routeClass: "cancel_submit", token: "t", headers })).toMatchObject({ allowed: false });
    expect(await m.limitPortalMagicLink({ headers, email: "a@harness.local" })).toMatchObject({ allowed: false });
    expect(await m.limitWaitlistProofRequest({ headers, studioId: "s", invitationId: "i" })).toMatchObject({ allowed: false });
    expect(rpc).not.toHaveBeenCalled();
    expect(await m.limitPublicBooking({ headers, slug: "studio", email: null })).toEqual({ allowed: true });
    expect(await m.limitPublicSlots({ headers, slug: "studio" })).toEqual({ allowed: true });
    expect(await m.limitWaitlistSubmit({ headers, email: "a@harness.local" })).toEqual({ allowed: true });
    expect(await m.limitDemoRequestSubmit({ headers, email: "a@harness.local" })).toEqual({ allowed: true });
    expect(await m.limitNewClientBookingWaitlist({ headers, studioId: "s", email: "a@harness.local" })).toEqual({ allowed: true });
    expect(rpc).toHaveBeenCalled();
    expect(await m.limitPractitionerClientEmail({ headers, action: "portal_link", practitionerId: "p", clientId: "c" } as never)).toEqual({ allowed: true });
  });

  it("hosted production: the counter down REFUSES booking, slots and the marketing forms", async () => {
    env({ VERCEL_ENV: "production" });
    rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    const m = await import("@/lib/rate-limit/public");
    expect(await m.limitPublicBooking({ headers, slug: "studio", email: null })).toMatchObject({ allowed: false });
    expect(await m.limitPublicSlots({ headers, slug: "studio" })).toMatchObject({ allowed: false });
    expect(await m.limitWaitlistSubmit({ headers, email: "a@harness.local" })).toMatchObject({ allowed: false });
    expect(await m.limitDemoRequestSubmit({ headers, email: "a@harness.local" })).toMatchObject({ allowed: false });
  });

  it("local (not hosted): everything stays open exactly as before and the counter is never called", async () => {
    const m = await import("@/lib/rate-limit/public");
    expect(await m.limitTokenRoute({ routeClass: "cancel_submit", token: "t", headers })).toEqual({ allowed: true });
    expect(await m.limitPublicBooking({ headers, slug: "studio", email: null })).toEqual({ allowed: true });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("local with HONE_LIMITER_OUTAGE_MODE=enforce: the real fallback is exercised", async () => {
    env({ HONE_LIMITER_OUTAGE_MODE: "enforce" });
    rpc.mockResolvedValue(ok());
    const m = await import("@/lib/rate-limit/public");
    expect(await m.limitTokenRoute({ routeClass: "cancel_submit", token: "t", headers })).toMatchObject({ allowed: false });
    expect(await m.limitPublicBooking({ headers, slug: "studio", email: null })).toEqual({ allowed: true });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("the counter receives only hashes: the raw IP and the slug-free visitor key never appear in the clear", async () => {
    env({ VERCEL_ENV: "production" });
    rpc.mockResolvedValue(ok());
    const m = await import("@/lib/rate-limit/public");
    await m.limitWaitlistSubmit({ headers, email: "someone@harness.local" });
    const sent = JSON.stringify(rpc.mock.calls);
    expect(sent).not.toContain("203.0.113.9");
    expect(sent).not.toContain("someone@harness.local");
  });
});
