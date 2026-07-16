import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRefreshCoordinator,
  createUpstashRefreshCoordinator,
  GCAL_REFRESH_LOCK_TTL_SECONDS,
  refreshLockKey,
  RefreshLockUnavailableError,
  type RefreshLockRedis,
} from "@/lib/google-calendar/sync/upstash-refresh-coordinator";
import { WORKER_ROUTE_BUDGET_MS } from "@/lib/google-calendar/sync/worker-runtime";

// Google Calendar — Phase B2.3-c2: the Upstash per-connection token-refresh mutex.
// Addendum §6 — the ten required direct tests. No real Redis, no real Google.

type SetCall = { key: string; value: string; opts: { nx: true; ex: number } };

// A fake Redis modelling exactly the two commands the coordinator uses:
//   * SET key value NX EX ttl  -> "OK" if the key is absent, else null (held)
//   * EVAL <compare-and-delete> -> delete key ONLY when it still holds our token
function makeFakeRedis() {
  const store = new Map<string, string>();
  const setCalls: SetCall[] = [];
  const redis: RefreshLockRedis = {
    async set(key, value, opts) {
      setCalls.push({ key, value, opts });
      if (store.has(key)) return null; // NX: already held
      store.set(key, value);
      return "OK";
    },
    async eval(_script, keys, args) {
      // compare-and-delete: del only when the stored value equals our token
      const key = keys[0];
      const token = String(args[0]);
      if (store.get(key) === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    },
  };
  return { redis, store, setCalls };
}

describe("upstash refresh coordinator", () => {
  it("1. successful acquire: callback runs exactly once and the ownership token is released", async () => {
    const { redis, store, setCalls } = makeFakeRedis();
    const coord = createRefreshCoordinator(redis, { newToken: () => "tok-A" });
    const fn = vi.fn(async () => "result-value");

    const out = await coord.runExclusive("conn-1", fn);

    expect(out).toBe("result-value");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].key).toBe(refreshLockKey("conn-1"));
    expect(setCalls[0].value).toBe("tok-A");
    expect(setCalls[0].opts).toEqual({ nx: true, ex: GCAL_REFRESH_LOCK_TTL_SECONDS });
    // Released: the key no longer exists after the critical section.
    expect(store.has(refreshLockKey("conn-1"))).toBe(false);
  });

  it("2. same connection concurrently: exactly one acquires + runs; the other fails closed with no overlap", async () => {
    const { redis } = makeFakeRedis();
    let tokenSeq = 0;
    const coord = createRefreshCoordinator(redis, { newToken: () => `tok-${++tokenSeq}` });

    let running = 0;
    let maxConcurrent = 0;
    const ranFor: string[] = [];
    let releaseFirst!: () => void;
    const firstHold = new Promise<void>((res) => (releaseFirst = res));

    const mk = (label: string, hold: Promise<void> | null) =>
      coord
        .runExclusive("conn-shared", async () => {
          running += 1;
          maxConcurrent = Math.max(maxConcurrent, running);
          ranFor.push(label);
          if (hold) await hold;
          running -= 1;
          return label;
        })
        .then((v) => ({ ok: true as const, v }))
        .catch((e) => ({ ok: false as const, e }));

    const p1 = mk("first", firstHold);
    const p2 = mk("second", null); // should see the lock held -> throw immediately
    const r2 = await p2;
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.e).toBeInstanceOf(RefreshLockUnavailableError);
    releaseFirst();
    const r1 = await p1;
    expect(r1.ok).toBe(true);

    expect(ranFor).toEqual(["first"]); // only the owner's callback ran
    expect(maxConcurrent).toBe(1); // never two refresh callbacks at once
  });

  it("3. different connections: both may proceed independently (keys do not conflict)", async () => {
    const { redis, setCalls } = makeFakeRedis();
    const coord = createRefreshCoordinator(redis, { newToken: () => "t" });
    const a = vi.fn(async () => "a");
    const b = vi.fn(async () => "b");

    const [ra, rb] = await Promise.all([coord.runExclusive("conn-A", a), coord.runExclusive("conn-B", b)]);

    expect(ra).toBe("a");
    expect(rb).toBe("b");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    const keys = setCalls.map((c) => c.key).sort();
    expect(keys).toEqual([refreshLockKey("conn-A"), refreshLockKey("conn-B")]);
  });

  it("4. redis unavailable (no backend): callback never runs; safe typed throw with no secret", async () => {
    const coord = createRefreshCoordinator(null);
    const fn = vi.fn(async () => "x");
    let caught: unknown;
    try {
      await coord.runExclusive("conn-1", fn);
    } catch (e) {
      caught = e;
    }
    expect(fn).not.toHaveBeenCalled();
    expect(caught).toBeInstanceOf(RefreshLockUnavailableError);
    // No connection id / secret / token in the error message.
    expect(String((caught as Error).message)).not.toMatch(/conn-1/);
    expect(String((caught as Error).message)).toMatch(/refresh lock (unavailable|held)/);
  });

  it("5. redis SET throws: callback never runs; fail closed", async () => {
    const redis: RefreshLockRedis = {
      async set() {
        throw new Error("boom-redis-internal");
      },
      async eval() {
        return 0;
      },
    };
    const coord = createRefreshCoordinator(redis);
    const fn = vi.fn(async () => "x");
    let caught: unknown;
    try {
      await coord.runExclusive("conn-1", fn);
    } catch (e) {
      caught = e;
    }
    expect(fn).not.toHaveBeenCalled();
    expect(caught).toBeInstanceOf(RefreshLockUnavailableError);
    // The raw redis error message is not surfaced.
    expect(String((caught as Error).message)).not.toMatch(/boom-redis-internal/);
  });

  it("6. ownership-safe release: an expired/stale owner cannot delete a successor's lock", async () => {
    const { redis, store } = makeFakeRedis();
    const coord = createRefreshCoordinator(redis, { newToken: () => "owner-token" });
    const key = refreshLockKey("conn-1");

    await coord.runExclusive("conn-1", async () => {
      // Simulate the lease expiring and a SUCCESSOR acquiring the same key.
      store.set(key, "successor-token");
    });

    // The stale owner's release (compare-and-delete on 'owner-token') must NOT
    // have deleted the successor's lock.
    expect(store.get(key)).toBe("successor-token");
  });

  it("7. release throws: the completed callback result is not corrupted (TTL remains recovery)", async () => {
    const redis: RefreshLockRedis = {
      async set() {
        return "OK";
      },
      async eval() {
        throw new Error("release-failed");
      },
    };
    const coord = createRefreshCoordinator(redis);
    const out = await coord.runExclusive("conn-1", async () => "callback-result");
    expect(out).toBe("callback-result");
  });

  it("8. TTL is fixed, not caller-controlled, and exceeds the worker route budget", async () => {
    const { redis, setCalls } = makeFakeRedis();
    const coord = createRefreshCoordinator(redis);
    // runExclusive has no TTL parameter — the caller cannot influence it.
    await coord.runExclusive("conn-1", async () => 0);
    expect(setCalls[0].opts.ex).toBe(GCAL_REFRESH_LOCK_TTL_SECONDS);
    expect(GCAL_REFRESH_LOCK_TTL_SECONDS * 1000).toBeGreaterThan(WORKER_ROUTE_BUDGET_MS);
  });

  it("9. privacy: only the random ownership token is stored; no access/refresh token is placed in Redis", async () => {
    const { redis, setCalls } = makeFakeRedis();
    const coord = createRefreshCoordinator(redis); // real randomUUID token
    await coord.runExclusive("conn-1", async () => "ACCESS_TOKEN_SECRET_VALUE");
    // The stored value is a UUID-shaped random token, never the callback's secret.
    expect(setCalls[0].value).toMatch(/^[0-9a-f-]{36}$/i);
    expect(setCalls[0].value).not.toMatch(/ACCESS_TOKEN_SECRET_VALUE/);
    // The key carries only the connection id namespace; no token material.
    expect(setCalls[0].key).toBe("gcal_refresh:lock:conn-1");
  });

  describe("10. production factory fails closed and never uses in-process/pg", () => {
    const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
    const savedTok = process.env.UPSTASH_REDIS_REST_TOKEN;
    afterEach(() => {
      if (savedUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = savedUrl;
      if (savedTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = savedTok;
    });

    it("createUpstashRefreshCoordinator() fails closed when Upstash config is absent", async () => {
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      const coord = createUpstashRefreshCoordinator();
      const fn = vi.fn(async () => "x");
      await expect(coord.runExclusive("conn-1", fn)).rejects.toBeInstanceOf(RefreshLockUnavailableError);
      expect(fn).not.toHaveBeenCalled(); // NOT inProcessOnly (which would run fn)
    });
  });
});
