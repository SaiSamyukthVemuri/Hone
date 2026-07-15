import { describe, expect, it, vi } from "vitest";
import { createReconcileContinuationStore, type ContinuationRedis } from "@/lib/google-calendar/sync/reconcile-continuation";
import type { ReconcileContinuation } from "@/lib/google-calendar/sync/reconcile";

// Phase B2.3-b — the durable continuation store. The critical properties:
//   * read() distinguishes {ok:false} (I/O error -> fail-closed) from {value:null}
//     (absent -> start fresh);
//   * a missing backend is fail-closed on read (cannot know position);
//   * write/clear round-trip a valid record; a corrupt record reads as absent.

const CONT: ReconcileContinuation = {
  snapshotStartedAtIso: "2026-07-14T12:00:00.000Z",
  activationStartedAtIso: "2026-07-14T12:00:00.000Z",
  pass: "appointments",
  cursor: "appt-42",
};

function okRedis(over: Partial<ContinuationRedis> = {}): ContinuationRedis {
  return { get: vi.fn(async () => null), set: vi.fn(async () => "OK"), del: vi.fn(async () => 1), ...over };
}

describe("read", () => {
  it("no backend -> FAIL-CLOSED ({ok:false})", async () => {
    expect(await createReconcileContinuationStore(null).read("s")).toEqual({ ok: false });
  });
  it("absent key -> {ok:true, value:null} (start fresh)", async () => {
    expect(await createReconcileContinuationStore(okRedis()).read("s")).toEqual({ ok: true, value: null });
  });
  it("valid record round-trips (object or JSON string)", async () => {
    const asObj = createReconcileContinuationStore(okRedis({ get: async () => CONT }));
    expect(await asObj.read("s")).toEqual({ ok: true, value: CONT });
    const asStr = createReconcileContinuationStore(okRedis({ get: async () => JSON.stringify(CONT) }));
    expect(await asStr.read("s")).toEqual({ ok: true, value: CONT });
  });
  it("corrupt record -> treated as absent (safe, not fail-closed)", async () => {
    const store = createReconcileContinuationStore(okRedis({ get: async () => ({ pass: "nope" }) }));
    expect(await store.read("s")).toEqual({ ok: true, value: null });
  });
  it("backend throws -> FAIL-CLOSED", async () => {
    const store = createReconcileContinuationStore(okRedis({ get: async () => { throw new Error("boom"); } }));
    expect(await store.read("s")).toEqual({ ok: false });
  });
});

describe("write / clear", () => {
  it("write persists with a TTL + returns true; failure -> false", async () => {
    const redis = okRedis();
    const store = createReconcileContinuationStore(redis);
    expect(await store.write("studio-9", CONT)).toBe(true);
    const call = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("gcal_reconcile:cursor:studio-9");
    expect(call[2]).toMatchObject({ ex: expect.any(Number) });
    const failing = createReconcileContinuationStore(okRedis({ set: async () => { throw new Error("x"); } }));
    expect(await failing.write("s", CONT)).toBe(false);
  });
  it("clear deletes the key; no backend -> false", async () => {
    const redis = okRedis();
    expect(await createReconcileContinuationStore(redis).clear("s")).toBe(true);
    expect(redis.del).toHaveBeenCalledWith("gcal_reconcile:cursor:s");
    expect(await createReconcileContinuationStore(null).clear("s")).toBe(false);
  });
});
