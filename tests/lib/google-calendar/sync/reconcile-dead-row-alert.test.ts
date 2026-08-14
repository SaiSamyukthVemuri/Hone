import { afterEach, describe, expect, it, vi } from "vitest";

// Phase B2.3-b §8: the dead-row operational alert recorder: creation, dedupe,
// resolution/reappearance, and fail-open sabotage. createAdminClient + recordOpsAlert
// are mocked so the recorder's dedupe logic is exercised without a network call.

const { recordOpsAlert, createAdminClient } = vi.hoisted(() => ({
  recordOpsAlert: vi.fn(async (_input?: unknown) => {}),
  createAdminClient: vi.fn(),
}));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient }));

import { DEAD_ROW_EVENT, recordCalendarDeadRowAlert, sweepCalendarDeadRowAlerts } from "@/lib/google-calendar/sync/reconcile-heartbeat";
import type { ReconcileCoordinator } from "@/lib/google-calendar/sync/reconcile";

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

// A single-slot dead-alert coordinator with a DURABLE cursor (persists across a test's
// invocations). Token-aware writeCursor proves ownership atomicity.
class FakeDeadCoordinator implements ReconcileCoordinator {
  private heldNow = false;
  private ownerToken: string | null = null;
  cursor: string | null = null;
  acquireResult: "ok" | "held" | "unavailable" = "ok";
  readOk = true;
  writeOk = true;
  private seq = 0;
  async acquire() {
    if (this.acquireResult !== "ok") return { ok: false as const, reason: this.acquireResult };
    if (this.heldNow) return { ok: false as const, reason: "held" as const };
    this.heldNow = true;
    this.ownerToken = `d-${this.seq++}`;
    return { ok: true as const, token: this.ownerToken };
  }
  async release(t: string) {
    if (this.ownerToken === t) {
      this.heldNow = false;
      this.ownerToken = null;
    }
  }
  async renew(t: string) {
    return this.ownerToken === t;
  }
  async readCursor() {
    return this.readOk ? { ok: true as const, cursor: this.cursor } : { ok: false as const };
  }
  async writeCursor(t: string, c: string | null) {
    if (!this.writeOk || this.ownerToken !== t) return false;
    this.cursor = c;
    return true;
  }
}

describe("sweepCalendarDeadRowAlerts: coordinator + durable cursor + outcome model", () => {
  it("drains all studios across pages -> completed; cursor cleared", async () => {
    createAdminClient.mockReturnValue(adminReturning([]));
    const store = pagingStore([{ studioId: "s1", deadCount: 1 }, { studioId: "s2", deadCount: 2 }, { studioId: "s3", deadCount: 3 }]);
    const coord = new FakeDeadCoordinator();
    const r = await sweepCalendarDeadRowAlerts(store, coord, { pageSize: 1 });
    expect(r.outcome).toBe("completed");
    expect(r.studios).toBe(3);
    expect(r.alerted).toBe(3);
    expect(coord.cursor).toBeNull(); // cleared on completion
  });

  it("studio cap -> deferred; cursor persisted at the last processed studio", async () => {
    createAdminClient.mockReturnValue(adminReturning([]));
    const store = pagingStore([{ studioId: "s1", deadCount: 1 }, { studioId: "s2", deadCount: 2 }, { studioId: "s3", deadCount: 3 }]);
    const coord = new FakeDeadCoordinator();
    const r = await sweepCalendarDeadRowAlerts(store, coord, { pageSize: 5, maxStudios: 2 });
    expect(r.outcome).toBe("deferred");
    expect(r.studios).toBe(2);
    expect(coord.cursor).toBe("s2"); // persisted for the next invocation
  });

  it("durable cursor resumes strictly after; later studios never starve", async () => {
    createAdminClient.mockReturnValue(adminReturning([]));
    const store = pagingStore([{ studioId: "s1", deadCount: 1 }, { studioId: "s2", deadCount: 2 }, { studioId: "s3", deadCount: 3 }]);
    const coord = new FakeDeadCoordinator(); // SHARED across invocations
    const processed: string[] = [];
    // patch the store to record what each invocation examines
    let done = false;
    let guard = 0;
    while (!done && guard++ < 10) {
      const spy = {
        pageStudiosWithDeadOutbox: async (after: string | null, limit: number) => {
          const page = await store.pageStudiosWithDeadOutbox(after, limit);
          processed.push(...page.map((p) => p.studioId));
          return page;
        },
      };
      const r = await sweepCalendarDeadRowAlerts(spy, coord, { pageSize: 1, maxStudios: 1 });
      done = r.outcome === "completed";
    }
    expect(processed).toEqual(["s1", "s2", "s3"]); // each once, in order, resumed after the cursor
    expect(coord.cursor).toBeNull();
  });

  it("coordinator HELD -> skipped_held, no work", async () => {
    const store = pagingStore([{ studioId: "s1", deadCount: 1 }]);
    const coord = new FakeDeadCoordinator();
    coord.acquireResult = "held";
    const r = await sweepCalendarDeadRowAlerts(store, coord);
    expect(r).toMatchObject({ outcome: "skipped_held", coordinatorStatus: "held", studios: 0 });
  });

  it("coordinator UNAVAILABLE -> unavailable, no sweep", async () => {
    const store = pagingStore([{ studioId: "s1", deadCount: 1 }]);
    const coord = new FakeDeadCoordinator();
    coord.acquireResult = "unavailable";
    expect((await sweepCalendarDeadRowAlerts(store, coord)).outcome).toBe("unavailable");
  });

  it("cursor READ I/O error -> unavailable (never runs from an unknown position)", async () => {
    const store = pagingStore([{ studioId: "s1", deadCount: 1 }]);
    const coord = new FakeDeadCoordinator();
    coord.readOk = false;
    expect((await sweepCalendarDeadRowAlerts(store, coord)).outcome).toBe("unavailable");
  });

  it("a store/inventory failure -> ERROR (not a completed sweep)", async () => {
    createAdminClient.mockReturnValue(adminReturning([]));
    const failing = { pageStudiosWithDeadOutbox: async () => { throw new Error("boom"); } };
    const r = await sweepCalendarDeadRowAlerts(failing, new FakeDeadCoordinator());
    expect(r.outcome).toBe("error");
    expect(r.errorClass).toBe("Error");
  });

  it("cursor PERSIST failure -> error, cursorPersistFailed", async () => {
    createAdminClient.mockReturnValue(adminReturning([]));
    const store = pagingStore([{ studioId: "s1", deadCount: 1 }]);
    const coord = new FakeDeadCoordinator();
    coord.writeOk = false;
    const r = await sweepCalendarDeadRowAlerts(store, coord);
    expect(r.outcome).toBe("error");
    expect(r.cursorPersistFailed).toBe(true);
  });

  it("two concurrent sweeps -> one owns the campaign, the other skipped_held; no double advance", async () => {
    createAdminClient.mockReturnValue(adminReturning([]));
    const store = pagingStore([{ studioId: "s1", deadCount: 1 }]);
    const coord = new FakeDeadCoordinator();
    const [a, b] = await Promise.all([sweepCalendarDeadRowAlerts(store, coord), sweepCalendarDeadRowAlerts(store, coord)]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["completed", "skipped_held"]);
  });
});
