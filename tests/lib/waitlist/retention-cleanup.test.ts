import { describe, expect, it } from "vitest";
import { classifyRetentionFailure, runRetentionCleanup, type RetentionRpcClient } from "@/lib/waitlist/retention-cleanup";

// Synthetic only. The fake stands in for the 0326 database functions (contract v2); the DB suite proves the real ones.

type Row = Partial<Record<string, unknown>>;
const row = (o: Row = {}) => ({
  run_id: "r", outcome: "success", erased_answers: 0, failed_answers: 0, purge_failed: 0, purged_erase_records: 0, purged_outbox: 0, purged_runs: 0,
  remaining_answers: 0, remaining_erase_records: 0, remaining_outbox: 0, started_at: "t", finished_at: "t", ...o,
});

function fake(steps: Array<{ data?: unknown; error?: { code?: string } | null; throws?: unknown }>) {
  const calls: Array<{ fn: string; args?: Record<string, unknown> }> = [];
  let i = 0;
  const client: RetentionRpcClient = {
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      if (fn === "record_waitlist_retention_failure") return { data: "failure-run-id", error: null };
      const step = steps[Math.min(i++, steps.length - 1)];
      if (step.throws !== undefined) throw step.throws;
      return { data: step.data ?? null, error: step.error ?? null };
    },
  };
  return { client, calls };
}

describe("the cleanup loop", () => {
  it("calls the function with the batch size, and stops when nothing remains", async () => {
    const f = fake([{ data: [row({ erased_answers: 500, remaining_answers: 120 })] }, { data: [row({ erased_answers: 120 })] }]);
    const out = await runRetentionCleanup(f.client);
    expect(out).toMatchObject({ ok: true, calls: 2, remaining: 0, stoppedEarly: false, partialFailure: false });
    expect(out.ok && "counts" in out && out.counts.erasedAnswers).toBe(620);
    expect(f.calls.every((c) => c.fn === "run_waitlist_retention_cleanup" && c.args?.p_batch_size === 500)).toBe(true);
  });
  it("sums the purges and uses the LAST call's remaining counts", async () => {
    const f = fake([
      { data: [row({ purged_outbox: 10, purged_runs: 2, remaining_outbox: 5 })] },
      { data: [row({ purged_outbox: 5, purged_erase_records: 3 })] },
    ]);
    const out = await runRetentionCleanup(f.client);
    expect(out.ok && "counts" in out && out.counts).toMatchObject({ purgedOutbox: 15, purgedRuns: 2, purgedEraseRecords: 3, remainingOutbox: 0 });
  });
  it("is bounded: at most maxCalls calls, then it reports what remains", async () => {
    const f = fake([{ data: [row({ erased_answers: 1, remaining_answers: 999 })] }]);
    const out = await runRetentionCleanup(f.client, { maxCalls: 20 });
    expect(f.calls).toHaveLength(20);
    expect(out).toMatchObject({ ok: true, calls: 20, remaining: 999, stoppedEarly: true });
  });
  it("is bounded in time: no new call starts after the budget", async () => {
    let t = 0;
    const f = fake([{ data: [row({ erased_answers: 1, remaining_answers: 9 })] }]);
    const out = await runRetentionCleanup(f.client, { budgetMs: 12_000, now: () => (t += 5_000) });
    expect(f.calls.length).toBeLessThan(20);
    expect(out).toMatchObject({ ok: true, stoppedEarly: true });
  });
  it("stops when a call makes no progress (rows it skips fail every time), instead of repeating itself", async () => {
    const f = fake([{ data: [row({ outcome: "partial_failure", failed_answers: 3, remaining_answers: 3 })] }]);
    const out = await runRetentionCleanup(f.client);
    expect(f.calls).toHaveLength(1);
    expect(out).toMatchObject({ ok: true, partialFailure: true, remaining: 3, stoppedEarly: true });
    expect(out.ok && "counts" in out && out.counts.failedAnswers).toBe(3);
  });
  it("a failed purge alone is a partial failure: the outcome and purge_failed agree, and it is counted", async () => {
    const out = await runRetentionCleanup(fake([{ data: [row({ outcome: "partial_failure", purge_failed: 2, erased_answers: 4 })] }]).client);
    expect(out).toMatchObject({ ok: true, partialFailure: true });
    expect(out.ok && "counts" in out && out.counts).toMatchObject({ purgeFailed: 2, failedAnswers: 0, erasedAnswers: 4 });
    // success with a failed purge, or partial_failure with nothing failed, contradict each other and are not trusted
    expect(await runRetentionCleanup(fake([{ data: [row({ outcome: "success", purge_failed: 1 })] }]).client)).toMatchObject({ ok: false, errorClass: "unknown" });
    expect(await runRetentionCleanup(fake([{ data: [row({ outcome: "partial_failure" })] }]).client)).toMatchObject({ ok: false, errorClass: "unknown" });
  });
  it("a partial failure with progress keeps going and totals the failures", async () => {
    const f = fake([
      { data: [row({ outcome: "partial_failure", failed_answers: 1, erased_answers: 499, remaining_answers: 1 })] },
      { data: [row({ outcome: "partial_failure", failed_answers: 1 })] },
    ]);
    const out = await runRetentionCleanup(f.client);
    expect(out).toMatchObject({ ok: true, partialFailure: true });
    expect(out.ok && "counts" in out && out.counts).toMatchObject({ erasedAnswers: 499, failedAnswers: 2 });
  });
});

describe("a failure", () => {
  it("is recorded in the database by CLASS only, in a separate call, and returns no error text", async () => {
    const f = fake([{ error: { code: "XX000" } }]);
    const out = await runRetentionCleanup(f.client);
    expect(out).toMatchObject({ ok: false, errorClass: "exception", failureRecorded: true });
    expect(f.calls.map((c) => c.fn)).toEqual(["run_waitlist_retention_cleanup", "record_waitlist_retention_failure"]);
    expect(f.calls[1].args).toEqual({ p_error_class: "exception" });
    expect(JSON.stringify(out)).not.toMatch(/message|detail/i);
  });
  it("a statement or lock timeout is class timeout; a thrown AbortError is class timeout; a malformed row is unknown", async () => {
    for (const code of ["57014", "55P03"]) expect(await runRetentionCleanup(fake([{ error: { code } }]).client)).toMatchObject({ errorClass: "timeout" });
    const abort = Object.assign(new Error("aborted with PRIVATE text"), { name: "AbortError" });
    const thrown = await runRetentionCleanup(fake([{ throws: abort }]).client);
    expect(thrown).toMatchObject({ ok: false, errorClass: "timeout" });
    expect(JSON.stringify(thrown)).not.toContain("PRIVATE");
    expect(await runRetentionCleanup(fake([{ data: [{ run_id: "r" }] }]).client)).toMatchObject({ ok: false, errorClass: "unknown" });
    // an outcome that disagrees with the failed count is not trusted
    expect(await runRetentionCleanup(fake([{ data: [row({ outcome: "success", failed_answers: 2 })] }]).client)).toMatchObject({ ok: false, errorClass: "unknown" });
    expect(await runRetentionCleanup(fake([{ data: [row({ outcome: "weird" })] }]).client)).toMatchObject({ ok: false, errorClass: "unknown" });
  });
  it("keeps the counts of calls that succeeded before it", async () => {
    const out = await runRetentionCleanup(fake([{ data: [row({ erased_answers: 500, remaining_answers: 10 })] }, { error: { code: "XX000" } }]).client);
    expect(out).toMatchObject({ ok: false, calls: 2 });
    expect(out.ok === false && out.counts.erasedAnswers).toBe(500);
  });
  it("a failed failure-record is reported, not hidden", async () => {
    const client: RetentionRpcClient = {
      rpc: async (fn) => (fn === "record_waitlist_retention_failure" ? { data: null, error: { code: "XX000" } } : { data: null, error: { code: "XX000" } }),
    };
    expect(await runRetentionCleanup(client)).toMatchObject({ ok: false, failureRecorded: false });
  });
  it("before 0326 is applied (function missing) it is skipped: not a failure, no failure row, no alert", async () => {
    for (const code of ["PGRST202", "42883"]) {
      const f = fake([{ error: { code } }]);
      expect(await runRetentionCleanup(f.client)).toEqual({ ok: true, skipped: "not_installed" });
      expect(f.calls.map((c) => c.fn)).toEqual(["run_waitlist_retention_cleanup"]);
    }
  });
  it("classifyRetentionFailure uses a closed code list", () => {
    expect(classifyRetentionFailure({ code: "57014" }, false)).toBe("timeout");
    expect(classifyRetentionFailure({ code: "23505" }, false)).toBe("exception");
    expect(classifyRetentionFailure(new Error("x"), true)).toBe("exception");
  });
});
