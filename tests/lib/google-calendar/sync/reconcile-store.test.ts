import { describe, expect, it } from "vitest";
import {
  createReconcileObservability,
  createSupabaseReconcileStore,
  pruneMetricEvents,
} from "@/lib/google-calendar/sync/reconcile-store";
import type { StudioReconcileResult } from "@/lib/google-calendar/sync/reconcile";

// Phase B2.3-b — the PostgREST-specific glue the raw-pg DB suite doesn't exercise:
// the eligible-studio intersection, bounded metric prune, and PHI-free observability.

type SelectResponses = Record<string, { data?: unknown[]; error?: unknown }>;

function makeAdmin(select: SelectResponses = {}) {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const deletes: { table: string; ids: unknown[] }[] = [];
  const admin = {
    from(table: string) {
      return {
        select() {
          const b: Record<string, unknown> = {};
          for (const m of ["eq", "gte", "lte", "lt", "is", "in", "not", "order", "limit"]) b[m] = () => b;
          (b as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(select[table] ?? { data: [] }).then(res, rej);
          return b;
        },
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
        delete() {
          return {
            in: (_col: string, ids: unknown[]) => {
              deletes.push({ table, ids });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
  return { admin, inserts, deletes };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAdmin = (a: unknown) => a as any;

describe("listEligibleStudioIds — flag ∩ (owner + write target)", () => {
  it("returns only studios that are BOTH flagged AND have an owner connection with a write calendar", async () => {
    const { admin } = makeAdmin({
      studios: { data: [{ id: "s1" }, { id: "s2" }] },
      calendar_connections: { data: [{ studio_id: "s1" }, { studio_id: "s3" }] },
    });
    const store = createSupabaseReconcileStore(asAdmin(admin));
    expect(await store.listEligibleStudioIds()).toEqual(["s1"]);
  });

  it("empty flag set (production dormancy) -> no eligible studios", async () => {
    const { admin } = makeAdmin({ studios: { data: [] }, calendar_connections: { data: [{ studio_id: "s1" }] } });
    const store = createSupabaseReconcileStore(asAdmin(admin));
    expect(await store.listEligibleStudioIds()).toEqual([]);
  });
});

describe("getOpenJobsForEntities — op class + payload sync_version + status", () => {
  it("groups jobs per entity with the version read from payload", async () => {
    const { admin } = makeAdmin({
      calendar_sync_outbox: {
        data: [
          { hone_entity_id: "a1", op_type: "event.create", status: "pending", payload: { sync_version: 1 } },
          { hone_entity_id: "a1", op_type: "event.update", status: "dead", payload: { sync_version: 2 } },
          { hone_entity_id: "a2", op_type: "event.delete", status: "processing", payload: {} }, // no version -> null
        ],
      },
    });
    const store = createSupabaseReconcileStore(asAdmin(admin));
    const m = await store.getOpenJobsForEntities("s1", ["a1", "a2"]);
    expect(m.get("a1")).toEqual([
      { opType: "event.create", syncVersion: 1, status: "pending" },
      { opType: "event.update", syncVersion: 2, status: "dead" },
    ]);
    expect(m.get("a2")).toEqual([{ opType: "event.delete", syncVersion: null, status: "processing" }]);
  });
});

describe("listStudiosWithDeadOutbox — aggregate dead counts", () => {
  it("counts dead rows per studio", async () => {
    const { admin } = makeAdmin({ calendar_sync_outbox: { data: [{ studio_id: "s1" }, { studio_id: "s1" }, { studio_id: "s2" }] } });
    const store = createSupabaseReconcileStore(asAdmin(admin));
    const rows = await store.listStudiosWithDeadOutbox();
    expect(rows.sort((a, b) => a.studioId.localeCompare(b.studioId))).toEqual([
      { studioId: "s1", deadCount: 2 },
      { studioId: "s2", deadCount: 1 },
    ]);
  });
});

describe("pruneMetricEvents — bounded select-then-delete", () => {
  it("deletes the selected id page and returns its count", async () => {
    const { admin, deletes } = makeAdmin({ calendar_sync_metric_events: { data: [{ id: "m1" }, { id: "m2" }] } });
    expect(await pruneMetricEvents(asAdmin(admin), "2026-01-01T00:00:00Z", 1000)).toBe(2);
    expect(deletes).toEqual([{ table: "calendar_sync_metric_events", ids: ["m1", "m2"] }]);
  });
  it("nothing to prune -> no delete issued", async () => {
    const { admin, deletes } = makeAdmin({ calendar_sync_metric_events: { data: [] } });
    expect(await pruneMetricEvents(asAdmin(admin), "2026-01-01T00:00:00Z", 1000)).toBe(0);
    expect(deletes).toEqual([]);
  });
});

describe("observability sink — records only notable studios, PHI-free", () => {
  function result(over: Partial<StudioReconcileResult>): StudioReconcileResult {
    return {
      studioId: "s1",
      locked: true,
      continuationRead: true,
      continuationPersisted: true,
      candidates: 0,
      enqueued: 0,
      skipped: 0,
      superseded: 0,
      byClass: { missing_link_job: 0, link_version_behind: 0, orphaned_link_delete: 0, surplus_event_delete: 0 },
      errors: 0,
      errored: false,
      truncated: false,
      deadlineHit: false,
      ownershipLost: false,
      appointmentCursor: null,
      linkCursor: null,
      outcome: "ok",
      ...over,
    };
  }

  it("enqueued>0 -> 'reconcile_enqueued' metric, aggregate-only", async () => {
    const { admin, inserts } = makeAdmin();
    await createReconcileObservability(asAdmin(admin)).recordStudioResult!(result({ enqueued: 2, candidates: 5 }));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].row).toMatchObject({ studio_id: "s1", metric: "reconcile_enqueued" });
    expect(JSON.stringify(inserts[0].row)).not.toMatch(/@|client|name|email|phone|token|google_event/i);
  });

  it("degraded outcome -> 'reconcile_degraded' metric", async () => {
    const { admin, inserts } = makeAdmin();
    await createReconcileObservability(asAdmin(admin)).recordStudioResult!(result({ outcome: "degraded", truncated: true }));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].row).toMatchObject({ metric: "reconcile_degraded" });
  });

  it("clean no-op studio -> no metric row", async () => {
    const { admin, inserts } = makeAdmin();
    await createReconcileObservability(asAdmin(admin)).recordStudioResult!(result({}));
    expect(inserts).toEqual([]);
  });
});
