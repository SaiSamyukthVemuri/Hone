import { describe, expect, it, vi } from "vitest";
import { createReconcileContinuationStore, type ContinuationRedis } from "@/lib/google-calendar/sync/reconcile-continuation";
import { reconcileLockKey } from "@/lib/google-calendar/sync/reconcile-lock";
import type { ReconcileContinuation } from "@/lib/google-calendar/sync/reconcile";

// Phase B2.3-b §3 — the OWNERSHIP-ATOMIC continuation store. write/clear are Lua
// compare-token scripts (guarded by the per-studio lock key); read distinguishes an
// I/O error (fail-closed) from an absent record.

const CONT: ReconcileContinuation = {
  snapshotStartedAtIso: "2026-07-14T12:00:00.000Z",
  activationStartedAtIso: "2026-07-14T12:00:00.000Z",
  pass: "appointments",
  cursor: "appt-42",
};

function okRedis(over: Partial<ContinuationRedis> = {}): ContinuationRedis {
  return { get: vi.fn(async () => null), eval: vi.fn(async () => 1), ...over };
}

describe("read (fail-closed vs absent)", () => {
  it("no backend -> {ok:false}", async () => {
    expect(await createReconcileContinuationStore(null).read("s")).toEqual({ ok: false });
  });
  it("absent -> {ok:true, value:null}; valid record round-trips", async () => {
    expect(await createReconcileContinuationStore(okRedis()).read("s")).toEqual({ ok: true, value: null });
    expect(await createReconcileContinuationStore(okRedis({ get: async () => CONT })).read("s")).toEqual({ ok: true, value: CONT });
    expect(await createReconcileContinuationStore(okRedis({ get: async () => JSON.stringify(CONT) })).read("s")).toEqual({ ok: true, value: CONT });
  });
  it("schema drift / corrupt -> absent (safe); throw -> fail-closed", async () => {
    expect(await createReconcileContinuationStore(okRedis({ get: async () => ({ ...CONT, schemaVersion: 999 }) })).read("s")).toEqual({ ok: true, value: null });
    expect(await createReconcileContinuationStore(okRedis({ get: async () => { throw new Error("x"); } })).read("s")).toEqual({ ok: false });
  });
});

describe("write — token-atomic, no arbitrary expiry", () => {
  it("evals a compare-token SET guarded by the per-studio LOCK key; true when owned (eval->1)", async () => {
    const redis = okRedis();
    const store = createReconcileContinuationStore(redis);
    expect(await store.write("studio-9", "tok", CONT)).toBe(true);
    const call = (redis.eval as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("redis.call('get', KEYS[1]) == ARGV[1]"); // guards on the lock token
    expect(call[0]).not.toContain("EX"); // NO arbitrary expiry — durable correctness state
    expect(call[1]).toEqual([reconcileLockKey("studio-9"), "gcal_reconcile:cursor:studio-9"]);
    expect(call[2][0]).toBe("tok");
  });
  it("stale owner (eval->0) -> false (cannot overwrite the newer owner's record)", async () => {
    expect(await createReconcileContinuationStore(okRedis({ eval: vi.fn(async () => 0) })).write("s", "stale", CONT)).toBe(false);
  });
  it("no backend / throw -> false", async () => {
    expect(await createReconcileContinuationStore(null).write("s", "t", CONT)).toBe(false);
    expect(await createReconcileContinuationStore(okRedis({ eval: async () => { throw new Error("x"); } })).write("s", "t", CONT)).toBe(false);
  });
});

describe("clear — token-atomic", () => {
  it("evals a compare-token DEL; true when owned (eval->1), false when not (eval->0)", async () => {
    const redis = okRedis();
    expect(await createReconcileContinuationStore(redis).clear("s9", "tok")).toBe(true);
    const call = (redis.eval as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("del");
    expect(call[1]).toEqual([reconcileLockKey("s9"), "gcal_reconcile:cursor:s9"]);
    expect(await createReconcileContinuationStore(okRedis({ eval: vi.fn(async () => 0) })).clear("s", "stale")).toBe(false);
    expect(await createReconcileContinuationStore(null).clear("s", "t")).toBe(false);
  });
});
