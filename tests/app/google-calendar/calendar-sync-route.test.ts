import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleWorkerRoute,
  type WorkerRoutePorts,
} from "@/lib/google-calendar/sync/worker-runtime";
import type { WorkerHeartbeat } from "@/lib/google-calendar/sync/worker-heartbeat";
import type { ClaimedJob } from "@/lib/google-calendar/sync/job-result";

// Google Calendar: Phase B2.3-c2: the /api/cron/calendar-sync route contract
// (§21). Exercised through the server-only seam handleWorkerRoute with an INJECTED
// runtime + observers, no Supabase, no Redis, no Google. Plus the route module's
// GET wrapper (runtime/dynamic/no-store) via its unauthorized path.

const SECRET = "test-cron-secret-value";
const URL_BASE = "https://hone.care/api/cron/calendar-sync";

function authed(path = URL_BASE): Request {
  return new Request(path, { headers: { authorization: `Bearer ${SECRET}` } });
}

function job(id: string, over: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id,
    studioId: "studio-XYZ",
    connectionId: "conn-XYZ",
    opType: "event.create",
    honeEntityType: "appointment",
    honeEntityId: `appt-${id}`,
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

// A runtime whose ports are spies; defaults to a no-work drain.
function fakeRuntime(over: Partial<WorkerRoutePorts> = {}) {
  return {
    claim: vi.fn(async () => [] as ClaimedJob[]),
    handle: vi.fn(async () => ({ code: "ok" as const })),
    record: vi.fn(async () => "done"),
    ...over,
  };
}

const savedSecret = process.env.CRON_SECRET;
beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedSecret;
  vi.restoreAllMocks();
});

describe("worker route: authentication (§21)", () => {
  it("missing Authorization -> 401 and NEVER builds/claims", async () => {
    const rt = fakeRuntime();
    const res = await handleWorkerRoute(new Request(URL_BASE), { runtime: rt });
    expect(res.status).toBe(401);
    expect(rt.claim).not.toHaveBeenCalled();
  });

  it("malformed bearer -> 401", async () => {
    const rt = fakeRuntime();
    const res = await handleWorkerRoute(new Request(URL_BASE, { headers: { authorization: "Basic zzz" } }), { runtime: rt });
    expect(res.status).toBe(401);
    expect(rt.claim).not.toHaveBeenCalled();
  });

  it("wrong bearer value -> 401", async () => {
    const rt = fakeRuntime();
    const res = await handleWorkerRoute(new Request(URL_BASE, { headers: { authorization: "Bearer nope" } }), { runtime: rt });
    expect(res.status).toBe(401);
    expect(rt.claim).not.toHaveBeenCalled();
  });

  it("missing CRON_SECRET -> fail closed (401)", async () => {
    delete process.env.CRON_SECRET;
    const rt = fakeRuntime();
    const res = await handleWorkerRoute(authed(), { runtime: rt });
    expect(res.status).toBe(401);
    expect(rt.claim).not.toHaveBeenCalled();
  });

  it("correct bearer -> proceeds; the secret never appears in the response", async () => {
    const rt = fakeRuntime();
    const res = await handleWorkerRoute(authed(), { runtime: rt });
    expect(res.status).toBe(200);
    expect(rt.claim).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });
});

describe("worker route: no caller-controlled targeting (§7/§21)", () => {
  for (const q of ["studio_id=s", "connection_id=c", "appointment_id=a", "event_id=e", "link_id=l", "calendar_id=cal", "batch_size=999", "limit=999", "deadline=1"]) {
    it(`rejects ?${q} with a PHI-free 400 before claiming`, async () => {
      const rt = fakeRuntime();
      const res = await handleWorkerRoute(authed(`${URL_BASE}?${q}`), { runtime: rt });
      expect(res.status).toBe(400);
      expect(rt.claim).not.toHaveBeenCalled(); // cannot alter claim selection
      expect(JSON.stringify(res.body)).not.toContain("studio");
    });
  }
});

describe("worker route: no-work (§20/§21)", () => {
  it("claim returns zero -> truthful no-work; no handle/record; heartbeat records no-work", async () => {
    const rt = fakeRuntime();
    const hbs: WorkerHeartbeat[] = [];
    const res = await handleWorkerRoute(authed(), {
      runtime: rt,
      observers: { recordHeartbeat: async (hb) => void hbs.push(hb) },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, outcome: "ok", claimed: 0, no_work: true });
    expect(rt.handle).not.toHaveBeenCalled();
    expect(rt.record).not.toHaveBeenCalled();
    expect(hbs).toHaveLength(1);
    expect(hbs[0]).toMatchObject({ no_work: true, outcome: "ok" });
  });

  it("a heartbeat write failure does not change the response", async () => {
    const rt = fakeRuntime();
    const res = await handleWorkerRoute(authed(), {
      runtime: rt,
      observers: {
        recordHeartbeat: async () => {
          throw new Error("heartbeat-down");
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, no_work: true });
  });
});

describe("worker route: one successful job returns PHI-free aggregates only (§18/§21)", () => {
  it("records durable done; response carries no identifiers", async () => {
    const rt = fakeRuntime({ claim: vi.fn(async () => [job("1")]) });
    const res = await handleWorkerRoute(authed(), { runtime: rt });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, outcome: "ok", claimed: 1, handled: 1, recorded_done: 1 });
    const s = JSON.stringify(res.body);
    for (const leak of ["studio-XYZ", "conn-XYZ", "appt-1", "tok-1", "k-1"]) {
      expect(s).not.toContain(leak);
    }
  });
});

describe("worker route: observability sabotage cannot alter correctness (§21)", () => {
  const scenarios: Array<[string, () => Partial<import("@/lib/google-calendar/sync/worker-runtime").WorkerRouteObservers>]> = [
    ["heartbeat throws", () => ({ recordHeartbeat: async () => { throw new Error("hb"); } })],
    ["alert throws", () => ({ emitAlert: async () => { throw new Error("al"); } })],
    ["both throw", () => ({ recordHeartbeat: async () => { throw new Error("hb"); }, emitAlert: async () => { throw new Error("al"); } })],
  ];
  for (const [name, obs] of scenarios) {
    it(`${name}: claim/handle/record counts + truthful result preserved`, async () => {
      // A degraded run (record_rejected) so an alert would fire, proving a
      // throwing alert/heartbeat cannot corrupt the outcome.
      const rt = fakeRuntime({ claim: vi.fn(async () => [job("1")]), record: vi.fn(async () => "stale_token") });
      const res = await handleWorkerRoute(authed(), { runtime: rt, observers: obs() });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ outcome: "degraded", ok: false, record_rejected: 1 });
      expect(rt.claim).toHaveBeenCalledTimes(1);
      expect(rt.handle).toHaveBeenCalledTimes(1);
      expect(rt.record).toHaveBeenCalledTimes(1);
    });
  }
});

describe("worker route: record failure surfaces truthfully, not hidden by heartbeat (§10/§19)", () => {
  it("record transport failure -> 500 error even if a heartbeat is written", async () => {
    const rt = fakeRuntime({
      claim: vi.fn(async () => [job("1")]),
      record: vi.fn(async () => {
        throw new Error("record_rpc_error");
      }),
    });
    const hbs: WorkerHeartbeat[] = [];
    const res = await handleWorkerRoute(authed(), { runtime: rt, observers: { recordHeartbeat: async (hb) => void hbs.push(hb) } });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, outcome: "error", record_errors: 1 });
    expect(hbs[0]).toMatchObject({ outcome: "error", record_errors: 1 }); // heartbeat is truthful, not concealing
  });
});

describe("route module GET wrapper", () => {
  it("declares node runtime + force-dynamic and returns no-store on the unauthorized path", async () => {
    const mod = await import("@/app/api/cron/calendar-sync/route");
    expect(mod.runtime).toBe("nodejs");
    expect(mod.dynamic).toBe("force-dynamic");
    delete process.env.CRON_SECRET; // force 401 so GET builds no real runtime
    const res = await mod.GET(new Request(URL_BASE));
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
