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
//   * it throws AFTER our work   -> the work already ran, so do NOT run it
//                                   again; the error belongs to the caller.
//
// The third case is the one an `invoked` flag exists to get right: a naive
// try/catch that simply falls back to `fn()` would silently execute a page's
// database reads twice.
// ===========================================================================

const state = vi.hoisted(() => ({
  mode: "throw-before" as "throw-before" | "throw-after" | "missing",
}));

vi.mock("@sentry/nextjs", () => ({
  // A getter, so a single mocked module can present `startSpan` as a
  // function or as absent, which is how the "SDK not present" branch is
  // reached without a second mock file.
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
}));

const { timed } = await import("@/lib/observability/perf-timing");

const originalFlag = process.env.HONE_PERF_TIMING;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.HONE_PERF_TIMING = "1";
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

  it("does not re-run the work when the SDK throws after invoking it", async () => {
    state.mode = "throw-after";
    const fn = vi.fn(async () => "work ran");

    // The caller sees the failure rather than a silently duplicated read.
    await expect(timed("clients.domain", fn)).rejects.toThrow(
      "sentry failed after invoking",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runs the work unmeasured when the SDK is not present", async () => {
    state.mode = "missing";
    const fn = vi.fn(async () => "work ran");

    await expect(timed("records.domain", fn)).resolves.toBe("work ran");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
