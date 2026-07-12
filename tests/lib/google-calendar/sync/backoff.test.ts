import { describe, expect, it } from "vitest";
import {
  computeBackoff,
  MAX_BACKOFF_SECONDS,
  MIN_BACKOFF_SECONDS,
} from "@/lib/google-calendar/sync/backoff";

// Phase B2.1 — bounded exponential backoff with full jitter, injectable rng.

describe("computeBackoff", () => {
  it("always returns a whole number in [5, 21600]", () => {
    for (let attempts = 1; attempts <= 30; attempts++) {
      for (const r of [0, 0.25, 0.5, 0.999999]) {
        const v = computeBackoff({ attempts, rng: () => r });
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(MIN_BACKOFF_SECONDS);
        expect(v).toBeLessThanOrEqual(MAX_BACKOFF_SECONDS);
      }
    }
  });

  it("full jitter: rng=0 floors to MIN, rng~1 approaches the window", () => {
    // attempts=3 -> window = 30 * 2^2 = 120s
    expect(computeBackoff({ attempts: 3, rng: () => 0 })).toBe(MIN_BACKOFF_SECONDS);
    expect(computeBackoff({ attempts: 3, rng: () => 0.999999 })).toBe(120);
    expect(computeBackoff({ attempts: 3, rng: () => 0.5 })).toBe(60);
  });

  it("window is capped before jitter so it never overshoots MAX", () => {
    expect(computeBackoff({ attempts: 40, rng: () => 0.999999 })).toBe(MAX_BACKOFF_SECONDS);
  });

  it("a server Retry-After overrides the exponential curve (bounded)", () => {
    expect(computeBackoff({ attempts: 1, retryAfterSeconds: 900, rng: () => 0 })).toBe(900);
    expect(computeBackoff({ attempts: 1, retryAfterSeconds: 1, rng: () => 0.9 })).toBe(5); // floored
    expect(computeBackoff({ attempts: 1, retryAfterSeconds: 99999, rng: () => 0 })).toBe(21600);
  });

  it("distribution spreads across the window (not a constant)", () => {
    const seen = new Set<number>();
    let seed = 1;
    const rng = () => {
      // simple deterministic LCG in [0,1)
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 200; i++) seen.add(computeBackoff({ attempts: 6, rng }));
    // With full jitter over a ~960s window, we expect many distinct values.
    expect(seen.size).toBeGreaterThan(20);
  });
});
