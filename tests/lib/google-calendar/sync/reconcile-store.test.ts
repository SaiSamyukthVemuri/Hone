import { describe, expect, it } from "vitest";
import {
  createReconcileObservability,
  createSupabaseReconcileStore,
  pruneMetricEvents,
} from "@/lib/google-calendar/sync/reconcile-store";
import type { StudioReconcileResult } from "@/lib/google-calendar/sync/reconcile";

// Phase B2.3-b — the PostgREST-specific glue in reconcile-store.ts that the
// raw-pg DB suite (which uses a single SQL join) does NOT exercise: the
// eligible-studio INTERSECTION, the bounded metric prune, and the PHI-free
// observability sink. A tiny fake admin client stands in for the Supabase client.

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
      studios: { data: [{ id: "s1" }, { id: "s2" }] }, // flag on
      calendar_connections: { data: [{ studio_id: "s1" }, { studio_id: "s3" }] }, // owner + write target
    });
    const store = createSupabaseReconcileStore(asAdmin(admin));
    expect(await store.listEligibleStudioIds()).toEqual(["s1"]); // intersection only
  });

  it("empty flag set (production dormancy) -> no eligible studios", async () => {
    const { admin } = makeAdmin({ studios: { data: [] }, calendar_connections: { data: [{ studio_id: "s1" }] } });
    const store = createSupabaseReconcileStore(asAdmin(admin));
    expect(await store.listEligibleStudioIds()).toEqual([]);
  });
});

describe("pruneMetricEvents — bounded select-then-delete", () => {
  it("deletes the selected id page and returns its count", async () => {
    const { admin, deletes } = makeAdmin({ calendar_sync_metric_events: { data: [{ id: "m1" }, { id: "m2" }] } });
    const n = await pruneMetricEvents(asAdmin(admin), "2026-01-01T00:00:00Z", 1000);
    expect(n).toBe(2);
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
      candidates: 0,
      enqueued: 0,
      skipped: 0,
      superseded: 0,
      byClass: { missing_link_job: 0, link_version_behind: 0, orphaned_link_delete: 0, surplus_event_delete: 0 },
      errors: 0,
      appointmentCursor: null,
      linkCursor: null,
      truncated: false,
      ...over,
    };
  }

  it("enqueued>0 -> one 'reconcile_enqueued' metric row with aggregate-only safe_details", async () => {
    const { admin, inserts } = makeAdmin();
    const obs = createReconcileObservability(asAdmin(admin));
    await obs.recordStudioResult!(result({ enqueued: 2, candidates: 5, byClass: { missing_link_job: 2, link_version_behind: 0, orphaned_link_delete: 0, surplus_event_delete: 0 } }));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe("calendar_sync_metric_events");
    expect(inserts[0].row).toMatchObject({ studio_id: "s1", metric: "reconcile_enqueued" });
    expect(JSON.stringify(inserts[0].row)).not.toMatch(/@|client|name|email|phone|token|google_event/i);
  });

  it("lock unavailable -> one 'reconcile_lock_unavailable' metric row", async () => {
    const { admin, inserts } = makeAdmin();
    const obs = createReconcileObservability(asAdmin(admin));
    await obs.recordStudioResult!(result({ locked: false, lockSkipReason: "unavailable" }));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].row).toMatchObject({ metric: "reconcile_lock_unavailable" });
  });

  it("nothing notable (no enqueue, lock held) -> no metric row", async () => {
    const { admin, inserts } = makeAdmin();
    const obs = createReconcileObservability(asAdmin(admin));
    await obs.recordStudioResult!(result({ locked: false, lockSkipReason: "held" }));
    expect(inserts).toEqual([]);
  });
});
