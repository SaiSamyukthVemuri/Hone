import "server-only";
import { cache } from "react";
import { after } from "next/server";
import * as Sentry from "@sentry/nextjs";

// ===========================================================================
// Authenticated route timing baseline (measurement only)
// ===========================================================================
//
// WHY THIS EXISTS
// ---------------
// A read-only audit produced round-trip COUNTS for the authenticated
// surfaces but could not produce durations: nothing in the repository
// measures per-route or per-phase server time outside the two cron routes
// (app/api/cron/calendar-reconcile/route.ts, lib/cron/reminder-heartbeat.ts).
// This module is the smallest primitive that turns those counts into
// evidence, so the NEXT change can be argued from measurement instead of
// from shape.
//
// It optimises nothing. It caches no query result. It changes no control
// flow. Every recorded value is a duration, an outcome word, or a
// compile-time-fixed span name.
//
// WHAT IT IS NOT
// --------------
//   * NOT a new observability vendor. Output goes to the same two sinks the
//     repo already uses: a structured single-line JSON log to stderr (the
//     lib/ops/alerts.ts convention, which is the floor for Vercel-log-only
//     debugging) and, when a trace is being sampled, a Sentry span.
//   * NOT per-query instrumentation. Spans are COARSE and their names are a
//     closed union (PerfSpanId below). One request emits ONE log line
//     carrying a handful of spans, never one event per query.
//   * NOT a request cache. `cache()` is used for exactly one thing: to
//     allocate one collector object per request so spans from the shell
//     layout and the page land in the same summary. No query, no auth
//     result, and no studio row passes through it.
//
// PRIVACY POSTURE (deny by default, by construction)
// --------------------------------------------------
// The only caller-supplied value this module accepts is a span id. There is
// no free-text field, no `details` bag, no id parameter, and no URL/pathname
// capture anywhere in the payload. That last point is load-bearing: an
// authenticated pathname such as `/clients/<uuid>` IS a client identifier, so
// the surface is derived from the span name's own prefix and the real path is
// never read.
//
// The span id is constrained TWICE, and the second one is the guarantee:
//
//   1. at compile time by PerfSpanId, a closed string-literal union;
//   2. at RUNTIME by the KNOWN_SPAN_IDS allowlist below.
//
// The second exists because the first is not a privacy control. TypeScript
// admits `any` into a string-literal union with no cast, so an ordinary
// refactor that routes a value from `JSON.parse` — or any untyped shape —
// into a span name type-checks cleanly. Rejecting the value where it is used
// closes that no matter how it arrived. lib/analytics/server.ts allowlists
// event properties at runtime for exactly the same reason.
//
// So a caller cannot get a client name, an email, an appointment id, a note,
// a provider payload or a secret into this telemetry: there is no parameter
// that would carry one, and a value that is not on the allowlist is dropped
// without ever being logged.
//
// ENABLEMENT
// ----------
// Off unless HONE_PERF_TIMING === "1". One rule, no environment-dependent
// behaviour, so what runs locally is what runs on Vercel. Disabled is a true
// passthrough: one env read, then the callback's own result, with nothing
// recorded and no span or collector created. It is not literally
// allocation-free — `timed` is an async function, so the disabled branch still
// allocates the wrapper promise that adopts `fn()`'s; `startPerfSpan` returns
// a shared INERT_SPAN and allocates nothing. The operator turns it on for a
// measurement window and off again; nothing here is intended to run
// permanently.
//
// FAILURE POSTURE
// ---------------
// Instrumentation may never become the reason a page fails. Every recording
// path is try/catch'd and swallowing. The ONLY exception that leaves this
// module is one the instrumented callback itself threw, re-thrown unchanged
// so Next's redirect() / notFound() control-flow signals keep working.

/**
 * Every span this codebase may record, as `<surface>.<phase>`.
 *
 * Adding an entry is a deliberate act: it is the only way to introduce a new
 * telemetry name, and the union is what makes a free-text (and therefore
 * potentially identifying) span name impossible.
 */
export const PERF_SPAN_IDS = [
  // The authenticated app shell — the cost every navigation pays before the
  // page's own work begins.
  "shell.identity",
  "shell.memberships",
  "shell.support-reads",
  // Per-surface page work. `.identity` is the page's own practitioner/studio
  // resolution; `.domain` is everything the page reads for its own content.
  "clients.identity",
  "clients.domain",
  "client-profile.identity",
  "client-profile.domain",
  "calendar.identity",
  "calendar.domain",
  "records.identity",
  "records.domain",
] as const;

export type PerfSpanId = (typeof PERF_SPAN_IDS)[number];

/**
 * The same names as a runtime set. THE PRIMARY PRIVACY CONTROL.
 *
 * The compile-time union is necessary but NOT sufficient, and assuming
 * otherwise was a real error in an earlier revision of this file. TypeScript
 * lets `any` satisfy a string-literal union with no cast at all, so
 *
 *     const fns = { m: timed };
 *     const cfg = JSON.parse(payload);   // any
 *     fns.m(cfg.span, run);              // compiles under --strict
 *
 * type-checks and would emit an attacker- or accident-supplied span name.
 * `any` arrives through ordinary untyped data — a JSON parse, an untyped
 * third-party shape — so this is a refactor hazard, not a deliberate bypass.
 *
 * Checking the value where it is USED closes that regardless of how it got
 * here, which no amount of static call-site analysis can do. This mirrors
 * lib/analytics/server.ts, which allowlists event properties at runtime for
 * exactly the same reason: a compile-time contract is not a privacy control.
 */
const KNOWN_SPAN_IDS: ReadonlySet<string> = new Set(PERF_SPAN_IDS);

/** Coarse surface label. Derived from the span id, never from a real path. */
export type PerfSurface =
  | "shell"
  | "clients"
  | "client-profile"
  | "calendar"
  | "records";

/**
 * How a span finished. `threw` covers a real error AND Next's control-flow
 * signals (redirect / notFound), which are thrown values — so a `threw`
 * identity span on a logged-out request is expected, not an incident.
 */
type PerfOutcome = "ok" | "threw";

type PerfSpanRecord = {
  span: PerfSpanId;
  /** 1-based order of completion within the request. */
  seq: number;
  duration_ms: number;
  outcome: PerfOutcome;
};

type PerfStore = {
  spans: PerfSpanRecord[];
  completed: number;
  dropped: number;
  flushScheduled: boolean;
};

/**
 * Hard cap on spans held per request. The instrumented surfaces emit fewer
 * than ten; this only exists so a future caller in a loop cannot grow a
 * request's memory without bound. Overflow is counted, never silently lost.
 */
const MAX_SPANS_PER_REQUEST = 64;

/** Sentry span operation. Static; groups these spans in a trace waterfall. */
const SENTRY_OP = "hone.perf";

/** Structured log event name, greppable in Vercel logs. */
const LOG_EVENT = "perf_route_timing";

/** Enabled only by explicit opt-in. See ENABLEMENT above. */
export function isPerfTimingEnabled(): boolean {
  return process.env.HONE_PERF_TIMING === "1";
}

/**
 * Refuse a span name that is not on the allowlist.
 *
 * The rejected VALUE is never logged, because that value is precisely what
 * might be a client name, an email or a note — logging it to report the
 * problem would be the leak. Only the event name goes out, matching
 * `warnNameOnly` in lib/analytics/server.ts.
 */
function rejectUnknownSpan(): void {
  try {
    console.warn(JSON.stringify({ event: "perf_span_rejected" }));
  } catch {
    // Never escalate from the rejection path either.
  }
}

/** True only for a span name this module is allowed to emit. */
function isKnownSpan(span: string): boolean {
  return KNOWN_SPAN_IDS.has(span);
}

/**
 * One collector per request.
 *
 * React's `cache()` scopes the value to a single server request, which is
 * what makes "how many times did THIS request resolve identity?" answerable.
 * Outside a request scope (unit tests, scripts) `cache()` neither throws nor
 * dedupes — it simply returns a fresh object per call — so the degraded
 * behaviour is one summary per span rather than one per request. That is a
 * fine degradation and it is why nothing here needs a test-only back door.
 */
const requestStore = cache(
  (): PerfStore => ({
    spans: [],
    completed: 0,
    dropped: 0,
    flushScheduled: false,
  }),
);

/**
 * The surface a span belongs to, taken from its own name.
 *
 * Deliberately NOT derived from `headers()` or a route pathname: those carry
 * client ids on the authenticated surfaces this module measures.
 */
export function surfaceOf(span: PerfSpanId): PerfSurface {
  const prefix = span.slice(0, span.indexOf("."));
  return prefix as PerfSurface;
}

function phaseOf(span: PerfSpanId): string {
  return span.slice(span.indexOf(".") + 1);
}

/**
 * Build the structured summary payload for a request's spans.
 *
 * Pure: no clock read beyond the caller-supplied timestamp, no I/O, no
 * global state. Exported so the payload's shape and its privacy properties
 * are proved directly rather than through a console spy.
 */
export function buildPerfSummary(
  spans: readonly PerfSpanRecord[],
  dropped: number,
  timestamp: string,
): Record<string, unknown> {
  let identityResolutions = 0;
  let membershipResolutions = 0;
  let identityTotalMs = 0;
  let membershipTotalMs = 0;
  let domainTotalMs = 0;
  let shellTotalMs = 0;

  // The page surface, if this request rendered one. The shell runs on every
  // navigation, so it is the fallback rather than the answer.
  let pageSurface: PerfSurface | null = null;

  for (const record of spans) {
    const surface = surfaceOf(record.span);
    const phase = phaseOf(record.span);

    if (surface === "shell") {
      shellTotalMs += record.duration_ms;
    } else {
      pageSurface = surface;
    }

    if (phase === "identity") {
      identityResolutions += 1;
      identityTotalMs += record.duration_ms;
    } else if (phase === "memberships") {
      membershipResolutions += 1;
      // Its OWN bucket. Folding this into identityTotalMs made the obvious
      // operator computation `identity_total_ms / identity_resolutions` wrong,
      // because membership time was in the numerator and not the denominator —
      // an overstatement of the exact quantity this PR exists to measure.
      membershipTotalMs += record.duration_ms;
    } else if (phase === "domain") {
      domainTotalMs += record.duration_ms;
    }
  }

  return {
    event: LOG_EVENT,
    perf_timing: true,
    surface: pageSurface ?? "shell",
    // How many times this ONE request resolved practitioner/studio identity.
    // The audit hypothesis is that this is >1 on every authenticated
    // navigation; this field is the measurement that settles it.
    identity_resolutions: identityResolutions,
    membership_resolutions: membershipResolutions,
    // PHASE totals. identity_total_ms covers exactly the `.identity` spans
    // counted by identity_resolutions, so dividing one by the other is valid.
    identity_total_ms: Math.round(identityTotalMs),
    membership_total_ms: Math.round(membershipTotalMs),
    domain_total_ms: Math.round(domainTotalMs),
    // SURFACE total, an ORTHOGONAL projection: it re-counts whichever of the
    // above ran in the shell. The phase totals and shell_total_ms therefore
    // OVERLAP and must not be summed. Per-span values live in `spans`.
    shell_total_ms: Math.round(shellTotalMs),
    span_count: spans.length,
    dropped_spans: dropped,
    spans: spans.map((record) => ({
      span: record.span,
      seq: record.seq,
      duration_ms: record.duration_ms,
      outcome: record.outcome,
    })),
    timestamp,
  };
}

/**
 * Structured single-line JSON to stderr — the lib/ops/alerts.ts convention.
 * Never throws.
 */
function emitStructured(payload: Record<string, unknown>): void {
  try {
    console.error(JSON.stringify(payload));
  } catch {
    // Last-resort fallback, mirroring structuredConsoleLog in lib/ops/alerts.ts.
    console.error("perf_timing_serialize_failed");
  }
}

function flush(store: PerfStore): void {
  if (store.spans.length === 0) return;
  try {
    emitStructured(
      buildPerfSummary(store.spans, store.dropped, new Date().toISOString()),
    );
  } catch {
    // Telemetry must never escalate.
  } finally {
    // In `finally`, not after the emit: if emitting throws, leaving
    // flushScheduled set would make scheduleFlush() early-return for the rest
    // of the request, so every later span would accumulate to the cap and be
    // dropped in silence. Resetting unconditionally re-arms the collector.
    store.spans = [];
    store.dropped = 0;
    store.flushScheduled = false;
  }
}

/**
 * Flush post-response where the framework allows it, synchronously otherwise.
 *
 * Mirrors `schedule()` in lib/analytics/server.ts. The work is pure CPU
 * (serialise + log), so the fallback is deliberately synchronous: there is no
 * dangling promise for a test — or a serverless freeze — to lose.
 */
function scheduleFlush(store: PerfStore): void {
  if (store.flushScheduled) return;
  store.flushScheduled = true;
  try {
    after(() => flush(store));
  } catch {
    // Out of request scope, or `after()` unavailable in this runtime.
    flush(store);
  }
}

function record(
  span: PerfSpanId,
  durationMs: number,
  outcome: PerfOutcome,
): void {
  try {
    const store = requestStore();
    store.completed += 1;
    if (store.spans.length >= MAX_SPANS_PER_REQUEST) {
      store.dropped += 1;
      return;
    }
    store.spans.push({
      span,
      seq: store.completed,
      // Monotonic source, rounded: durations are compared, never displayed to
      // sub-millisecond precision, and a rounded integer keeps the log line
      // small and diffable.
      duration_ms: Math.round(durationMs),
      outcome,
    });
    scheduleFlush(store);
  } catch {
    // A collector failure must never surface to the instrumented page.
  }
}

/**
 * Run `fn` inside a Sentry span when tracing is available — exactly once, and
 * never letting the SDK's own failure become the caller's failure.
 *
 * Three things can go wrong, and they need three different answers:
 *
 *   1. the SDK throws BEFORE our callback ran   -> run the work, unmeasured;
 *   2. our callback itself threw or rejected    -> that is the caller's error,
 *                                                  propagate it untouched;
 *   3. the SDK throws AFTER our callback ran    -> the work already produced
 *                                                  its result; a telemetry bug
 *                                                  must not discard it.
 *
 * Tracking only "did the callback start?" collapses 2 and 3 and gets one of
 * them wrong: it either re-runs a page's database reads or fails a page that
 * had already succeeded. Capturing the callback's own promise separates them,
 * because that promise IS the authoritative outcome of the work in both cases.
 */
async function runWithSentrySpan<T>(
  span: PerfSpanId,
  fn: () => Promise<T>,
): Promise<T> {
  const startSpan = (
    Sentry as unknown as {
      startSpan?: (
        options: { name: string; op: string },
        callback: () => Promise<T>,
      ) => Promise<T>;
    }
  )?.startSpan;

  if (typeof startSpan !== "function") return fn();

  let started = false;
  let work: Promise<T> | undefined;
  try {
    return await startSpan({ name: span, op: SENTRY_OP }, () => {
      started = true;
      work = fn();
      return work;
    });
  } catch (err) {
    // Case 1: the SDK never reached our callback.
    if (!started) return fn();
    // Case 3: the work ran. Its own promise decides the outcome, whether that
    // is a value or a rejection — the SDK's error is discarded, not surfaced.
    if (work !== undefined) return work;
    // Case 2 with a SYNCHRONOUS throw from fn(), so no promise was ever
    // assigned. That error is the caller's and is re-thrown unchanged.
    throw err;
  }
}

/**
 * Begin a Sentry span for a BRACKETED region.
 *
 * `Sentry.startSpan` is callback-scoped and cannot express a region that ends
 * somewhere else in a function body, so the bracket form uses the inactive-span
 * API instead. Without this, the `.domain` phases — which are the main
 * page-work windows and the whole point of the waterfall — would appear in the
 * structured log but be missing from every sampled trace.
 *
 * Returns null whenever the SDK is absent or unhappy; callers treat that as
 * "unmeasured in Sentry", never as an error.
 */
function beginInactiveSentrySpan(span: PerfSpanId): { end?: () => void } | null {
  try {
    const startInactiveSpan = (
      Sentry as unknown as {
        startInactiveSpan?: (options: { name: string; op: string }) => {
          end?: () => void;
        };
      }
    )?.startInactiveSpan;
    if (typeof startInactiveSpan !== "function") return null;
    return startInactiveSpan({ name: span, op: SENTRY_OP }) ?? null;
  } catch {
    return null;
  }
}

function endInactiveSentrySpan(span: { end?: () => void } | null): void {
  try {
    span?.end?.();
  } catch {
    // A telemetry span that cannot close is not the page's problem.
  }
}

/**
 * Measure an awaited unit of work.
 *
 * Returns exactly what `fn` returns and re-throws exactly what `fn` throws,
 * so wrapping a call is behaviour-preserving:
 *
 *   const { studio } = await timed("clients.identity", () =>
 *     getCurrentPractitionerWithStudio(),
 *   );
 */
export async function timed<T>(
  span: PerfSpanId,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isPerfTimingEnabled()) return fn();
  // The type says this cannot happen; `any` says otherwise. The work still
  // runs — instrumentation never changes behaviour — it is just unmeasured.
  if (!isKnownSpan(span)) {
    rejectUnknownSpan();
    return fn();
  }

  const startedAt = performance.now();
  try {
    const result = await runWithSentrySpan(span, fn);
    record(span, performance.now() - startedAt, "ok");
    return result;
  } catch (err) {
    record(span, performance.now() - startedAt, "threw");
    throw err;
  }
}

/** Handle returned by {@link startPerfSpan}. `end()` is idempotent. */
export type PerfSpanHandle = { end: () => void };

/** A handle that records nothing, used when timing is disabled. */
const INERT_SPAN: PerfSpanHandle = { end: () => {} };

/**
 * Bracket a REGION of an existing function without restructuring it.
 *
 * Some surfaces do their domain reads as a long run of statements rather than
 * one call. Wrapping those in a closure to fit `timed()` would be a real code
 * change on a clinical page for a measurement PR, so this form exists
 * instead:
 *
 *   const domain = startPerfSpan("client-profile.domain");
 *   ... existing statements, completely untouched ...
 *   domain.end();
 *
 * If the region throws before `end()`, neither the summary record nor the
 * Sentry span is closed — the inactive span is simply abandoned and dropped
 * with its transaction. That is the correct trade for telemetry: an
 * unrecorded span is a gap in a chart, whereas a `finally` here would add a
 * control-flow construct to a page this PR has no business restructuring.
 */
export function startPerfSpan(span: PerfSpanId): PerfSpanHandle {
  if (!isPerfTimingEnabled()) return INERT_SPAN;
  // Same allowlist as `timed()`; see KNOWN_SPAN_IDS.
  if (!isKnownSpan(span)) {
    rejectUnknownSpan();
    return INERT_SPAN;
  }

  const startedAt = performance.now();
  const sentrySpan = beginInactiveSentrySpan(span);
  let ended = false;
  return {
    end: () => {
      if (ended) return;
      ended = true;
      endInactiveSentrySpan(sentrySpan);
      record(span, performance.now() - startedAt, "ok");
    },
  };
}
