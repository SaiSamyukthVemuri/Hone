import { describe, expect, it } from "vitest";
import {
  gridPhotoKey,
  initialGridPhoto,
  onGridPhotoError,
  onGridPhotoRemint,
  type GridPhotoState,
  type GridPhotoUrls,
  type GridPhotoVariant,
} from "@/lib/images/grid-photo-recovery";

// FETT photos (HON-43): a grid cell recovers from an EXPIRED signed URL by
// re-minting once per variant, and can never loop.

const BOTH: GridPhotoUrls = { previewUrl: "orig-1", thumbUrl: "thumb-1" };

describe("initial state", () => {
  it("prefers the derivative, falls back to the original, and is unavailable without an original", () => {
    expect(initialGridPhoto(BOTH)).toMatchObject({ stage: "thumb", src: "thumb-1" });
    expect(initialGridPhoto({ previewUrl: "orig-1", thumbUrl: null })).toMatchObject({
      stage: "original",
      src: "orig-1",
    });
    // PERF-IMG-03: availability keys off the ORIGINAL, never the derivative.
    expect(initialGridPhoto({ previewUrl: null, thumbUrl: "thumb-1" })).toMatchObject({
      stage: "broken",
      src: null,
    });
  });

  it("is tied to the server URLs it was computed from", () => {
    expect(initialGridPhoto(BOTH).key).toBe(gridPhotoKey(BOTH));
    expect(gridPhotoKey({ previewUrl: "orig-2", thumbUrl: "thumb-2" })).not.toBe(gridPhotoKey(BOTH));
  });
});

describe("expired URLs recover", () => {
  it("an expired derivative is re-minted and the fresh one is shown", () => {
    const e = onGridPhotoError(initialGridPhoto(BOTH), BOTH);
    expect(e.remint).toBe("thumb");
    const s = onGridPhotoRemint(e.state, BOTH, "thumb", "thumb-fresh");
    expect(s).toMatchObject({ stage: "thumb", src: "thumb-fresh", pending: null });
  });

  it("no derivative available on re-mint: the original is shown", () => {
    const e = onGridPhotoError(initialGridPhoto(BOTH), BOTH);
    const s = onGridPhotoRemint(e.state, BOTH, "thumb", null);
    expect(s).toMatchObject({ stage: "original", src: "orig-1" });
  });

  it("an expired original is re-minted once, then shown", () => {
    const urls = { previewUrl: "orig-1", thumbUrl: null };
    const e = onGridPhotoError(initialGridPhoto(urls), urls);
    expect(e.remint).toBe("original");
    expect(onGridPhotoRemint(e.state, urls, "original", "orig-fresh")).toMatchObject({
      stage: "original",
      src: "orig-fresh",
    });
  });

  it("errors while a re-mint is in flight are ignored (one request, not one per error)", () => {
    const e = onGridPhotoError(initialGridPhoto(BOTH), BOTH);
    const again = onGridPhotoError(e.state, BOTH);
    expect(again.remint).toBeNull();
    expect(again.state).toBe(e.state);
  });

  it("a stale re-mint result for the other variant is ignored", () => {
    const e = onGridPhotoError(initialGridPhoto(BOTH), BOTH);
    expect(onGridPhotoRemint(e.state, BOTH, "original", "x")).toBe(e.state);
  });
});

describe("BOUNDED: no retry loop", () => {
  /** Drive a cell whose every load fails and every re-mint "succeeds" with a URL that also fails. */
  function driveToEnd(urls: GridPhotoUrls, remintResult: (v: GridPhotoVariant) => string | null) {
    let state: GridPhotoState = initialGridPhoto(urls);
    const remints: GridPhotoVariant[] = [];
    let steps = 0;
    while (state.stage !== "broken") {
      if (++steps > 20) throw new Error("did not terminate");
      const e = onGridPhotoError(state, urls);
      state = e.state;
      if (e.remint) {
        remints.push(e.remint);
        state = onGridPhotoRemint(state, urls, e.remint, remintResult(e.remint));
      }
    }
    return { remints, steps };
  }

  it("every URL failing ends BROKEN after exactly one re-mint per variant", () => {
    const r = driveToEnd(BOTH, (v) => `${v}-fresh-but-also-failing`);
    expect(r.remints).toEqual(["thumb", "original"]);
    expect(r.steps).toBeLessThanOrEqual(4);
  });

  it("re-mints refused ends BROKEN without retrying", () => {
    const r = driveToEnd(BOTH, () => null);
    expect(r.remints).toEqual(["thumb", "original"]);
  });

  it("original only, every load failing: one re-mint, then broken", () => {
    expect(driveToEnd({ previewUrl: "o", thumbUrl: null }, () => "o2").remints).toEqual(["original"]);
  });

  it("broken is terminal: further errors request nothing", () => {
    const broken = { ...initialGridPhoto(BOTH), stage: "broken" as const, src: null };
    expect(onGridPhotoError(broken, BOTH)).toEqual({ state: broken, remint: null });
  });
});
