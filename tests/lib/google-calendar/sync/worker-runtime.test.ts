import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaimShapeError,
  createProductionWorkerRuntime,
  drainCalendarSyncQueue,
  toClaimedJob,
  WORKER_BATCH_SIZE,
  WORKER_MAX_BATCHES,
  WORKER_MAX_CLAIMED,
  type RecordPort,
  type WorkerRoutePorts,
} from "@/lib/google-calendar/sync/worker-runtime";
import { createAccessTokenCache } from "@/lib/google-calendar/sync/access-token-cache";
import type { ClaimedJob } from "@/lib/google-calendar/sync/job-result";
import type { ConnectionStore, TokenCrypto } from "@/lib/google-calendar/sync/token-manager";

// Google Calendar — Phase B2.3-c2: the bounded drain accounting (§10) + the
// production runtime composition (§12/§22-amended). No Supabase, no Redis, no Google.

function job(id: string, over: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id,
    studioId: "s",
    connectionId: "c",
    opType: "event.create",
    honeEntityType: "appointment",
    honeEntityId: `e-${id}`,
    payload: {},
    idempotencyKey: `k-${id}`,
    attempts: 1,
    maxAttempts: 5,
    claimToken: `tok-${id}`,
    leaseExpiresAt: new Date(0).toISOString(),
    priority: 100,
    ...over,
  };
}

const NO_DEADLINE = { startedAt: 0, deadlineMs: 1e12, now: () => 0 };

describe("drainCalendarSyncQueue — bounded accounting", () => {
  it("no work: ok + no_work, nothing handled or recorded", async () => {
    const handle = vi.fn(async () => ({ code: "ok" as const }));
    const record = vi.fn<RecordPort>(async () => "done");
    const claim = vi.fn(async () => [] as ClaimedJob[]);
    const r = await drainCalendarSyncQueue({ claim, handle, record }, NO_DEADLINE);
    expect(r.outcome).toBe("ok");
    expect(r.no_work).toBe(true);
    expect(r.claimed).toBe(0);
    expect(handle).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledWith(WORKER_BATCH_SIZE);
  });

  it("one successful job: claim once (bounded batch), handle once, record once with the EXACT claim token; counts durable done", async () => {
    const j = job("1");
    const claim = vi.fn(async () => [j]);
    const handle = vi.fn(async () => ({ code: "ok" as const }));
    const record = vi.fn<RecordPort>(async () => "done");
    const r = await drainCalendarSyncQueue({ claim, handle, record }, NO_DEADLINE);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith(WORKER_BATCH_SIZE);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({ id: "1", claimToken: "tok-1", ok: true });
    expect(r.recorded_done).toBe(1);
    expect(r.handler_success_results).toBe(1);
    expect(r.outcome).toBe("ok");
    expect(r.by_code).toEqual({ ok: 1 });
  });

  it("retry result: record receives a BOUNDED retry delay; durable pending is counted", async () => {
    const claim = vi.fn(async () => [job("1")]);
    const handle = vi.fn(async () => ({ code: "retry_transient" as const, errorCode: "x" }));
    const record = vi.fn<RecordPort>(async () => "pending");
    const r = await drainCalendarSyncQueue({ claim, handle, record }, NO_DEADLINE);
    const params = record.mock.calls[0][0];
    expect(params.ok).toBe(false);
    expect(params.retryAfterSeconds).not.toBeNull();
    expect(params.retryAfterSeconds!).toBeGreaterThanOrEqual(5);
    expect(params.retryAfterSeconds!).toBeLessThanOrEqual(21600);
    expect(r.recorded_pending).toBe(1);
    expect(r.handler_retry_results).toBe(1);
    expect(r.outcome).toBe("ok"); // a normal retry is healthy
  });

  it("terminal handler result is DISTINCT from a durable dead row (only the RPC deads it)", async () => {
    const claim = vi.fn(async () => [job("1")]);
    const handle = vi.fn(async () => ({ code: "terminal_dead" as const, errorCode: "exhausted" }));
    // The RPC returns the row to pending (attempts < max) despite the terminal handler code.
    const record = vi.fn<RecordPort>(async () => "pending");
    const r = await drainCalendarSyncQueue({ claim, handle, record }, NO_DEADLINE);
    expect(r.handler_terminal_results).toBe(1);
    expect(r.recorded_dead).toBe(0); // NOT durably dead
    expect(r.recorded_pending).toBe(1);
  });

  it("durable dead is counted only when the RPC confirms 'dead'", async () => {
    const claim = vi.fn(async () => [job("1")]);
    const handle = vi.fn(async () => ({ code: "terminal_conflict" as const }));
    const record = vi.fn<RecordPort>(async () => "dead");
    const r = await drainCalendarSyncQueue({ claim, handle, record }, NO_DEADLINE);
    expect(r.recorded_dead).toBe(1);
    expect(r.handler_terminal_results).toBe(1);
  });

  it("record rejection (stale_token): truthful, degraded, NOT counted as done, provider op not re-run", async () => {
    const claim = vi.fn(async () => [job("1")]);
    const handle = vi.fn(async () => ({ code: "ok" as const }));
    const record = vi.fn<RecordPort>(async () => "stale_token");
    const r = await drainCalendarSyncQueue({ claim, handle, record }, NO_DEADLINE);
    expect(r.record_rejected).toBe(1);
    expect(r.recorded_done).toBe(0);
    expect(r.outcome).toBe("degraded");
    expect(handle).toHaveBeenCalledTimes(1); // not re-invoked
  });

  it("record idempotent (already_done/already_dead) is counted separately and stays healthy", async () => {
    const claim = vi.fn(async () => [job("1"), job("2")]);
    const handle = vi.fn(async () => ({ code: "ok" as const }));
    const record = vi
      .fn<RecordPort>()
      .mockResolvedValueOnce("already_done")
      .mockResolvedValueOnce("already_dead");
    const r = await drainCalendarSyncQueue({ claim, handle, record }, NO_DEADLINE);
    expect(r.record_idempotent).toBe(2);
    expect(r.recorded_done).toBe(0);
    expect(r.outcome).toBe("ok");
  });

  it("record transport failure: stops the run, no further job handled, error outcome", async () => {
    const claim = vi.fn(async () => [job("1"), job("2")]);
    const handle = vi.fn(async () => ({ code: "ok" as const }));
    const record = vi.fn<RecordPort>(async () => {
      throw new Error("record_rpc_error");
    });
    const r = await drainCalendarSyncQueue({ claim, handle, record }, NO_DEADLINE);
    expect(r.record_errors).toBe(1);
    expect(r.outcome).toBe("error");
    expect(handle).toHaveBeenCalledTimes(1); // job 2 never handled
    expect(r.unstarted_claimed).toBe(1);
  });

  it("unknown record status is ambiguous -> stops with error", async () => {
    const claim = vi.fn(async () => [job("1")]);
    const handle = vi.fn(async () => ({ code: "ok" as const }));
    const record = vi.fn<RecordPort>(async () => "who_knows");
    const r = await drainCalendarSyncQueue({ claim, handle, record }, NO_DEADLINE);
    expect(r.record_errors).toBe(1);
    expect(r.outcome).toBe("error");
    expect(r.error_class).toBe("record_unknown_status");
  });

  it("handler throw: stops the run, not converted to success, error outcome, record never called", async () => {
    const claim = vi.fn(async () => [job("1"), job("2")]);
    const handle = vi.fn(async () => {
      throw new Error("BoomHandler");
    });
    const record = vi.fn<RecordPort>(async () => "done");
    const r = await drainCalendarSyncQueue({ claim, handle, record }, NO_DEADLINE);
    expect(r.outcome).toBe("error");
    expect(r.handled).toBe(0);
    expect(record).not.toHaveBeenCalled();
    expect(r.unstarted_claimed).toBe(2);
  });

  it("claim failure: error outcome, handler never called, no second claim", async () => {
    const claim = vi.fn(async () => {
      throw new Error("claim_rpc_error");
    });
    const handle = vi.fn(async () => ({ code: "ok" as const }));
    const record = vi.fn<RecordPort>(async () => "done");
    const r = await drainCalendarSyncQueue({ claim, handle, record }, NO_DEADLINE);
    expect(r.outcome).toBe("error");
    expect(handle).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("deadline reached mid-batch: stops starting jobs, counts unstarted, does not claim again or clear claims", async () => {
    let t = 0;
    const deadlineMs = 100;
    const jobs = [job("1"), job("2"), job("3")];
    const claim = vi.fn(async () => jobs);
    const handle = vi.fn(async () => ({ code: "ok" as const }));
    // Advance the clock past the deadline right after the first record.
    const record = vi.fn<RecordPort>(async () => {
      t = deadlineMs + 1;
      return "done";
    });
    const r = await drainCalendarSyncQueue({ claim, handle, record }, { startedAt: 0, deadlineMs, now: () => t });
    expect(r.timed_out).toBe(true);
    expect(r.handled).toBe(1);
    expect(r.unstarted_claimed).toBe(2); // jobs 2 & 3 left to lease-expiry
    expect(claim).toHaveBeenCalledTimes(1); // no new batch after the deadline
    expect(record).toHaveBeenCalledTimes(1); // unstarted rows never recorded/cleared
    expect(r.outcome).toBe("degraded");
  });

  it("deadline at a batch boundary: does not claim a new batch", async () => {
    let t = 0;
    const deadlineMs = 100;
    const full = Array.from({ length: WORKER_BATCH_SIZE }, (_, i) => job(`b${i}`));
    const claim = vi.fn(async () => full);
    const handle = vi.fn(async () => ({ code: "ok" as const }));
    let recorded = 0;
    const record = vi.fn<RecordPort>(async () => {
      recorded += 1;
      if (recorded === WORKER_BATCH_SIZE) t = deadlineMs + 1; // last of batch 1 trips the clock
      return "done";
    });
    const r = await drainCalendarSyncQueue({ claim, handle, record }, { startedAt: 0, deadlineMs, now: () => t });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(r.handled).toBe(WORKER_BATCH_SIZE);
    expect(r.timed_out).toBe(true);
  });

  it("bounded: at most WORKER_MAX_BATCHES claims and WORKER_MAX_CLAIMED jobs", async () => {
    const full = Array.from({ length: WORKER_BATCH_SIZE }, (_, i) => job(`f${i}`));
    const claim = vi.fn(async () => full); // always a full batch (queue never drains)
    const handle = vi.fn(async () => ({ code: "ok" as const }));
    const record = vi.fn<RecordPort>(async () => "done");
    const r = await drainCalendarSyncQueue({ claim, handle, record }, NO_DEADLINE);
    expect(claim).toHaveBeenCalledTimes(WORKER_MAX_BATCHES);
    expect(r.handled).toBe(WORKER_MAX_CLAIMED);
    expect(r.claimed).toBe(WORKER_MAX_CLAIMED);
    expect(r.batches).toBe(WORKER_MAX_BATCHES);
  });

  it("a partial batch ends the drain (queue drained)", async () => {
    const claim = vi
      .fn<WorkerRoutePorts["claim"]>()
      .mockResolvedValueOnce(Array.from({ length: WORKER_BATCH_SIZE }, (_, i) => job(`a${i}`)))
      .mockResolvedValueOnce([job("b0"), job("b1")]); // partial -> stop
    const handle = vi.fn(async () => ({ code: "ok" as const }));
    const record = vi.fn<RecordPort>(async () => "done");
    const r = await drainCalendarSyncQueue({ claim, handle, record }, NO_DEADLINE);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(r.handled).toBe(WORKER_BATCH_SIZE + 2);
    expect(r.batches).toBe(2);
  });
});

describe("createProductionWorkerRuntime — composition (§12/§22)", () => {
  const eligibleConn: ConnectionStore = {
    async loadConnection(id, s) {
      return {
        id,
        studioId: s,
        practitionerId: "p",
        connectionStatus: "connected",
        grantedScopes: [],
        writeCalendarId: "cal",
        isStudioCalendarOwner: true,
        tokenExpiresAt: null,
        destinationMode: "dedicated_app_created",
      };
    },
    loadRefreshCiphertext: async () => null,
    storeRotatedToken: async () => {},
    touchTokenExpiry: async () => {},
    markReconnectRequired: async () => {},
  };
  const failCrypto: TokenCrypto = {
    encrypt: () => ({ ok: false, reason: "x" }),
    decrypt: () => ({ ok: false, reason: "x" }),
  };
  const fakeAdmin = { rpc: vi.fn(async () => ({ data: null, error: null })) };
  const passThroughCoord = { runExclusive: async <T>(_c: string, fn: () => Promise<T>) => fn() };

  const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
  const savedTok = process.env.UPSTASH_REDIS_REST_TOKEN;
  afterEach(() => {
    if (savedUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = savedUrl;
    if (savedTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = savedTok;
    vi.restoreAllMocks();
  });

  function runtimeWith(over: Record<string, unknown> = {}) {
    return createProductionWorkerRuntime({
      admin: fakeAdmin as never,
      connectionStore: eligibleConn,
      restClient: {} as never,
      opsStore: {} as never,
      crypto: failCrypto,
      isStudioOutboundEnabled: async () => true,
      claim: async () => [],
      record: async () => "done",
      coordinator: passThroughCoord,
      ...over,
    });
  }

  it("ONE shared access-token cache backs both the token manager and the c1 invalidator", async () => {
    const cache = createAccessTokenCache();
    const clears: string[] = [];
    const realClear = cache.clear.bind(cache);
    cache.clear = (id: string) => {
      clears.push(id);
      realClear(id);
    };
    const rt = runtimeWith({ cache });

    // (a) same object wired in.
    expect(rt.wiring.cache).toBe(cache);
    // (b) the c1 mandatory invalidator clears THIS cache.
    rt.wiring.invalidateAccessToken("conn-9");
    expect(clears).toContain("conn-9");
    // (c) the token manager READS this same cache (a seeded token is returned).
    cache.set("conn-7", "SHARED-TOKEN", Date.now() + 600_000);
    const t = await rt.wiring.tokenManager.ensureAccessToken("conn-7", "studio-1");
    expect(t.ok && t.accessToken).toBe("SHARED-TOKEN");
  });

  it("the DEFAULT refresh coordinator is the fail-closed Upstash mutex, not inProcessOnly", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    // No coordinator override -> production default (createUpstashRefreshCoordinator).
    const rt = runtimeWith({ coordinator: undefined });
    let ran = false;
    await expect(
      rt.wiring.coordinator.runExclusive("c", async () => {
        ran = true;
      }),
    ).rejects.toBeTruthy();
    expect(ran).toBe(false); // inProcessOnly WOULD have run fn — this proves it is not used
  });

  it("the claim adapter calls claim_calendar_sync_op with ONLY the fixed batch size (no tenant/provider target)", async () => {
    const rpc = vi.fn(async (name: string) =>
      name === "claim_calendar_sync_op"
        ? {
            data: [
              {
                id: "i",
                studio_id: "s",
                connection_id: "c",
                op_type: "event.create",
                claim_token: "t",
                attempts: 1,
                max_attempts: 5,
                priority: 100,
                lease_expires_at: new Date(0).toISOString(),
              },
            ],
            error: null,
          }
        : { data: "done", error: null },
    );
    const rt = createProductionWorkerRuntime({
      admin: { rpc } as never,
      connectionStore: eligibleConn,
      restClient: {} as never,
      opsStore: {} as never,
      crypto: failCrypto,
      isStudioOutboundEnabled: async () => true,
      coordinator: passThroughCoord,
    });
    const jobs = await rt.claim(WORKER_BATCH_SIZE);
    expect(rpc).toHaveBeenCalledWith("claim_calendar_sync_op", { p_batch_size: WORKER_BATCH_SIZE });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].claimToken).toBe("t");

    await rt.record({ id: "i", claimToken: "t", ok: true, errorCode: null, errorMessage: null, retryAfterSeconds: null });
    expect(rpc).toHaveBeenCalledWith("record_calendar_sync_result", {
      p_id: "i",
      p_claim_token: "t",
      p_ok: true,
      p_error_code: null,
      p_error_message: null,
      p_retry_after_seconds: null,
    });
  });

  it("toClaimedJob rejects a malformed claim row", () => {
    expect(() => toClaimedJob({ id: "i" })).toThrow(ClaimShapeError);
    expect(() => toClaimedJob({ id: "i", studio_id: "s", connection_id: "c", op_type: "bogus", claim_token: "t" })).toThrow(ClaimShapeError);
  });
});
