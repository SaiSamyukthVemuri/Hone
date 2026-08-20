import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PERF_SPAN_IDS,
  buildPerfSummary,
  isPerfTimingEnabled,
  startPerfSpan,
  surfaceOf,
  timed,
  type PerfSpanId,
} from "@/lib/observability/perf-timing";

// ===========================================================================
// perf-timing: the measurement primitive behind perf/route-timing-baseline.
//
// The contract under test is deliberately narrow, because the whole point of
// the module is that it changes nothing:
//
//   * it records DURATIONS and nothing that could identify a person;
//   * it never throws on behalf of the telemetry backend;
//   * nested and concurrent spans cannot corrupt one another;
//   * a free-text (and therefore potentially identifying) span name does not
//     compile;
//   * the instrumented callback's return value and thrown value are passed
//     through untouched, exactly once.
//
// HOW THE FLUSH BEHAVES IN A TEST
// -------------------------------
// `after()` throws outside a request scope (verified: "`after` was called
// outside a request scope"), so the module's documented fallback runs the
// flush SYNCHRONOUSLY. React's `cache()` likewise does not dedupe outside a
// request, so each span gets its own collector. Net effect under vitest: one
// structured line per span, emitted synchronously as the span ends. That is
// what makes these assertions deterministic with no timers or flushing.
// ===========================================================================

/** Values that must never be able to reach telemetry. */
const CLIENT_NAME = "Nadia Fairbairn";
const CLIENT_EMAIL = "nadia.fairbairn@example.com";
const APPOINTMENT_ID = "6b1f2c9e-7a53-4c31-9d0e-8f2a1b4c5d6e";
const CLINICAL_NOTE = "upper lip, thermolysis 0.733s, mild erythema";

type Emitted = { line: string; payload: Record<string, unknown> };

/** Every line the module wrote to stderr during the current test. */
const written: string[] = [];
/** Set by a test that needs the log sink itself to fail. */
let sinkThrows = false;

let errorSpy: { mockRestore: () => void };
const originalFlag = process.env.HONE_PERF_TIMING;

function enable(): void {
  process.env.HONE_PERF_TIMING = "1";
}

function disable(): void {
  delete process.env.HONE_PERF_TIMING;
}

/** Every structured line captured so far, parsed. */
function emitted(): Emitted[] {
  return written
    .filter((line) => line.startsWith("{"))
    .map((line) => ({
      line,
      payload: JSON.parse(line) as Record<string, unknown>,
    }));
}

/** The single span record inside a one-span summary line. */
function onlySpan(entry: Emitted): Record<string, unknown> {
  const spans = entry.payload.spans as Record<string, unknown>[];
  expect(spans).toHaveLength(1);
  return spans[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  written.length = 0;
  sinkThrows = false;
  errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      if (sinkThrows) throw new Error("stderr unavailable");
      written.push(String(args[0]));
    });
  enable();
});

afterEach(() => {
  errorSpy.mockRestore();
  if (originalFlag === undefined) disable();
  else process.env.HONE_PERF_TIMING = originalFlag;
});

// ---------------------------------------------------------------------------
// 1. Records duration, carries no PII.
// ---------------------------------------------------------------------------

describe("records duration without PII", () => {
  it("emits a duration that reflects real elapsed time", async () => {
    const result = await timed("clients.domain", async () => {
      await sleep(25);
      return "done";
    });

    expect(result).toBe("done");
    const span = onlySpan(emitted()[0]);
    expect(typeof span.duration_ms).toBe("number");
    // Generous lower bound: proves the value is measured, not a placeholder,
    // without making the test sensitive to timer scheduling.
    expect(span.duration_ms as number).toBeGreaterThanOrEqual(10);
    expect(Number.isInteger(span.duration_ms)).toBe(true);
  });

  it("cannot carry a client name, email, id, or note into the payload", async () => {
    // Every sensitive value the surrounding page would have in scope is put
    // through the instrumented callback: in the return value, in the closure,
    // and in a thrown error message.
    await timed("client-profile.domain", async () => ({
      name: CLIENT_NAME,
      email: CLIENT_EMAIL,
      appointmentId: APPOINTMENT_ID,
      note: CLINICAL_NOTE,
    }));

    await expect(
      timed("client-profile.identity", async () => {
        throw new Error(`failed for ${CLIENT_EMAIL} / ${APPOINTMENT_ID}`);
      }),
    ).rejects.toThrow();

    const everything = emitted()
      .map((entry) => entry.line)
      .join("\n");
    for (const secret of [
      CLIENT_NAME,
      CLIENT_EMAIL,
      APPOINTMENT_ID,
      CLINICAL_NOTE,
      "failed for",
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("emits exactly the allowlisted payload keys and nothing else", async () => {
    await timed("calendar.domain", async () => null);

    const entry = emitted()[0];
    expect(Object.keys(entry.payload).sort()).toEqual(
      [
        "domain_total_ms",
        "dropped_spans",
        "event",
        "identity_resolutions",
        "identity_total_ms",
        "membership_resolutions",
        "membership_total_ms",
        "perf_timing",
        "shell_total_ms",
        "span_count",
        "spans",
        "surface",
        "timestamp",
      ].sort(),
    );
    // The span record itself is the only nested object; pin its shape too, so
    // a future field cannot be added without a test failing first.
    expect(Object.keys(onlySpan(entry)).sort()).toEqual([
      "duration_ms",
      "outcome",
      "seq",
      "span",
    ]);
  });

  it("never records a URL or pathname", async () => {
    // The authenticated pathname /clients/<uuid> IS a client identifier, so
    // the surface must be derived from the span name, never from a route.
    await timed("client-profile.domain", async () => "x");
    const entry = emitted()[0];
    expect(entry.payload.surface).toBe("client-profile");
    expect(entry.line).not.toContain("/clients/");
    expect(entry.line).not.toContain("http");
  });
});

// ---------------------------------------------------------------------------
// 2. Never throws on behalf of the telemetry backend.
// ---------------------------------------------------------------------------

describe("telemetry backend failure is contained", () => {
  it("returns normally when the log sink itself throws", async () => {
    sinkThrows = true;

    await expect(
      timed("records.domain", async () => "still fine"),
    ).resolves.toBe("still fine");
  });

  it("returns normally when the payload cannot be serialised", async () => {
    // A cyclic value can only reach the serialiser through the module's own
    // payload, so this exercises the JSON.stringify fallback path directly.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => buildPerfSummary([], 0, "t")).not.toThrow();
    await expect(timed("records.identity", async () => cyclic)).resolves.toBe(
      cyclic,
    );
  });

  it("still runs the work when the span recorder is disabled mid-flight", async () => {
    // Disabling between calls must not strand anything.
    disable();
    await expect(timed("clients.domain", async () => "unmeasured")).resolves.toBe(
      "unmeasured",
    );
    expect(emitted()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Nested and concurrent spans do not corrupt each other.
// ---------------------------------------------------------------------------

describe("nested and concurrent spans", () => {
  it("keeps concurrent spans independent", async () => {
    const [slow, fast] = await Promise.all([
      timed("clients.domain", async () => {
        await sleep(40);
        return "slow";
      }),
      timed("calendar.domain", async () => {
        await sleep(1);
        return "fast";
      }),
    ]);

    expect(slow).toBe("slow");
    expect(fast).toBe("fast");

    const byName = new Map(
      emitted().map((entry) => {
        const span = onlySpan(entry);
        return [span.span as string, span.duration_ms as number];
      }),
    );
    expect(byName.size).toBe(2);
    expect(byName.get("clients.domain")).toBeGreaterThan(
      byName.get("calendar.domain") as number,
    );
  });

  it("keeps a nested span's duration inside its parent's", async () => {
    const outer = await timed("shell.identity", async () => {
      await sleep(10);
      const inner = await timed("shell.memberships", async () => {
        await sleep(20);
        return "inner";
      });
      return `outer:${inner}`;
    });

    expect(outer).toBe("outer:inner");

    const byName = new Map(
      emitted().map((entry) => {
        const span = onlySpan(entry);
        return [span.span as string, span.duration_ms as number];
      }),
    );
    const parent = byName.get("shell.identity") as number;
    const child = byName.get("shell.memberships") as number;
    expect(parent).toBeGreaterThanOrEqual(child);
  });

  it("does not let a failing span corrupt a sibling that succeeds", async () => {
    const results = await Promise.allSettled([
      timed("clients.identity", async () => {
        throw new Error("boom");
      }),
      timed("clients.domain", async () => "ok"),
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results[1]).toMatchObject({ status: "fulfilled", value: "ok" });

    const outcomes = new Map(
      emitted().map((entry) => {
        const span = onlySpan(entry);
        return [span.span as string, span.outcome as string];
      }),
    );
    expect(outcomes.get("clients.identity")).toBe("threw");
    expect(outcomes.get("clients.domain")).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 3b. The runtime allowlist — the control that survives `any`.
// ---------------------------------------------------------------------------

describe("span ids are checked at runtime, not only at compile time", () => {
  // TypeScript admits `any` into a string-literal union with NO cast, so
  // `const cfg = JSON.parse(payload); fns.m(cfg.span, run)` type-checks and
  // would emit an arbitrary span name. These cast through `any` to reproduce
  // exactly what a refactor routing untyped data can produce accidentally.
  const smuggled = CLIENT_EMAIL as unknown as PerfSpanId;

  it("drops an unknown span name instead of emitting it", async () => {
    await timed(smuggled, async () => "work ran");

    const lines = written.join("\n");
    expect(lines).not.toContain(CLIENT_EMAIL);
    // Nothing was recorded, so no summary line exists at all.
    expect(emitted()).toHaveLength(0);
  });

  it("never logs the rejected value, only that a rejection happened", async () => {
    const warned: string[] = [];
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation((...args: unknown[]) => {
        warned.push(String(args[0]));
      });

    await timed(smuggled, async () => "work ran");
    startPerfSpan(smuggled).end();

    warnSpy.mockRestore();
    expect(warned.length).toBeGreaterThan(0);
    for (const line of warned) {
      expect(line).not.toContain(CLIENT_EMAIL);
      expect(JSON.parse(line)).toEqual({ event: "perf_span_rejected" });
    }
  });

  it("still runs the work exactly once when the span is rejected", async () => {
    const fn = vi.fn(async () => "work ran");
    await expect(timed(smuggled, fn)).resolves.toBe("work ran");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns an inert handle for a rejected bracketed span", async () => {
    const handle = startPerfSpan(smuggled);
    expect(() => handle.end()).not.toThrow();
    expect(emitted()).toHaveLength(0);
  });

  it("still records every allowlisted span", async () => {
    // Anti-vacuity for the rejection path: the allowlist must not be so
    // strict that it drops the spans the instrumentation actually uses.
    for (const span of PERF_SPAN_IDS) {
      written.length = 0;
      await timed(span, async () => "ok");
      expect(emitted(), `span ${span} was dropped`).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The API itself refuses unsafe input.
// ---------------------------------------------------------------------------

describe("span names are a closed set", () => {
  it("rejects a free-text span name at compile time", async () => {
    // `npm run typecheck` compiles tests/ (tsconfig includes **/*.ts), so the
    // suppression directives below are ENFORCED assertions: if PerfSpanId ever
    // widens to `string`, each directive becomes unused and typecheck FAILS.
    // That is the guard stopping a caller from smuggling an identifier into a
    // span name. (Written this way on purpose: a comment line that *begins*
    // with the directive token is itself parsed as a directive.)
    // @ts-expect-error - a client identifier is not a valid PerfSpanId
    await timed(`client-${APPOINTMENT_ID}`, async () => "x");
    // @ts-expect-error - arbitrary strings are not valid PerfSpanIds
    startPerfSpan(CLIENT_EMAIL).end();
  });

  it("derives the surface from the span name only", () => {
    expect(surfaceOf("shell.identity")).toBe("shell");
    expect(surfaceOf("client-profile.domain")).toBe("client-profile");
    expect(surfaceOf("records.identity")).toBe("records");
  });
});

// ---------------------------------------------------------------------------
// 5. Return values pass through untouched.
// ---------------------------------------------------------------------------

describe("return values are unchanged", () => {
  it("preserves object identity, undefined, null and arrays", async () => {
    const obj = { a: 1 };
    const arr = [1, 2, 3];

    expect(await timed("clients.domain", async () => obj)).toBe(obj);
    expect(await timed("clients.domain", async () => arr)).toBe(arr);
    expect(await timed("clients.domain", async () => undefined)).toBeUndefined();
    expect(await timed("clients.domain", async () => null)).toBeNull();
  });

  it("preserves the same values when timing is disabled", async () => {
    disable();
    const obj = { a: 1 };
    expect(await timed("clients.domain", async () => obj)).toBe(obj);
    expect(await timed("clients.domain", async () => undefined)).toBeUndefined();
    expect(await timed("clients.domain", async () => null)).toBeNull();
  });

  it("invokes the callback exactly once", async () => {
    const fn = vi.fn(async () => "once");
    await timed("calendar.identity", fn);
    expect(fn).toHaveBeenCalledTimes(1);

    disable();
    const fn2 = vi.fn(async () => "once");
    await timed("calendar.identity", fn2);
    expect(fn2).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Control flow is untouched.
// ---------------------------------------------------------------------------

describe("control flow is untouched", () => {
  it("re-throws the original error instance", async () => {
    const original = new Error("original");
    await expect(
      timed("records.domain", async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it("passes a Next redirect signal through unchanged", async () => {
    // requirePractitionerWithStudio() redirects to /login and /no-access by
    // THROWING a digest-carrying error. If the wrapper swallowed or replaced
    // it, the app shell's auth gate would silently stop working.
    const redirectSignal = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
    await expect(
      timed("shell.identity", async () => {
        throw redirectSignal;
      }),
    ).rejects.toBe(redirectSignal);

    const span = onlySpan(emitted()[0]);
    expect(span.outcome).toBe("threw");
  });

  it("is silent and allocation-free when disabled", async () => {
    disable();
    expect(isPerfTimingEnabled()).toBe(false);
    await timed("shell.identity", async () => "x");
    const handle = startPerfSpan("shell.support-reads");
    handle.end();
    handle.end();
    expect(emitted()).toHaveLength(0);
  });

  it("treats a repeated end() as a no-op", async () => {
    const handle = startPerfSpan("records.domain");
    handle.end();
    handle.end();
    handle.end();
    expect(emitted()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The summary payload — the artefact the operator actually reads.
// ---------------------------------------------------------------------------

describe("buildPerfSummary", () => {
  const request = [
    { span: "shell.identity", seq: 1, duration_ms: 40, outcome: "ok" },
    { span: "shell.memberships", seq: 2, duration_ms: 35, outcome: "ok" },
    { span: "shell.support-reads", seq: 3, duration_ms: 22, outcome: "ok" },
    { span: "client-profile.identity", seq: 4, duration_ms: 38, outcome: "ok" },
    { span: "client-profile.domain", seq: 5, duration_ms: 210, outcome: "ok" },
  ] as const;

  it("counts how many times ONE request resolved identity", () => {
    const summary = buildPerfSummary([...request], 0, "2026-08-20T00:00:00Z");
    // Two `.identity` spans (shell + page) plus one `.memberships` span. This
    // is the field that settles the audit's central hypothesis.
    expect(summary.identity_resolutions).toBe(2);
    expect(summary.membership_resolutions).toBe(1);
    // 40 + 38 — the `.identity` spans ONLY, so that dividing this by
    // identity_resolutions gives a true mean (39ms). An earlier version folded
    // the 35ms membership span in here, which inflated that mean to 56.5ms.
    expect(summary.identity_total_ms).toBe(78);
    expect(summary.membership_total_ms).toBe(35);
  });

  it("attributes time to shell versus page domain", () => {
    const summary = buildPerfSummary([...request], 0, "2026-08-20T00:00:00Z");
    expect(summary.shell_total_ms).toBe(97);
    expect(summary.domain_total_ms).toBe(210);
  });

  it("keeps the phase totals disjoint so they can be reasoned about", () => {
    const summary = buildPerfSummary([...request], 0, "2026-08-20T00:00:00Z");
    // identity + memberships + domain partitions every span that has a phase
    // bucket; shell.support-reads (22ms) belongs to none of them by design.
    const phaseTotal =
      (summary.identity_total_ms as number) +
      (summary.membership_total_ms as number) +
      (summary.domain_total_ms as number);
    expect(phaseTotal).toBe(78 + 35 + 210);
    // shell_total_ms is an ORTHOGONAL projection and deliberately overlaps.
    // Pinned so nobody "fixes" the overlap by summing the two axes.
    expect(summary.shell_total_ms).toBe(40 + 35 + 22);
  });

  it("labels the request by its page surface, not the shell", () => {
    const summary = buildPerfSummary([...request], 0, "2026-08-20T00:00:00Z");
    expect(summary.surface).toBe("client-profile");
  });

  it("falls back to the shell when no page span was recorded", () => {
    const summary = buildPerfSummary(
      [{ span: "shell.identity", seq: 1, duration_ms: 5, outcome: "ok" }],
      0,
      "2026-08-20T00:00:00Z",
    );
    expect(summary.surface).toBe("shell");
  });

  it("reports dropped spans rather than hiding them", () => {
    const summary = buildPerfSummary([...request], 7, "2026-08-20T00:00:00Z");
    expect(summary.dropped_spans).toBe(7);
    expect(summary.span_count).toBe(5);
  });

  it("produces no output for an empty request", () => {
    const summary = buildPerfSummary([], 0, "2026-08-20T00:00:00Z");
    expect(summary.span_count).toBe(0);
    expect(summary.identity_resolutions).toBe(0);
  });
});
