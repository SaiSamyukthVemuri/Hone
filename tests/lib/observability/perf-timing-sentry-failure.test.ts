import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// The telemetry backend is allowed to fail. The page is not.
//
// perf-timing runs the instrumented callback inside a Sentry span when the
// SDK is available. Three things can go wrong with that, and each has a
// different correct answer:
//
//   * the SDK is absent          -> run the work unmeasured;
//   * it throws BEFORE our work  -> run the work unmeasured, exactly once;
//   * it throws AFTER our work   -> the work already produced its result, so
//                                   return it. Do NOT re-run the work, and do
//                                   NOT surface the telemetry error.
//
// The third case is the subtle one, and it is why the implementation captures
// the callback's own promise rather than merely recording that the callback
// started. A naive try/catch that falls back to `fn()` runs a page's database
// reads twice; one that re-throws on "already started" fails a page that had
// already succeeded, purely because of a telemetry bug. The captured promise
// separates "the work failed" from "the SDK failed after the work succeeded".
// ===========================================================================

const state = vi.hoisted(() => ({
  mode: "throw-before" as "throw-before" | "throw-after" | "missing",
  /** How the BRACKET form's inactive-span API should behave. */
  inactive: "ok" as "ok" | "throws" | "missing",
  /** Names of inactive spans that were started, then ended. */
  started: [] as string[],
  ended: [] as string[],
}));

vi.mock("@sentry/nextjs", () => ({
  // Getters, so a single mocked module can present each API as a function or
  // as absent, which is how the "SDK not present" branches are reached
  // without a second mock file.
  get startSpan() {
    if (state.mode === "missing") return undefined;
    return <T>(_options: unknown, callback: () => Promise<T>): Promise<T> => {
      if (state.mode === "throw-before") {
        throw new Error("sentry unavailable");
      }
      // throw-after: the SDK invoked our callback and then failed.
      void callback();
      throw new Error("sentry failed after invoking");
    };
  },
  get startInactiveSpan() {
    if (state.inactive === "missing") return undefined;
    return (options: { name: string }) => {
      if (state.inactive === "throws") {
        throw new Error("sentry inactive-span unavailable");
      }
      state.started.push(options.name);
      return {
        end: () => {
          state.ended.push(options.name);
        },
      };
    };
  },
}));

const { startPerfSpan, timed } = await import(
  "@/lib/observability/perf-timing",
);

const originalFlag = process.env.HONE_PERF_TIMING;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.HONE_PERF_TIMING = "1";
  state.inactive = "ok";
  state.started.length = 0;
  state.ended.length = 0;
});

afterEach(() => {
  errorSpy.mockRestore();
  if (originalFlag === undefined) delete process.env.HONE_PERF_TIMING;
  else process.env.HONE_PERF_TIMING = originalFlag;
});

describe("Sentry span creation failing", () => {
  it("still runs the work exactly once when the SDK throws first", async () => {
    state.mode = "throw-before";
    const fn = vi.fn(async () => "work ran");

    await expect(timed("clients.domain", fn)).resolves.toBe("work ran");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns the work's result when the SDK throws after invoking it", async () => {
    state.mode = "throw-after";
    const fn = vi.fn(async () => "work ran");

    // The page succeeded. A telemetry failure afterwards must neither discard
    // that result nor re-run the work: this wrapper sits on the app shell, so
    // surfacing the SDK's error here would fail EVERY authenticated route.
    await expect(timed("clients.domain", fn)).resolves.toBe("work ran");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("still surfaces the work's OWN rejection when the SDK also fails", async () => {
    state.mode = "throw-after";
    const failure = new Error("the page's own read failed");
    const fn = vi.fn(async () => {
      throw failure;
    });

    // Containment must not swallow a real error: the callback's own outcome
    // is authoritative in both directions.
    await expect(timed("clients.domain", fn)).rejects.toBe(failure);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runs the work unmeasured when the SDK is not present", async () => {
    state.mode = "missing";
    const fn = vi.fn(async () => "work ran");

    await expect(timed("records.domain", fn)).resolves.toBe("work ran");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("bracketed spans reach Sentry too", () => {
  it("opens and closes an inactive span for a bracketed region", () => {
    // The `.domain` windows are the main page-work phases. Before this, they
    // appeared in the structured log but were missing from every trace, so the
    // waterfall could not show the thing it exists to show.
    const handle = startPerfSpan("records.domain");
    expect(state.started).toEqual(["records.domain"]);
    expect(state.ended).toEqual([]);

    handle.end();
    expect(state.ended).toEqual(["records.domain"]);
  });

  it("closes the inactive span only once", () => {
    const handle = startPerfSpan("calendar.domain");
    handle.end();
    handle.end();
    handle.end();
    expect(state.ended).toEqual(["calendar.domain"]);
  });

  it("survives an inactive-span API that throws", () => {
    state.inactive = "throws";
    const handle = startPerfSpan("clients.domain");
    expect(() => handle.end()).not.toThrow();
  });

  it("survives an inactive-span API that is absent", () => {
    state.inactive = "missing";
    const handle = startPerfSpan("client-profile.domain");
    expect(() => handle.end()).not.toThrow();
  });

  it("opens no span at all when timing is disabled", () => {
    delete process.env.HONE_PERF_TIMING;
    const handle = startPerfSpan("records.domain");
    handle.end();
    expect(state.started).toEqual([]);
    expect(state.ended).toEqual([]);
  });
});
