import { describe, expect, it } from "vitest";
import {
  GRID_PHOTO_REMINT_TIMEOUT_MS,
  gridPhotoKey,
  initialGridPhoto,
  currentGridPhoto,
  onGridPhotoError,
  onGridPhotoRemint,
  onGridPhotoRemintFailed,
  type GridPhotoState,
  type GridPhotoUrls,
  type RemintRequest,
} from "@/lib/images/grid-photo-recovery";

// FETT photos (HON-43): a photo cell recovers from an EXPIRED signed URL by
// re-minting; a re-mint that times out or rejects is retried ONCE, then the
// variant is given up. Bounded: never more than four re-mints, never a loop.

const BOTH: GridPhotoUrls = { previewUrl: "orig-1", thumbUrl: "thumb-1" };

describe("initial state", () => {
  it("prefers the derivative, falls back to the original, and is unavailable without an original", () => {
    expect(initialGridPhoto(BOTH)).toMatchObject({ stage: "thumb", src: "thumb-1", pending: null });
    expect(initialGridPhoto({ previewUrl: "orig-1", thumbUrl: null })).toMatchObject({ stage: "original", src: "orig-1" });
    // PERF-IMG-03: availability keys off the ORIGINAL, never the derivative.
    expect(initialGridPhoto({ previewUrl: null, thumbUrl: "thumb-1" })).toMatchObject({ stage: "broken", src: null });
  });

  it("is tied to the server URLs it was computed from", () => {
    expect(initialGridPhoto(BOTH).key).toBe(gridPhotoKey(BOTH));
    expect(gridPhotoKey({ previewUrl: "orig-2", thumbUrl: "thumb-2" })).not.toBe(gridPhotoKey(BOTH));
  });

  it("keeps an unchanged URL's pending recovery and object identity", () => {
    const pending = onGridPhotoError(initialGridPhoto(BOTH), BOTH).state;
    expect(currentGridPhoto(pending, BOTH)).toBe(pending);
  });

  it("fresh URLs revive a failed cell and reset both retry budgets without remounting", () => {
    const broken: GridPhotoState = { ...initialGridPhoto(BOTH), stage: "broken", src: null,
      reminted: { thumb: true, original: true } };
    const fresh = { previewUrl: "orig-2", thumbUrl: "thumb-2" };
    expect(currentGridPhoto(broken, fresh)).toEqual(initialGridPhoto(fresh));
  });

  it("fresh URLs discard an old pending request; a missing original stays unavailable", () => {
    const pending = onGridPhotoError(initialGridPhoto(BOTH), BOTH).state;
    const fresh = { previewUrl: null, thumbUrl: "thumb-2" };
    expect(currentGridPhoto(pending, fresh)).toEqual(initialGridPhoto(fresh));
    expect(currentGridPhoto(pending, fresh).pending).toBeNull();
  });

  it("the re-mint timeout is a named constant, ~10x the observed round trip and under the 60 s TTL", () => {
    expect(GRID_PHOTO_REMINT_TIMEOUT_MS).toBe(8000);
    expect(GRID_PHOTO_REMINT_TIMEOUT_MS).toBeLessThan(60_000);
  });
});

describe("expired URLs recover", () => {
  it("an expired derivative is re-minted (attempt 1) and the fresh one is shown", () => {
    const e = onGridPhotoError(initialGridPhoto(BOTH), BOTH);
    expect(e.remint).toEqual({ variant: "thumb", attempt: 1 });
    expect(onGridPhotoRemint(e.state, BOTH, "thumb", "thumb-fresh")).toMatchObject({
      stage: "thumb",
      src: "thumb-fresh",
      pending: null,
    });
  });

  it("a definitive 'no URL' gives up on the derivative: the original is shown", () => {
    const e = onGridPhotoError(initialGridPhoto(BOTH), BOTH);
    expect(onGridPhotoRemint(e.state, BOTH, "thumb", null)).toMatchObject({ stage: "original", src: "orig-1", pending: null });
  });

  it("errors while a re-mint is in flight are ignored (one request, not one per error)", () => {
    const e = onGridPhotoError(initialGridPhoto(BOTH), BOTH);
    const again = onGridPhotoError(e.state, BOTH);
    expect(again.remint).toBeNull();
    expect(again.state).toBe(e.state);
  });
});

describe("BOUNDED PENDING: a re-mint that never completes", () => {
  it("TIMEOUT on attempt 1 retries the SAME variant once (attempt 2)", () => {
    const e = onGridPhotoError(initialGridPhoto(BOTH), BOTH);
    const t = onGridPhotoRemintFailed(e.state, BOTH, "thumb", 1);
    expect(t.remint).toEqual({ variant: "thumb", attempt: 2 });
    expect(t.state.pending).toEqual({ variant: "thumb", attempt: 2 });
    expect(t.state.stage).toBe("thumb");
  });

  it("TIMEOUT on attempt 2 gives up on the variant (derivative → original; original → broken)", () => {
    let s = onGridPhotoError(initialGridPhoto(BOTH), BOTH).state;
    s = onGridPhotoRemintFailed(s, BOTH, "thumb", 1).state;
    const t = onGridPhotoRemintFailed(s, BOTH, "thumb", 2);
    expect(t.remint).toBeNull();
    expect(t.state).toMatchObject({ stage: "original", src: "orig-1", pending: null });
  });

  it("a REJECTED re-mint takes the SAME path as a timeout (both are onGridPhotoRemintFailed)", () => {
    // The hook routes a rejected promise and an expired timer to the same
    // transition; the machine cannot tell them apart, by design.
    const e = onGridPhotoError(initialGridPhoto(BOTH), BOTH);
    expect(onGridPhotoRemintFailed(e.state, BOTH, "thumb", 1).remint).toEqual({ variant: "thumb", attempt: 2 });
  });

  it("a late SUCCESS from the superseded attempt 1 is STILL USED while the cell waits on that variant", () => {
    let s = onGridPhotoError(initialGridPhoto(BOTH), BOTH).state;
    s = onGridPhotoRemintFailed(s, BOTH, "thumb", 1).state; // now waiting on attempt 2
    const landed = onGridPhotoRemint(s, BOTH, "thumb", "thumb-from-attempt-1");
    expect(landed).toMatchObject({ stage: "thumb", src: "thumb-from-attempt-1", pending: null });
    // ...and attempt 2 landing afterwards is ignored (the cell has moved on).
    expect(onGridPhotoRemint(landed, BOTH, "thumb", "thumb-from-attempt-2")).toBe(landed);
  });

  it("a late result is IGNORED once the cell has moved on to another variant", () => {
    let s = onGridPhotoError(initialGridPhoto(BOTH), BOTH).state;
    s = onGridPhotoRemintFailed(s, BOTH, "thumb", 1).state;
    s = onGridPhotoRemintFailed(s, BOTH, "thumb", 2).state; // gave up: showing the original
    expect(onGridPhotoRemint(s, BOTH, "thumb", "thumb-too-late")).toBe(s);
  });

  it("a late FAILURE from a superseded attempt is IGNORED, so it cannot cut the retry short", () => {
    let s = onGridPhotoError(initialGridPhoto(BOTH), BOTH).state;
    s = onGridPhotoRemintFailed(s, BOTH, "thumb", 1).state; // waiting on attempt 2
    const stale = onGridPhotoRemintFailed(s, BOTH, "thumb", 1); // attempt 1 rejects late
    expect(stale.state).toBe(s);
    expect(stale.remint).toBeNull();
  });

  it("a failure for a variant that is not pending is ignored", () => {
    const s = initialGridPhoto(BOTH);
    expect(onGridPhotoRemintFailed(s, BOTH, "thumb", 1)).toEqual({ state: s, remint: null });
  });
});

describe("BOUNDED: no retry loop, at most four re-mints", () => {
  type Outcome = "never" | "reject" | "null" | "fresh-but-failing";
  /**
   * Drive a cell where every LOAD fails and every re-mint has the given outcome.
   * "never"/"reject" go through onGridPhotoRemintFailed (timer or rejection).
   */
  function drive(urls: GridPhotoUrls, outcome: Outcome) {
    let state: GridPhotoState = initialGridPhoto(urls);
    const remints: RemintRequest[] = [];
    let steps = 0;
    let next: RemintRequest | null = null;
    while (state.stage !== "broken") {
      if (++steps > 50) throw new Error("did not terminate");
      if (!next) {
        const e = onGridPhotoError(state, urls);
        state = e.state;
        next = e.remint;
        continue;
      }
      remints.push(next);
      if (outcome === "never" || outcome === "reject") {
        const f = onGridPhotoRemintFailed(state, urls, next.variant, next.attempt);
        state = f.state;
        next = f.remint;
      } else {
        state = onGridPhotoRemint(state, urls, next.variant, outcome === "null" ? null : `${next.variant}-fresh`);
        next = null;
      }
    }
    return remints;
  }

  it("re-mints that NEVER settle: thumb ×2, original ×2, then broken", () => {
    expect(drive(BOTH, "never")).toEqual([
      { variant: "thumb", attempt: 1 },
      { variant: "thumb", attempt: 2 },
      { variant: "original", attempt: 1 },
      { variant: "original", attempt: 2 },
    ]);
  });

  it("re-mints that REJECT: the same four, then broken", () => {
    expect(drive(BOTH, "reject")).toHaveLength(4);
  });

  it("re-mints refused definitively: one per variant, then broken", () => {
    expect(drive(BOTH, "null")).toEqual([
      { variant: "thumb", attempt: 1 },
      { variant: "original", attempt: 1 },
    ]);
  });

  it("fresh URLs that ALSO fail to load: one re-mint per variant, then broken", () => {
    expect(drive(BOTH, "fresh-but-failing")).toHaveLength(2);
  });

  it("broken is terminal: further errors request nothing", () => {
    const broken = { ...initialGridPhoto(BOTH), stage: "broken" as const, src: null };
    expect(onGridPhotoError(broken, BOTH)).toEqual({ state: broken, remint: null });
  });
});
