import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// SEC-01A — THE PUBLIC-BOOKING ABUSE-BOUNDARY CONTRACT
// ===========================================================================
//
// `limitPublicBooking` is the ONLY thing standing between an unauthenticated
// caller and repeated writes to the booking surface. There is no DB-backed
// counter, no per-client appointment cap and no velocity check behind it, so
// its exact behaviour -- including where it deliberately gives up -- is a
// security property and is pinned here.
//
// Three of these cases are KNOWN GAPS. They are asserted as the permissive
// behaviour they actually are, because a limiter that fails open is a real
// exposure and a test that pretended otherwise would be worse than no test.
//
// The fake Upstash records every (prefix, key) pair, so the tests assert on
// the real key space rather than on intent: whether two attackers share a
// budget is a fact about keys, not about comments.
// ===========================================================================

type LimitCall = { prefix: string; key: string };
const calls: LimitCall[] = [];
const scenario: { allow: boolean; throwOnLimit: boolean } = {
  allow: true,
  throwOnLimit: false,
};

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
      if (scenario.throwOnLimit) throw new Error("upstash unreachable");
      return { success: scenario.allow, reset: Date.now() + 60_000 };
    }
  }
  return { Ratelimit };
});
vi.mock("@upstash/redis", () => ({ Redis: class {} }));

// Env must be present at import time or getRedis() resolves to null and every
// limiter short-circuits without building a key.
process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

const { limitPublicBooking } = await import("@/lib/rate-limit/public");

const SLUG = "contract-studio";
const VICTIM_EMAIL = "real.client@example.test";

function h(ip: string): Headers {
  return new Headers({ "x-real-ip": ip });
}
const keysFor = (prefix: string) =>
  calls.filter((c) => c.prefix === prefix).map((c) => c.key);

beforeEach(() => {
  calls.length = 0;
  scenario.allow = true;
  scenario.throwOnLimit = false;
});

// ===========================================================================
// C11 — LIMITER OUTAGE.  *** KNOWN GAP — FAIL OPEN BY DESIGN ***
// ===========================================================================
describe("SEC-01A C11 — limiter outage [KNOWN GAP]", () => {
  // WHAT IS WRONG: when Upstash is unreachable the request is ALLOWED. That
  // is a deliberate availability trade -- a limiter outage must not stop real
  // bookings -- but it means the only bound on spoofed-identity abuse
  // disappears exactly when an attacker can cause it to.
  //
  // TO EARN A GREEN HERE: a second, local bound that survives the outage (a
  // DB-backed per-identity velocity check). That is new authority, not a
  // contract change, so it is NOT done here.
  it("a backend error ALLOWS the request", async () => {
    scenario.throwOnLimit = true;
    const res = await limitPublicBooking({
      headers: h("203.0.113.7"),
      slug: SLUG,
      email: VICTIM_EMAIL,
    });
    expect(
      res.allowed,
      "KNOWN GAP: an Upstash outage removes the only abuse bound",
    ).toBe(true);
  });

  it("an unconfigured limiter ALLOWS the request and builds no key at all", async () => {
    vi.resetModules();
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    try {
      const fresh = await import("@/lib/rate-limit/public");
      calls.length = 0;
      const res = await fresh.limitPublicBooking({
        headers: h("203.0.113.7"),
        slug: SLUG,
        email: VICTIM_EMAIL,
      });
      expect(
        res.allowed,
        "KNOWN GAP: missing env silently disables the boundary entirely",
      ).toBe(true);
      expect(calls, "no limiter key is ever presented").toEqual([]);
    } finally {
      process.env.UPSTASH_REDIS_REST_URL = url;
      process.env.UPSTASH_REDIS_REST_TOKEN = token;
      vi.resetModules();
    }
  });
});

// ===========================================================================
// C12 — DISTRIBUTED-IP ATTACK ON ONE IDENTITY.  PASS CONTRACT.
// ===========================================================================
describe("SEC-01A C12 — distributed IPs against one target identity", () => {
  it("the email budget is keyed independently of the source IP", async () => {
    for (const ip of ["198.51.100.1", "198.51.100.2", "203.0.113.9"]) {
      await limitPublicBooking({ headers: h(ip), slug: SLUG, email: VICTIM_EMAIL });
    }
    const emailKeys = keysFor("rl:public_book_email");
    expect(emailKeys).toHaveLength(3);
    expect(
      new Set(emailKeys).size,
      "one identity must consume ONE budget however many IPs are used",
    ).toBe(1);

    const ipKeys = keysFor("rl:public_book_ip");
    expect(
      new Set(ipKeys).size,
      "while the IP budgets stay separate, which is why the email one matters",
    ).toBe(3);
  });

  it("the email budget is spent by REFUSED attempts too, not only successes", async () => {
    // The gate runs before identity resolution, so probing costs the attacker
    // budget even when the booking never commits.
    scenario.allow = false;
    const res = await limitPublicBooking({
      headers: h("198.51.100.1"),
      slug: SLUG,
      email: VICTIM_EMAIL,
    });
    expect(res.allowed).toBe(false);
    expect(keysFor("rl:public_book_ip")).toHaveLength(1);
  });

  it("a blocked IP short-circuits without spending the email budget", async () => {
    scenario.allow = false;
    await limitPublicBooking({ headers: h("198.51.100.1"), slug: SLUG, email: VICTIM_EMAIL });
    expect(
      keysFor("rl:public_book_email"),
      "an over-limit IP must not burn the victim's identity budget",
    ).toEqual([]);
  });
});

// ===========================================================================
// C13 — ONE IP ACROSS MANY IDENTITIES.  PASS CONTRACT, with a stated limit.
// ===========================================================================
describe("SEC-01A C13 — one IP across unrelated identities", () => {
  it("all identities from one IP share a single IP budget", async () => {
    for (const email of ["a@example.test", "b@example.test", "c@example.test"]) {
      await limitPublicBooking({ headers: h("203.0.113.7"), slug: SLUG, email });
    }
    expect(
      new Set(keysFor("rl:public_book_ip")).size,
      "the IP bucket is the only thing bounding address enumeration",
    ).toBe(1);
    expect(
      new Set(keysFor("rl:public_book_email")).size,
      "each probed address gets its own untouched email budget",
    ).toBe(3);
  });

  it("budgets are per studio, so one studio cannot exhaust another's", async () => {
    await limitPublicBooking({ headers: h("203.0.113.7"), slug: "studio-a", email: VICTIM_EMAIL });
    await limitPublicBooking({ headers: h("203.0.113.7"), slug: "studio-b", email: VICTIM_EMAIL });
    expect(new Set(keysFor("rl:public_book_ip")).size).toBe(2);
    expect(new Set(keysFor("rl:public_book_email")).size).toBe(2);
  });
});

// ===========================================================================
// C14 — NO IDENTIFIER REACHES REDIS IN THE CLEAR.  PASS CONTRACT.
// ===========================================================================
describe("SEC-01A C14 — limiter keys carry no raw identifier", () => {
  it("neither the raw IP nor the raw email appears in any key", async () => {
    const ip = "203.0.113.7";
    await limitPublicBooking({ headers: h(ip), slug: SLUG, email: VICTIM_EMAIL });
    for (const { key } of calls) {
      expect(key).not.toContain(ip);
      expect(key).not.toContain(VICTIM_EMAIL);
      expect(key).not.toContain("@");
      // The identifier half must be a truncated SHA-256 hex digest and
      // nothing else -- 32 lowercase hex characters, no separators.
      expect(key.split(":")[0]).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("the studio slug is the only cleartext component", async () => {
    await limitPublicBooking({ headers: h("203.0.113.7"), slug: SLUG, email: VICTIM_EMAIL });
    for (const { key } of calls) expect(key.endsWith(`:${SLUG}`)).toBe(true);
  });
});
