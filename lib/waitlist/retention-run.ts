import "server-only";
import { thrownErrorClass } from "@/lib/logging/error-class";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { runRetentionCleanup, ZERO_RETENTION_COUNTS, type RetentionRpcClient, type RetentionTick } from "@/lib/waitlist/retention-cleanup";
import { alertRetentionUnavailable, checkRetentionHealthAndAlert, raiseRetentionAlert } from "@/lib/waitlist/retention-health";

// 0326: what the daily routes call. Counts and classes only, in the response, the alert and the log. Never throws.

export type RetentionRunSummary =
  | { ok: true; skipped: "not_installed" }
  | { ok: true; calls: number; erasedAnswers: number; failedAnswers: number; purgeFailed: number; purgedEraseRecords: number; purgedOutbox: number; purgedRuns: number; remaining: number; stoppedEarly: boolean; partialFailure: boolean }
  | { ok: false; calls: number; erasedAnswers: number; failedAnswers: number; errorClass: string; failureRecorded: boolean };

export const RETENTION_RUN_ROUTE = "/api/cron/waitlist-decline-owner-email";

/** The 10:00 route's erase: run the tick, and raise the failed-run alert itself when it did not complete. */
export async function runRetentionForCron(
  makeClient: () => RetentionRpcClient = () => createAdminClient() as unknown as RetentionRpcClient,
): Promise<RetentionRunSummary> {
  let tick: RetentionTick;
  try {
    tick = await runRetentionCleanup(makeClient());
  } catch (e) {
    // runRetentionCleanup does not throw; this is a client that could not even be built.
    tick = { ok: false, calls: 0, counts: { ...ZERO_RETENTION_COUNTS }, errorClass: "route_error", failureRecorded: false };
    console.error(JSON.stringify({ event: "waitlist_retention_run_threw", err_class: thrownErrorClass(e), timestamp: new Date().toISOString() }));
  }
  if (!tick.ok) {
    await raiseRetentionAlert(
      "failed",
      "The scheduled erase of overdue waitlist answers failed during its daily run.",
      { error_class: tick.errorClass, calls: tick.calls, erased_answers: tick.counts.erasedAnswers, failure_recorded: tick.failureRecorded },
      RETENTION_RUN_ROUTE,
    );
    return { ok: false, calls: tick.calls, erasedAnswers: tick.counts.erasedAnswers, failedAnswers: tick.counts.failedAnswers, errorClass: tick.errorClass, failureRecorded: tick.failureRecorded };
  }
  if ("skipped" in tick) {
    // The functions are missing: quiet before anything depends on them, critical once answers are collected or owner email is active.
    await alertRetentionUnavailable("not_installed", RETENTION_RUN_ROUTE);
    return tick;
  }
  if (tick.partialFailure) {
    // Rows that fail to erase are skipped and retried next run, but a deadline is being missed: say so now, with a count and nothing else.
    await raiseRetentionAlert(
      "failed",
      `The scheduled erase of overdue waitlist answers finished with failures: ${tick.counts.failedAnswers} answers could not be erased and ${tick.counts.purgeFailed} clean-up steps failed.`,
      { last_outcome: "partial_failure", failed_answers: tick.counts.failedAnswers, purge_failed: tick.counts.purgeFailed, erased_answers: tick.counts.erasedAnswers, calls: tick.calls },
      RETENTION_RUN_ROUTE,
    );
  }
  return {
    ok: true,
    calls: tick.calls,
    erasedAnswers: tick.counts.erasedAnswers,
    failedAnswers: tick.counts.failedAnswers,
    purgeFailed: tick.counts.purgeFailed,
    partialFailure: tick.partialFailure,
    purgedEraseRecords: tick.counts.purgedEraseRecords,
    purgedOutbox: tick.counts.purgedOutbox,
    purgedRuns: tick.counts.purgedRuns,
    remaining: tick.remaining,
    stoppedEarly: tick.stoppedEarly,
  };
}

/** The three earlier daily crons call this after their own work. Best-effort: it can never change the route's result. */
export async function checkRetentionHealthForCron(route: string): Promise<void> {
  try {
    await checkRetentionHealthAndAlert(route);
  } catch (e) {
    console.error(JSON.stringify({ event: "waitlist_retention_health_check_threw", route, err_class: thrownErrorClass(e), timestamp: new Date().toISOString() }));
  }
}
