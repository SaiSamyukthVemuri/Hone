import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// DEFECT A — THE BOOKING WAITLIST MUST NOT SHARE THE MARKETING BUCKET
// ===========================================================================
//
// The predecessor reused `limitWaitlistSubmit`, whose Redis keys carry only a
// hashed IP / hashed email and no studio or surface component. That silently
// coupled three different populations to one quota:
//
//   * the Hone marketing landing-page early-access form,
//   * studio A's booking waitlist,
//   * studio B's booking waitlist.
//
// The failure mode is a genuine new-client lead REFUSED because someone else
// spent the budget — which is exactly the demand this release exists to
// capture. These tests assert the isolation directly, at the Redis key level,
// by capturing every key the limiters actually present to Upstash.

type LimitCall = { prefix: string; key: string };
const calls: LimitCall[] = [];
const scenario = { allow: true, reset: Date.now() + 60_000 };

// Fake Upstash. Records the (prefix, key) pair for every limit() call so the
// tests can assert on the real key space rather than on intent.
vi.mock("@upstash/ratelimit", () => {
  class Ratelimit {
    prefix: string;
    constructor(opts: { prefix: string }) {
      this.prefix = opts.prefix;
    }
    static slidingWindow() {
      return {};
    }
    async limit(key: string) {
      calls.push({ prefix: this.prefix, key });
      return { success: scenario.allow, reset: scenario.reset };
    }
  }
  return { Ratelimit };
});
vi.mock("@upstash/redis", () => ({
  Redis: class {
    constructor() {}
  },
}));

// Upstash env must be present or getRedis() returns null and every limiter
// short-circuits to allowed:true without ever building a key.
process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

const { limitNewClientBookingWaitlist, limitWaitlistSubmit } = await import(
  "@/lib/rate-limit/public"
);

const STUDIO_A = "11111111-1111-4111-8111-111111111111";
const STUDIO_B = "22222222-2222-4222-8222-222222222222";
const EMAIL = "visitor@example.test";
const IP = "203.0.113.7";

function headersWithIp(ip: string): Headers {
  return new Headers({ "x-real-ip": ip });
}

beforeEach(() => {
  calls.length = 0;
  scenario.allow = true;
});
afterEach(() => vi.clearAllMocks());

describe("dedicated booking-waitlist limiter — namespace isolation", () => {
  it("uses its own Redis prefixes, never the marketing waitlist's", async () => {
    await limitNewClientBookingWaitlist({
      headers: headersWithIp(IP),
      studioId: STUDIO_A,
      email: EMAIL,
    });
    const prefixes = calls.map((c) => c.prefix);
    expect(prefixes).toEqual([
      "rl:new_client_waitlist_ip",
      "rl:new_client_waitlist_email",
    ]);
    // The marketing namespace must not appear at all.
    expect(prefixes).not.toContain("rl:waitlist_ip");
    expect(prefixes).not.toContain("rl:waitlist_email");
  });

  it("the marketing waitlist and the booking waitlist share NO (prefix, key) pair", async () => {
    // Same person, same IP, same address, both surfaces.
    await limitWaitlistSubmit({ headers: headersWithIp(IP), email: EMAIL });
    const marketing = calls.map((c) => `${c.prefix}|${c.key}`);
    calls.length = 0;
    await limitNewClientBookingWaitlist({
      headers: headersWithIp(IP),
      studioId: STUDIO_A,
      email: EMAIL,
    });
    const booking = calls.map((c) => `${c.prefix}|${c.key}`);

    expect(marketing).toHaveLength(2);
    expect(booking).toHaveLength(2);
    for (const b of booking) {
      expect(
        marketing,
        "marketing usage must never consume booking-waitlist quota",
      ).not.toContain(b);
    }
  });

  it("studio A and studio B never share a key, for the same IP and the same email", async () => {
    await limitNewClientBookingWaitlist({
      headers: headersWithIp(IP),
      studioId: STUDIO_A,
      email: EMAIL,
    });
    const a = calls.map((c) => `${c.prefix}|${c.key}`);
    calls.length = 0;
    await limitNewClientBookingWaitlist({
      headers: headersWithIp(IP),
      studioId: STUDIO_B,
      email: EMAIL,
    });
    const b = calls.map((c) => `${c.prefix}|${c.key}`);

    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    for (const key of b) {
      expect(a, "studio B must not consume studio A's budget").not.toContain(key);
    }
    // Both keys must actually name their studio.
    expect(a.every((k) => k.includes(STUDIO_A))).toBe(true);
    expect(b.every((k) => k.includes(STUDIO_B))).toBe(true);
  });

  it("the SAME studio + same IP maps to a stable key, so the IP limit really bites", async () => {
    await limitNewClientBookingWaitlist({
      headers: headersWithIp(IP),
      studioId: STUDIO_A,
      email: "one@example.test",
    });
    const first = calls.find((c) => c.prefix.endsWith("_ip"))!.key;
    calls.length = 0;
    await limitNewClientBookingWaitlist({
      headers: headersWithIp(IP),
      studioId: STUDIO_A,
      email: "different@example.test",
    });
    const second = calls.find((c) => c.prefix.endsWith("_ip"))!.key;
    expect(second).toBe(first);
  });

  it("the SAME studio + same email maps to a stable key, so the email limit really bites", async () => {
    await limitNewClientBookingWaitlist({
      headers: headersWithIp("198.51.100.1"),
      studioId: STUDIO_A,
      email: EMAIL,
    });
    const first = calls.find((c) => c.prefix.endsWith("_email"))!.key;
    calls.length = 0;
    await limitNewClientBookingWaitlist({
      headers: headersWithIp("198.51.100.99"),
      studioId: STUDIO_A,
      email: EMAIL,
    });
    const second = calls.find((c) => c.prefix.endsWith("_email"))!.key;
    expect(second).toBe(first);
  });

  it("a different email at the same studio is a different key", async () => {
    await limitNewClientBookingWaitlist({
      headers: headersWithIp(IP),
      studioId: STUDIO_A,
      email: "a@example.test",
    });
    const first = calls.find((c) => c.prefix.endsWith("_email"))!.key;
    calls.length = 0;
    await limitNewClientBookingWaitlist({
      headers: headersWithIp(IP),
      studioId: STUDIO_A,
      email: "b@example.test",
    });
    expect(calls.find((c) => c.prefix.endsWith("_email"))!.key).not.toBe(first);
  });
});

describe("dedicated booking-waitlist limiter — identifiers and refusal", () => {
  it("NEVER puts a raw IP or a raw email into a Redis key", async () => {
    await limitNewClientBookingWaitlist({
      headers: headersWithIp(IP),
      studioId: STUDIO_A,
      email: EMAIL,
    });
    for (const c of calls) {
      expect(c.key, "raw IP must not reach Redis").not.toContain(IP);
      expect(c.key, "raw email must not reach Redis").not.toContain(EMAIL);
      expect(c.key).not.toContain("visitor");
      expect(c.key).not.toContain("example.test");
      // hashed identifier + ":" + studio uuid
      expect(c.key).toMatch(/^[0-9a-f]{32}:[0-9a-f-]{36}$/);
    }
  });

  it("refuses with the shared generic message and a retry-after, leaking nothing", async () => {
    scenario.allow = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await limitNewClientBookingWaitlist({
      headers: headersWithIp(IP),
      studioId: STUDIO_A,
      email: EMAIL,
    });
    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.retryAfterSeconds).toBeGreaterThan(0);
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("new_client_waitlist");
    expect(logged, "no raw IP in logs").not.toContain(IP);
    expect(logged, "no raw email in logs").not.toContain(EMAIL);
    warn.mockRestore();
  });

  it("FAILS OPEN when the limiter backend throws — classified, not inherited", async () => {
    // Deliberate: failing closed here would drop genuine new-client leads
    // during exactly the window the studio is trying to capture them, and a
    // dropped lead is unrecoverable. Extra operational email is noisy but
    // visible and reversible via the feature flag.
    const { Ratelimit } = (await import("@upstash/ratelimit")) as unknown as {
      Ratelimit: { prototype: { limit: unknown } };
    };
    const original = Ratelimit.prototype.limit;
    Ratelimit.prototype.limit = async () => {
      throw new Error("upstash down");
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await limitNewClientBookingWaitlist({
      headers: headersWithIp(IP),
      studioId: STUDIO_A,
      email: EMAIL,
    });
    expect(result).toEqual({ allowed: true });
    Ratelimit.prototype.limit = original;
    err.mockRestore();
    warn.mockRestore();
  });
});
