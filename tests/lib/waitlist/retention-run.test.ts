import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ raise: vi.fn(async () => "alerted"), check: vi.fn(async () => ({ status: "unavailable" })) }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/waitlist/retention-health", () => ({ raiseRetentionAlert: h.raise, checkRetentionHealthAndAlert: h.check }));
import { runRetentionForCron } from "@/lib/waitlist/retention-run";
import type { RetentionRpcClient } from "@/lib/waitlist/retention-cleanup";

// Synthetic only. The fake stands in for the 0326 functions.
const row = (o: Record<string, unknown> = {}) => ({
  run_id: "r", outcome: "success", erased_answers: 0, failed_answers: 0, purge_failed: 0, purged_erase_records: 0, purged_outbox: 0, purged_runs: 0,
  remaining_answers: 0, remaining_erase_records: 0, remaining_outbox: 0, ...o,
});
const client = (steps: Array<{ data?: unknown; error?: { code?: string } | null }>): { c: RetentionRpcClient; calls: string[] } => {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    c: {
      rpc: async (fn) => {
        calls.push(fn);
        if (fn === "record_waitlist_retention_failure") return { data: "id", error: null };
        const s = steps[Math.min(i++, steps.length - 1)];
        return { data: s.data ?? null, error: s.error ?? null };
      },
    },
  };
};

beforeEach(() => vi.clearAllMocks());

describe("the cron's erase", () => {
  it("calls the erase and raises nothing on a clean run", async () => {
    const k = client([{ data: [row({ erased_answers: 3 })] }]);
    expect(await runRetentionForCron(() => k.c)).toMatchObject({ ok: true, erasedAnswers: 3, partialFailure: false });
    expect(k.calls).toEqual(["run_waitlist_retention_cleanup"]);
    expect(h.raise).not.toHaveBeenCalled();
  });
  it("a FAILED run raises the failed alert with a class and counts only", async () => {
    const k = client([{ error: { code: "XX000" } }]);
    expect(await runRetentionForCron(() => k.c)).toMatchObject({ ok: false, errorClass: "exception", failureRecorded: true });
    expect(h.raise).toHaveBeenCalledTimes(1);
    const [kind, , details] = h.raise.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(kind).toBe("failed");
    expect(details).toMatchObject({ error_class: "exception" });
  });
  it("partial_failure from answers that would not erase raises the failed alert", async () => {
    const k = client([{ data: [row({ outcome: "partial_failure", failed_answers: 2, erased_answers: 1 })] }]);
    expect(await runRetentionForCron(() => k.c)).toMatchObject({ ok: true, partialFailure: true, failedAnswers: 2 });
    expect(h.raise).toHaveBeenCalledTimes(1);
  });
  it("purge_failed > 0 alone also raises the failed alert, with the count", async () => {
    const k = client([{ data: [row({ outcome: "partial_failure", purge_failed: 1 })] }]);
    expect(await runRetentionForCron(() => k.c)).toMatchObject({ ok: true, partialFailure: true, purgeFailed: 1 });
    expect(h.raise).toHaveBeenCalledTimes(1);
    expect((h.raise.mock.calls[0] as unknown as [string, string, Record<string, unknown>])[2]).toMatchObject({ purge_failed: 1, failed_answers: 0 });
  });
  it("before 0326 is applied it is skipped without an alert", async () => {
    const k = client([{ error: { code: "PGRST202" } }]);
    expect(await runRetentionForCron(() => k.c)).toEqual({ ok: true, skipped: "not_installed" });
    expect(h.raise).not.toHaveBeenCalled();
  });
  it("a client that cannot be built is a route_error failure, not a throw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runRetentionForCron(() => { throw new Error("no client"); })).toMatchObject({ ok: false, errorClass: "route_error" });
    expect(h.raise).toHaveBeenCalledTimes(1);
  });
});
