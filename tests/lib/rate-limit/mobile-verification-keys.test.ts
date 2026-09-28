import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

// ===========================================================================
// WHAT ACTUALLY REACHES REDIS AND THE LOG
// ===========================================================================
//
// The flow-level tests prove WHICH gate runs WHEN. This file proves what the gates
// are keyed ON, by capturing the real key string handed to the limiter rather than
// reading the source and believing it.
//
// It exists because requirement 10 is not checkable any other way: with Upstash
// unconfigured the limiters are disabled and never build a key at all, so every
// other suite in this repository exercises the fail-open path and nothing else. So
// `@upstash/ratelimit` and `@upstash/redis` are mocked to make the CONFIGURED path
// reachable, and `console.warn` is captured to see what a denial actually records.

const RAW_IP = "203.0.113.77";
const CAPABILITY = "c".repeat(64);
const PHONE = "+15555550123";
const SUBMITTED_CODE = "424242";
const ENTRY_ID = "11111111-1111-4111-8111-111111111111";
const STUDIO_ID = "22222222-2222-4222-8222-222222222222";

const hashed = createHash("sha256").update(RAW_IP).digest("hex").slice(0, 32);

type Call = { prefix: string; key: string };
const calls: Call[] = [];
let allow = true;

vi.mock("@upstash/redis", () => ({
  Redis: class {
    constructor(_: unknown) {}
  },
}));

vi.mock("@upstash/ratelimit", () => {
  class Ratelimit {
    private readonly prefix: string;
    constructor(opts: { prefix: string }) {
      this.prefix = opts.prefix;
    }
    static slidingWindow(_limit: number, _window: string) {
      return { kind: "slidingWindow" };
    }
    async limit(key: string) {
      calls.push({ prefix: this.prefix, key });
      return { success: allow, reset: Date.now() + 60_000 };
    }
  }
  return { Ratelimit };
});

const SAVED: Record<string, string | undefined> = {};
let warns: string[] = [];

beforeEach(async () => {
  for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) {
    SAVED[k] = process.env[k];
  }
  process.env.UPSTASH_REDIS_REST_URL = "https://example.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token-not-real";
  calls.length = 0;
  allow = true;
  warns = [];
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    warns.push(a.map(String).join(" "));
  });
  // The module caches its Redis client and its limiters at module scope, so the env
  // has to be in place BEFORE the first import.
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

async function load() {
  return await import("@/lib/rate-limit/public");
}

const headers = () => new Headers({ "x-real-ip": RAW_IP });

describe("the pre-auth IP key is the HASHED ip and nothing else", () => {
  it("start keys on the hash alone", async () => {
    const { limitMobileVerificationIp } = await load();
    await limitMobileVerificationIp("start", { headers: headers() });
    expect(calls).toHaveLength(1);
    expect(calls[0].key, "the key is not the bare hash").toBe(hashed);
    expect(calls[0].key).not.toContain(RAW_IP);
    expect(calls[0].prefix).toBe("rl:waitlist_mobile_verification_start_ip");
  });

  it("check keys on the hash alone, in its OWN namespace", async () => {
    const { limitMobileVerificationIp } = await load();
    await limitMobileVerificationIp("check", { headers: headers() });
    expect(calls[0].key).toBe(hashed);
    expect(calls[0].prefix).toBe("rl:waitlist_mobile_verification_check_ip");
  });

  it("start and check cannot spend each other's budget", async () => {
    const { limitMobileVerificationIp } = await load();
    await limitMobileVerificationIp("start", { headers: headers() });
    await limitMobileVerificationIp("check", { headers: headers() });
    expect(calls[0].prefix).not.toBe(calls[1].prefix);
    // Same key, different namespace: the same IP, two independent budgets.
    expect(calls[0].key).toBe(calls[1].key);
  });

  it("an unknown IP degrades to one shared bucket, still hashed", async () => {
    const { limitMobileVerificationIp } = await load();
    await limitMobileVerificationIp("start", { headers: new Headers() });
    expect(calls[0].key).toBe(createHash("sha256").update("unknown_ip").digest("hex").slice(0, 32));
  });
});

describe("the per-entry key uses server-resolved ids only", () => {
  it("keys on entryId:studioId, in the entry namespace", async () => {
    const { limitMobileVerificationEntry } = await load();
    await limitMobileVerificationEntry("start", { studioId: STUDIO_ID, entryId: ENTRY_ID });
    expect(calls[0].key).toBe(`${ENTRY_ID}:${STUDIO_ID}`);
    expect(calls[0].prefix).toBe("rl:waitlist_mobile_verification_start_entry");
  });

  it("the entry gate is a different namespace from the IP gate", async () => {
    const { limitMobileVerificationEntry, limitMobileVerificationIp } = await load();
    await limitMobileVerificationIp("start", { headers: headers() });
    await limitMobileVerificationEntry("start", { studioId: STUDIO_ID, entryId: ENTRY_ID });
    expect(calls[0].prefix).not.toBe(calls[1].prefix);
  });
});

describe("NEGATIVE CONTROL: no secret reaches a key or a log line", () => {
  it("a denial logs a route class and a retry, and nothing else", async () => {
    allow = false;
    const { limitMobileVerificationIp, limitMobileVerificationEntry } = await load();
    const ip = await limitMobileVerificationIp("check", { headers: headers() });
    const entry = await limitMobileVerificationEntry("check", {
      studioId: STUDIO_ID,
      entryId: ENTRY_ID,
    });
    expect(ip.allowed).toBe(false);
    expect(entry.allowed).toBe(false);

    const everything = [...warns, ...calls.map((c) => `${c.prefix} ${c.key}`)].join("\n");
    for (const [name, secret] of [
      ["raw IP", RAW_IP],
      ["capability", CAPABILITY],
      ["phone", PHONE],
      ["submitted code", SUBMITTED_CODE],
    ] as const) {
      expect(everything, `the ${name} reached a key or a log line`).not.toContain(secret);
    }
    // Anti-vacuity: something WAS logged, so the absences above mean something.
    expect(warns.join("\n")).toContain("waitlist_mobile_verification_check");
  });

  it("neither gate can be handed a capability, a code or a phone at all", async () => {
    // The signatures are the guarantee: stage 1 takes headers, stage 2 takes two
    // ids. There is no parameter through which a secret could arrive.
    const { limitMobileVerificationIp, limitMobileVerificationEntry } = await load();
    expect(limitMobileVerificationIp.length).toBe(2); // operation, { headers }
    expect(limitMobileVerificationEntry.length).toBe(2); // operation, { studioId, entryId }
  });
});

describe("FAIL OPEN is preserved", () => {
  it("both gates allow when Upstash is not configured", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    vi.resetModules();
    const { limitMobileVerificationIp, limitMobileVerificationEntry } = await load();
    expect(await limitMobileVerificationIp("start", { headers: headers() })).toEqual({
      allowed: true,
    });
    expect(
      await limitMobileVerificationEntry("start", { studioId: STUDIO_ID, entryId: ENTRY_ID }),
    ).toEqual({ allowed: true });
    expect(calls, "an unconfigured limiter built a key").toEqual([]);
  });

  it("both gates allow when the backend throws", async () => {
    const { limitMobileVerificationIp, limitMobileVerificationEntry } = await load();
    // Force the limiter to throw on the next call.
    const mod = await import("@upstash/ratelimit");
    const proto = (mod.Ratelimit as unknown as { prototype: { limit: unknown } }).prototype;
    const original = proto.limit;
    proto.limit = async () => {
      throw new Error("upstash down");
    };
    expect(await limitMobileVerificationIp("start", { headers: headers() })).toEqual({
      allowed: true,
    });
    expect(
      await limitMobileVerificationEntry("start", { studioId: STUDIO_ID, entryId: ENTRY_ID }),
    ).toEqual({ allowed: true });
    proto.limit = original;
  });
});
