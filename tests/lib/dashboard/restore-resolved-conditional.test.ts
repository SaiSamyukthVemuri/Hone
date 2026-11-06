import { beforeEach, describe, expect, it, vi } from "vitest";

// Codex P2 4492399987 (#1357): the post-response clear must be CONDITIONAL on the dismissal event this page load observed, so it can never restore a
// NEWER dismissal. The interleaving itself is proved on a database in tests/db/dashboard-attention-dismissals.db.test.ts.

const rpc = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<{ data: unknown; error: unknown }> => ({ data: { ok: true, changed: true }, error: null })));
const scheduled = vi.hoisted(() => ({ fns: [] as Array<() => Promise<void>> }));
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => void scheduled.fns.push(fn) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ rpc })) }));
const { loadMyDismissals, restoreResolvedDismissals } = await import("@/lib/dashboard/attention-dismissal-store");

beforeEach(() => { rpc.mockClear(); scheduled.fns.length = 0; });
const runScheduled = async () => { for (const f of scheduled.fns) await f(); };

describe("restoreResolvedDismissals", () => {
  it("carries the observed event_seq of each key into the restore", async () => {
    await restoreResolvedDismissals("s1", ["payment_setup:studio", "supply_expiry:a1"], [
      { itemKey: "payment_setup:studio", instanceToken: "x", eventSeq: 41 },
      { itemKey: "supply_expiry:a1", instanceToken: "2026-12-01", eventSeq: 57 },
    ]);
    expect(rpc).not.toHaveBeenCalled(); // not on the render path
    await runScheduled();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("restore_attention_item", { p_studio: "s1", p_item_key: "payment_setup:studio", p_observed_seq: 41 });
    expect(rpc).toHaveBeenCalledWith("restore_attention_item", { p_studio: "s1", p_item_key: "supply_expiry:a1", p_observed_seq: 57 });
  });
  it("NEVER restores unconditionally: a key whose observed event is unknown is skipped", async () => {
    await restoreResolvedDismissals("s1", ["payment_setup:studio"], [{ itemKey: "payment_setup:studio", instanceToken: "x" }]);
    await runScheduled();
    expect(scheduled.fns).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a key that was not among the observed dismissals is skipped", async () => {
    await restoreResolvedDismissals("s1", ["no_services:studio"], [{ itemKey: "payment_setup:studio", instanceToken: "x", eventSeq: 3 }]);
    await runScheduled();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("loadMyDismissals carries the event identity", () => {
  it("reads event_seq from the list command and ignores a non-integer one", async () => {
    rpc.mockResolvedValueOnce({ data: { ok: true, capped: false, rows: [
      { item_key: "a:studio", instance_token: "t", event_seq: 12 },
      { item_key: "b:studio", instance_token: "t", event_seq: "13" },
      { item_key: "c:studio", instance_token: "t" },
    ] }, error: null });
    const r = await loadMyDismissals("s1");
    expect(r).toEqual({ ok: true, capped: false, rows: [
      { itemKey: "a:studio", instanceToken: "t", eventSeq: 12 },
      { itemKey: "b:studio", instanceToken: "t" },
      { itemKey: "c:studio", instanceToken: "t" },
    ] });
  });
});
