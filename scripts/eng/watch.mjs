#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ENG-LOOP-01: the bounded watch behind `npm run eng -- shepherd <pr> --watch`.
//
// CLAUDE.md §4's watcher rules, made mechanical:
//
//   * report when the state SETTLES - anything but WAITING - not on every poll;
//   * a superseded head's watcher terminates: when the head moves, this watch
//     ends (HEAD_CHANGED) and the caller starts a new one for the new head;
//   * every watch is BOUNDED - a total time limit, a no-progress limit and a
//     consecutive read-failure limit. A hard limit must exceed what it guards,
//     so NO_PROGRESS waits 25 minutes: longer than the 18-minute hard timeout
//     of the slowest CI lane, so a lane that is merely slow is never read as
//     a stuck one.
//
// It owns no decision. Each poll is one `observe(now)` - collect, then
// interpret - and this loop decides only when to stop looking. The clock and
// the sleep are injected, so tests run whole watches without waiting.
//
// One thing it deliberately does NOT do: enforce "exactly one watcher per PR
// head" across processes. That would need a lock file - durable state - which
// this slice does not add. The rule stays an operator discipline.
// ---------------------------------------------------------------------------

import { EXIT_CODE, STATE, UNKNOWN } from "./shepherd.mjs";

export const WATCH_DEFAULTS = Object.freeze({
  intervalMs: 60_000,
  maxMs: 60 * 60_000,
  noProgressMs: 25 * 60_000,
  maxReadFailures: 3,
});

/** Accepted ranges for the CLI flags, so a watch cannot be made unbounded. */
export const WATCH_LIMITS = Object.freeze({
  intervalSeconds: Object.freeze([30, 600]),
  maxMinutes: Object.freeze([1, 240]),
});

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Progress is any change in state, head, signals, or which lanes are moving. */
export function fingerprint(result) {
  const c = result.detail.ci;
  return JSON.stringify([
    result.state,
    result.head,
    result.signals,
    c.running,
    c.queued,
    c.failed,
    c.cancelled,
    result.detail.review.requestsAtHead ?? null,
  ]);
}

/**
 * Poll until something a person or agent must act on happens, or a bound is
 * hit. Returns the last result read and how the watch ended:
 *
 *   SETTLED        the state is no longer WAITING
 *   HEAD_CHANGED   the head this watch was started for has been superseded
 *   NO_PROGRESS    nothing changed for `noProgressMs` while waiting
 *   READ_FAILURES  `maxReadFailures` consecutive reads were incomplete
 *   TIME_BOUND     the next poll would pass `maxMs`
 *
 * A read with any unavailable surface counts as a FAILED read here. One-shot
 * mode reports such a read as UNKNOWN; a watch retries it instead of ending on
 * a transient blip, and gives up after a bounded number of tries.
 */
export async function watchPr({
  observe,
  now = Date.now,
  sleep = defaultSleep,
  intervalMs = WATCH_DEFAULTS.intervalMs,
  maxMs = WATCH_DEFAULTS.maxMs,
  noProgressMs = WATCH_DEFAULTS.noProgressMs,
  maxReadFailures = WATCH_DEFAULTS.maxReadFailures,
  onChange = () => {},
}) {
  const startedAt = now();
  const transitions = [];
  let polls = 0;
  let failures = 0;
  let last = null;
  let lastPrint = null;
  let lastChangeAt = startedAt;
  let startHead = null;
  let lastError = null;
  const limits = { intervalMs, maxMs, noProgressMs, maxReadFailures };
  const end = (terminatedBy, result) => ({
    result,
    watch: { terminatedBy, polls, elapsedMs: now() - startedAt, startHead, transitions, lastError, limits },
  });

  for (;;) {
    polls += 1;
    let result = null;
    try {
      result = observe(now());
    } catch (err) {
      lastError = String(err?.message ?? err);
    }

    if (result && result.head !== UNKNOWN) {
      if (startHead === null) startHead = result.head;
      else if (result.head !== startHead) return end("HEAD_CHANGED", result);
      if (result.signals.snapshot === "TORN") return end("HEAD_CHANGED", result);
    }

    if (result === null || result.unavailable.length > 0) {
      failures += 1;
      if (failures >= maxReadFailures) return end("READ_FAILURES", result ?? last);
    } else {
      failures = 0;
      last = result;
      const print = fingerprint(result);
      if (print !== lastPrint) {
        lastPrint = print;
        lastChangeAt = now();
        transitions.push({ at: new Date(lastChangeAt).toISOString(), state: result.state, head: result.head });
        onChange(result, lastChangeAt);
      }
      if (result.state !== STATE.WAITING) return end("SETTLED", result);
      if (now() - lastChangeAt >= noProgressMs) return end("NO_PROGRESS", result);
    }

    if (now() - startedAt + intervalMs > maxMs) return end("TIME_BOUND", result ?? last);
    await sleep(intervalMs);
  }
}

/** A watch that gave up needs a person, whatever the last state read was. */
export function watchExitCode({ result, watch }) {
  if (!result || watch.terminatedBy === "NO_PROGRESS" || watch.terminatedBy === "READ_FAILURES") {
    return EXIT_CODE[STATE.BLOCKED];
  }
  return result.exitCode;
}

export function describeWatchEnd({ result, watch }) {
  const minutes = Math.round(watch.elapsedMs / 60_000);
  const head = (sha) => (typeof sha === "string" ? sha.slice(0, 10) : UNKNOWN);
  const why = {
    SETTLED: `the state settled on ${result?.state}`,
    HEAD_CHANGED:
      `the head moved from ${head(watch.startHead)} (to ${head(result?.signals.snapshot === "TORN" ? result.detail.headAfter : result?.head)}); ` +
      "this watcher ends with its head. Start a new watch for the new head, and cancel the superseded run",
    NO_PROGRESS: `nothing changed for ${watch.limits.noProgressMs / 60_000} min while waiting - a stuck queue or a hung lane needs a person`,
    READ_FAILURES: `${watch.limits.maxReadFailures} consecutive reads were incomplete${watch.lastError ? ` (${watch.lastError})` : ""}`,
    TIME_BOUND: "the time bound was reached; start another watch if waiting is still right",
  }[watch.terminatedBy];
  return `WATCH ENDED ${watch.terminatedBy} after ${watch.polls} poll(s), ${minutes} min: ${why}.`;
}
