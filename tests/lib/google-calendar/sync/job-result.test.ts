import { describe, expect, it } from "vitest";
import {
  ALL_JOB_RESULT_CODES,
  isDead,
  isDone,
  isRetry,
  resultToRpcParams,
  type JobResult,
  type JobResultCode,
} from "@/lib/google-calendar/sync/job-result";

// Phase B2.1 — the closed JobResult enum + its mapping to the
// record_calendar_sync_result outcomes (done / retry / dead).

describe("JobResult enum is closed + partitioned", () => {
  it("every code is classified into exactly one of done/retry/dead", () => {
    for (const code of ALL_JOB_RESULT_CODES) {
      const buckets = [isDone(code), isRetry(code), isDead(code)].filter(Boolean);
      expect(buckets.length, `code ${code} must be in exactly one bucket`).toBe(1);
    }
  });

  it("ALL_JOB_RESULT_CODES matches the union exhaustively (compile-time + runtime)", () => {
    // A compile-time exhaustiveness switch: adding a new union member without
    // adding it here fails typecheck.
    const seen = new Set<JobResultCode>();
    for (const code of ALL_JOB_RESULT_CODES) {
      switch (code) {
        case "ok":
        case "ok_noop_superseded":
        case "ok_noop_no_active_link":
        case "ok_noop_tombstone_deleted":
        case "retry_transient":
        case "retry_rate_limited":
        case "retry_ineligible":
        case "terminal_reconnect_required":
        case "terminal_insufficient_scope":
        case "terminal_conflict":
        case "terminal_dead":
          seen.add(code);
          break;
        default: {
          const _exhaustive: never = code;
          void _exhaustive;
        }
      }
    }
    expect(seen.size).toBe(11);
    expect(ALL_JOB_RESULT_CODES.length).toBe(11);
    expect(new Set(ALL_JOB_RESULT_CODES).size).toBe(11); // no dups
  });
});

describe("resultToRpcParams", () => {
  const done = (code: JobResultCode): JobResult => ({ code });

  it("done codes map to ok=true, no message, no backoff", () => {
    for (const code of ALL_JOB_RESULT_CODES.filter(isDone)) {
      const p = resultToRpcParams(done(code), 60);
      expect(p.ok).toBe(true);
      expect(p.errorMessage).toBeNull();
      expect(p.retryAfterSeconds).toBeNull();
    }
  });

  it("retry codes map to ok=false with a bounded backoff and a short error code", () => {
    const p = resultToRpcParams({ code: "retry_transient", errorCode: "google_http_503" }, 137);
    expect(p.ok).toBe(false);
    expect(p.errorCode).toBe("google_http_503");
    expect(p.retryAfterSeconds).toBe(137);
    expect(p.errorMessage).toBeNull();
  });

  it("rate-limited carries the caller Retry-After (bounded)", () => {
    const p = resultToRpcParams({ code: "retry_rate_limited", retryAfterSeconds: 900 }, 30);
    expect(p.ok).toBe(false);
    expect(p.retryAfterSeconds).toBe(900);
  });

  it("backoff is clamped to [5, 21600]", () => {
    expect(resultToRpcParams({ code: "retry_transient" }, 1).retryAfterSeconds).toBe(5);
    expect(resultToRpcParams({ code: "retry_transient" }, 999999).retryAfterSeconds).toBe(21600);
  });

  it("terminal codes map to ok=false at a bounded backoff (RPC deads at the cap)", () => {
    for (const code of ALL_JOB_RESULT_CODES.filter(isDead)) {
      const p = resultToRpcParams({ code }, 60);
      expect(p.ok).toBe(false);
      expect(p.retryAfterSeconds).toBeGreaterThanOrEqual(5);
      expect(p.retryAfterSeconds).toBeLessThanOrEqual(21600);
    }
  });

  it("error codes are capped to 64 chars", () => {
    const p = resultToRpcParams({ code: "retry_transient", errorCode: "x".repeat(200) }, 60);
    expect((p.errorCode ?? "").length).toBeLessThanOrEqual(64);
  });
});
