import { describe, expect, it, vi } from "vitest";
import { createReconcileLock, type LockRedis } from "@/lib/google-calendar/sync/reconcile-lock";

// Phase B2.3-b — the per-studio reconciliation lock. The critical property is
// FAIL-CLOSED: with no backend (or a throwing one) acquire must report
// 'unavailable' so the caller never sweeps unlocked. Release/renew are
// ownership-token guarded (compare-token).

function okRedis(over: Partial<LockRedis> = {}): LockRedis {
  return {
    set: vi.fn(async () => "OK"),
    eval: vi.fn(async () => 1),
    ...over,
  };
}

describe("acquire", () => {
  it("SET NX OK -> acquired with the injected token", async () => {
    const redis = okRedis();
    const lock = createReconcileLock(redis, { newToken: () => "tok-1", ttlSeconds: 90 });
    const r = await lock.acquire("studio-1");
    expect(r).toEqual({ ok: true, token: "tok-1" });
    expect(redis.set).toHaveBeenCalledWith("gcal_reconcile:lock:studio-1", "tok-1", { nx: true, ex: 90 });
  });

  it("SET returns null (already held) -> reason 'held'", async () => {
    const lock = createReconcileLock(okRedis({ set: vi.fn(async () => null) }));
    expect(await lock.acquire("s")).toEqual({ ok: false, reason: "held" });
  });

  it("no backend configured -> FAIL-CLOSED ('unavailable'), not free-to-proceed", async () => {
    const lock = createReconcileLock(null);
    expect(await lock.acquire("s")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("backend throws on acquire -> FAIL-CLOSED ('unavailable')", async () => {
    const lock = createReconcileLock(okRedis({ set: vi.fn(async () => { throw new Error("boom"); }) }));
    expect(await lock.acquire("s")).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("release (compare-token DELETE)", () => {
  it("evals the compare-and-delete with the exact key + token", async () => {
    const redis = okRedis();
    const lock = createReconcileLock(redis);
    await lock.release("studio-9", "tok-x");
    const call = (redis.eval as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("redis.call('get', KEYS[1]) == ARGV[1]");
    expect(call[0]).toContain("del");
    expect(call[1]).toEqual(["gcal_reconcile:lock:studio-9"]);
    expect(call[2]).toEqual(["tok-x"]);
  });

  it("swallows a release error (TTL still expires the lease)", async () => {
    const lock = createReconcileLock(okRedis({ eval: vi.fn(async () => { throw new Error("x"); }) }));
    await expect(lock.release("s", "t")).resolves.toBeUndefined();
  });

  it("no backend -> no-op", async () => {
    const lock = createReconcileLock(null);
    await expect(lock.release("s", "t")).resolves.toBeUndefined();
  });
});

describe("renew (compare-token PEXPIRE)", () => {
  it("returns true when still owned (pexpire -> 1)", async () => {
    const redis = okRedis({ eval: vi.fn(async () => 1) });
    const lock = createReconcileLock(redis, { ttlSeconds: 100 });
    expect(await lock.renew!("s", "t")).toBe(true);
    const call = (redis.eval as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("pexpire");
    expect(call[2]).toEqual(["t", 100000]); // ttl ms
  });

  it("returns false when ownership lost (pexpire -> 0)", async () => {
    const lock = createReconcileLock(okRedis({ eval: vi.fn(async () => 0) }));
    expect(await lock.renew!("s", "t")).toBe(false);
  });

  it("no backend or throw -> false (caller stops paging, fail-closed)", async () => {
    expect(await createReconcileLock(null).renew!("s", "t")).toBe(false);
    const lock = createReconcileLock(okRedis({ eval: vi.fn(async () => { throw new Error("x"); }) }));
    expect(await lock.renew!("s", "t")).toBe(false);
  });
});
