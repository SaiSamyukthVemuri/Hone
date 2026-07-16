import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Google Calendar — Phase B2.3-c2: the worker heartbeat (§16). Fail-open,
// PHI-free, its own key/type (distinct from the reconciliation heartbeat).

const h = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  setCalls: [] as Array<{ key: string; value: unknown; opts: { ex: number } }>,
  throwOnSet: false,
}));

vi.mock("@upstash/redis", () => ({
  Redis: class {
    async set(key: string, value: unknown, opts: { ex: number }) {
      if (h.throwOnSet) throw new Error("redis-down");
      h.setCalls.push({ key, value, opts });
      h.store.set(key, value);
      return "OK";
    }
    async get(key: string) {
      return h.store.get(key) ?? null;
    }
  },
}));

import { recordWorkerRun, readWorkerHeartbeat, type WorkerHeartbeat } from "@/lib/google-calendar/sync/worker-heartbeat";

const ALLOWED_KEYS = new Set([
  "at",
  "started_at",
  "duration_ms",
  "outcome",
  "no_work",
  "claimed",
  "handled",
  "recorded_done",
  "recorded_pending",
  "recorded_dead",
  "record_idempotent",
  "record_rejected",
  "record_errors",
  "unstarted_claimed",
  "timed_out",
  "error_class",
  "by_code",
]);

const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
const savedTok = process.env.UPSTASH_REDIS_REST_TOKEN;
beforeEach(() => {
  h.store.clear();
  h.setCalls.length = 0;
  h.throwOnSet = false;
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
});
afterEach(() => {
  if (savedUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = savedUrl;
  if (savedTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = savedTok;
});

const HB: WorkerHeartbeat = {
  at: new Date(1_000_000).toISOString(),
  started_at: new Date(999_000).toISOString(),
  duration_ms: 1000,
  outcome: "ok",
  no_work: true,
  claimed: 0,
  handled: 0,
  recorded_done: 0,
  by_code: {},
};

describe("worker heartbeat", () => {
  it("writes to the dedicated gcal_worker:last_run key with a bounded TTL", async () => {
    await recordWorkerRun(HB);
    expect(h.setCalls).toHaveLength(1);
    expect(h.setCalls[0].key).toBe("gcal_worker:last_run");
    expect(h.setCalls[0].opts.ex).toBeGreaterThan(0);
  });

  it("stores ONLY PHI-free aggregate keys", async () => {
    await recordWorkerRun({ ...HB, claimed: 3, handled: 3, recorded_done: 2, record_rejected: 1, timed_out: false, error_class: null, by_code: { ok: 2, retry_transient: 1 } });
    const value = h.setCalls[0].value as Record<string, unknown>;
    for (const k of Object.keys(value)) {
      expect(ALLOWED_KEYS.has(k)).toBe(true);
    }
  });

  it("round-trips through read", async () => {
    await recordWorkerRun(HB);
    const back = await readWorkerHeartbeat();
    expect(back).toMatchObject({ outcome: "ok", no_work: true });
  });

  it("fail-open: a Redis set failure never throws", async () => {
    h.throwOnSet = true;
    await expect(recordWorkerRun(HB)).resolves.toBeUndefined();
  });

  it("unconfigured Upstash: write is a silent no-op, read is null", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    await expect(recordWorkerRun(HB)).resolves.toBeUndefined();
    expect(await readWorkerHeartbeat()).toBeNull();
  });
});
