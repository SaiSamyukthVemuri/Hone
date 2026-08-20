import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// The request collector — the part that had never executed.
//
// perf-timing accumulates spans in a per-request store obtained from React
// `cache()` and flushes ONE structured line per request via `after()`. Neither
// mechanism works outside a server request: `cache()` returns a fresh value per
// call and `after()` throws. So the other two suites — and therefore seven
// rounds of review — only ever exercised the degraded path, one span per store,
// flushed synchronously. Everything that makes the emitted artefact worth
// producing was unreached: multi-span accumulation, `seq` past 1, the
// flushScheduled guard, the MAX_SPANS cap, and the `after()` success path.
//
// This file supplies the two host behaviours so the real path runs:
//   * `cache()` memoises for as long as a "request" lasts, which is what the
//     Flight server's AsyncLocalStorage does per request;
//   * `after()` defers to a queue drained at end of request, which is what
//     Vercel's waitUntil does.
//
// Both mocks are deliberately faithful rather than convenient: if the module
// stops relying on either, these tests should be the ones that notice.
// ===========================================================================

const host = vi.hoisted(() => ({
  /** One entry per cached factory, cleared when a request ends. */
  cached: new Map<unknown, unknown>(),
  /** Work deferred by `after()`, drained at end of request. */
  deferred: [] as Array<() => void>,
  /** Set true to simulate a runtime where `after()` is unavailable. */
  afterUnavailable: false,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    cache: (factory: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) => {
        if (!host.cached.has(factory)) {
          host.cached.set(factory, factory(...args));
        }
        return host.cached.get(factory);
      },
  };
});

vi.mock("next/server", () => ({
  after: (work: () => void) => {
    if (host.afterUnavailable) {
      throw new Error("`after` was called outside a request scope.");
    }
    host.deferred.push(work);
  },
}));

const { PERF_SPAN_IDS, startPerfSpan, timed } = await import(
  "@/lib/observability/perf-timing"
);

type Payload = Record<string, unknown>;

const written: string[] = [];
/**
 * How many upcoming console.error calls must throw.
 *
 * TWO is the number that matters: emitStructured() has its own inner
 * try/catch whose fallback is a SECOND console.error, so a mock that throws
 * once is swallowed there and flush() never sees an exception. An earlier
 * version of the regression test below did exactly that and passed against
 * the very bug it was written to catch.
 */
let sinkThrowsFor = 0;
let errorSpy: { mockRestore: () => void };
const originalFlag = process.env.HONE_PERF_TIMING;

/** Begin a fresh request: new cache scope, empty deferred queue. */
function beginRequest(): void {
  host.cached.clear();
  host.deferred.length = 0;
}

/** End the request, running whatever `after()` deferred. */
function endRequest(): void {
  const queue = [...host.deferred];
  host.deferred.length = 0;
  for (const work of queue) work();
}

function lines(): Payload[] {
  return written
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Payload);
}

beforeEach(() => {
  written.length = 0;
  sinkThrowsFor = 0;
  host.afterUnavailable = false;
  errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      if (sinkThrowsFor > 0) {
        sinkThrowsFor -= 1;
        throw new Error("stderr unavailable");
      }
      written.push(String(args[0]));
    });
  process.env.HONE_PERF_TIMING = "1";
  beginRequest();
});

afterEach(() => {
  errorSpy.mockRestore();
  if (originalFlag === undefined) delete process.env.HONE_PERF_TIMING;
  else process.env.HONE_PERF_TIMING = originalFlag;
});

describe("one request produces one line", () => {
  it("accumulates every span of a request into a single summary", async () => {
    // The shape of a real authenticated navigation.
    await timed("shell.identity", async () => "a");
    await timed("shell.memberships", async () => "b");
    await timed("shell.support-reads", async () => "c");
    await timed("client-profile.identity", async () => "d");
    const domain = startPerfSpan("client-profile.domain");
    domain.end();

    // Nothing is emitted until the response is done.
    expect(lines()).toHaveLength(0);

    endRequest();

    const all = lines();
    expect(all).toHaveLength(1);
    const summary = all[0];
    expect(summary.span_count).toBe(5);
    expect(summary.surface).toBe("client-profile");
    // THE measurement this PR exists to produce: one request, two independent
    // identity resolutions plus a third membership read.
    expect(summary.identity_resolutions).toBe(2);
    expect(summary.membership_resolutions).toBe(1);
  });

  it("numbers spans in completion order within the request", async () => {
    await timed("shell.identity", async () => "a");
    await timed("shell.memberships", async () => "b");
    await timed("records.identity", async () => "c");
    endRequest();

    const spans = lines()[0].spans as Array<Record<string, unknown>>;
    expect(spans.map((s) => s.seq)).toEqual([1, 2, 3]);
    expect(spans.map((s) => s.span)).toEqual([
      "shell.identity",
      "shell.memberships",
      "records.identity",
    ]);
  });

  it("schedules exactly one flush no matter how many spans run", async () => {
    for (const span of PERF_SPAN_IDS) {
      await timed(span, async () => "x");
    }
    // The flushScheduled guard: many spans, one deferred flush.
    expect(host.deferred).toHaveLength(1);

    endRequest();
    expect(lines()).toHaveLength(1);
    expect(lines()[0].span_count).toBe(PERF_SPAN_IDS.length);
  });

  it("keeps separate requests in separate lines", async () => {
    await timed("clients.identity", async () => "a");
    endRequest();

    beginRequest();
    await timed("calendar.identity", async () => "b");
    await timed("calendar.domain", async () => "c");
    endRequest();

    const all = lines();
    expect(all).toHaveLength(2);
    expect(all[0].span_count).toBe(1);
    expect(all[0].surface).toBe("clients");
    expect(all[1].span_count).toBe(2);
    expect(all[1].surface).toBe("calendar");
    // No bleed: request 2 must not carry request 1's span.
    const secondSpans = all[1].spans as Array<Record<string, unknown>>;
    expect(secondSpans.map((s) => s.span)).toEqual([
      "calendar.identity",
      "calendar.domain",
    ]);
  });
});

describe("the per-request span cap", () => {
  it("bounds retained spans and reports what it dropped", async () => {
    // MAX_SPANS_PER_REQUEST is 64. No real surface emits anywhere near this;
    // the cap exists so a future caller in a loop cannot grow a request's
    // memory without bound, and the drop must be VISIBLE, not silent.
    for (let i = 0; i < 70; i += 1) {
      await timed("records.domain", async () => i);
    }
    endRequest();

    const summary = lines()[0];
    expect(summary.span_count).toBe(64);
    expect(summary.dropped_spans).toBe(6);
  });
});

describe("a failing emit does not disable the collector", () => {
  it("re-arms after the flush throws, instead of latching dead", async () => {
    // Regression test. The resets used to sit after emitStructured INSIDE the
    // try, so a throwing emit left flushScheduled set and scheduleFlush()
    // early-returned for the rest of the request — every later span then
    // accumulated to the cap and vanished with no trace at all.
    // Both the primary emit AND emitStructured's fallback must fail, or the
    // exception never escapes to flush() and this test proves nothing.
    sinkThrowsFor = 2;
    await timed("shell.identity", async () => "a");
    endRequest();
    expect(lines()).toHaveLength(0); // the throwing emit produced nothing

    // Same request continues. The collector must still work.
    await timed("clients.domain", async () => "b");
    expect(host.deferred).toHaveLength(1);
    endRequest();

    const all = lines();
    expect(all).toHaveLength(1);
    expect(all[0].span_count).toBe(1);
    expect((all[0].spans as Array<Record<string, unknown>>)[0].span).toBe(
      "clients.domain",
    );
  });
});

describe("when after() is unavailable", () => {
  it("still emits, flushing synchronously per span", async () => {
    // The documented degraded path: no post-response hook, so each span
    // flushes inline. Coverage matters because it is what every OTHER test
    // file in this suite is unknowingly exercising.
    host.afterUnavailable = true;

    await timed("shell.identity", async () => "a");
    await timed("clients.domain", async () => "b");

    // No endRequest() needed — the fallback already ran.
    const all = lines();
    expect(all).toHaveLength(2);
    expect(all[0].span_count).toBe(1);
    expect(all[1].span_count).toBe(1);
    // Honest limitation, pinned so it is not mistaken for a regression: in
    // this mode a request is FRAGMENTED across lines, so identity_resolutions
    // reads 1 per line rather than 2 for the request. Per-span durations stay
    // correct; only the per-request rollup is unavailable.
    expect(all[0].identity_resolutions).toBe(1);
  });
});
