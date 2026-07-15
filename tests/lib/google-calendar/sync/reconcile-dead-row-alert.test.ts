import { afterEach, describe, expect, it, vi } from "vitest";

// Phase B2.3-b §8 — the dead-row operational alert recorder: creation, dedupe,
// resolution/reappearance, and fail-open sabotage. createAdminClient + recordOpsAlert
// are mocked so the recorder's dedupe logic is exercised without a network call.

const { recordOpsAlert, createAdminClient } = vi.hoisted(() => ({
  recordOpsAlert: vi.fn(async (_input?: unknown) => {}),
  createAdminClient: vi.fn(),
}));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient }));

import { DEAD_ROW_EVENT, recordCalendarDeadRowAlert, sweepCalendarDeadRowAlerts } from "@/lib/google-calendar/sync/reconcile-heartbeat";

// A fake admin whose ops_alerts lookup resolves to `rows`.
function adminReturning(rows: unknown[]) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "limit"]) b[m] = () => b;
  (b as { then: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows }).then(res);
  return { from: () => b };
}

afterEach(() => {
  recordOpsAlert.mockClear();
  createAdminClient.mockReset();
});

describe("recordCalendarDeadRowAlert", () => {
  it("deadCount=0 -> no alert, no admin call", async () => {
    expect(await recordCalendarDeadRowAlert("s", 0)).toEqual({ alerted: false, deduped: false });
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(recordOpsAlert).not.toHaveBeenCalled();
  });

  it("dead rows + no unresolved alert -> creates a PHI-free, studio-scoped alert", async () => {
    createAdminClient.mockReturnValue(adminReturning([]));
    const r = await recordCalendarDeadRowAlert("studio-1", 3);
    expect(r.alerted).toBe(true);
    expect(recordOpsAlert).toHaveBeenCalledTimes(1);
    const arg = recordOpsAlert.mock.calls[0][0] as unknown as { event: string; studioId: string; safeDetails: unknown };
    expect(arg).toMatchObject({ event: DEAD_ROW_EVENT, studioId: "studio-1" });
    expect(JSON.stringify(arg.safeDetails)).not.toMatch(/@|client|name|email|phone|token|google_event/i);
  });

  it("dead rows + an existing unresolved alert -> deduped (no new alert)", async () => {
    createAdminClient.mockReturnValue(adminReturning([{ id: "x" }]));
    expect(await recordCalendarDeadRowAlert("s", 3)).toEqual({ alerted: false, deduped: true });
    expect(recordOpsAlert).not.toHaveBeenCalled();
  });

  it("reappearance: after resolution (no unresolved) a fresh dead condition re-alerts", async () => {
    createAdminClient.mockReturnValue(adminReturning([]));
    expect((await recordCalendarDeadRowAlert("s", 2)).alerted).toBe(true);
  });

  it("sabotage: an admin failure never throws (fail-open)", async () => {
    createAdminClient.mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(recordCalendarDeadRowAlert("s", 5)).resolves.toBeDefined();
  });
});

// A paginating fake over the queue-health view (immutable studio_id cursor).
function pagingStore(rows: { studioId: string; deadCount: number }[]) {
  const sorted = rows.slice().sort((a, b) => (a.studioId < b.studioId ? -1 : 1));
  return {
    pageStudiosWithDeadOutbox: async (after: string | null, limit: number) =>
      sorted.filter((r) => after === null || r.studioId > after).slice(0, limit),
  };
}

describe("sweepCalendarDeadRowAlerts — bounded + deadline-aware", () => {
  it("pages across MORE rows than one page and covers all; not deferred when drained", async () => {
    createAdminClient.mockReturnValue(adminReturning([]));
    const store = pagingStore([
      { studioId: "s1", deadCount: 1 },
      { studioId: "s2", deadCount: 2 },
      { studioId: "s3", deadCount: 3 },
    ]);
    const r = await sweepCalendarDeadRowAlerts(store, { pageSize: 1 }); // 3 rows, 1/page
    expect(r).toEqual({ studios: 3, alerted: 3, deferred: false });
  });

  it("the per-invocation studio cap defers the remainder", async () => {
    createAdminClient.mockReturnValue(adminReturning([]));
    const store = pagingStore([
      { studioId: "s1", deadCount: 1 },
      { studioId: "s2", deadCount: 2 },
      { studioId: "s3", deadCount: 3 },
    ]);
    const r = await sweepCalendarDeadRowAlerts(store, { pageSize: 5, maxStudios: 2 });
    expect(r.studios).toBe(2);
    expect(r.deferred).toBe(true);
  });

  it("a passed deadline defers immediately", async () => {
    createAdminClient.mockReturnValue(adminReturning([]));
    const store = pagingStore([{ studioId: "s1", deadCount: 1 }]);
    const r = await sweepCalendarDeadRowAlerts(store, { now: () => 10, deadlineMs: 0 });
    expect(r).toEqual({ studios: 0, alerted: 0, deferred: true });
  });

  it("a store failure never throws (fail-open)", async () => {
    const failing = { pageStudiosWithDeadOutbox: async () => { throw new Error("x"); } };
    await expect(sweepCalendarDeadRowAlerts(failing)).resolves.toEqual({ studios: 0, alerted: 0, deferred: false });
  });
});
