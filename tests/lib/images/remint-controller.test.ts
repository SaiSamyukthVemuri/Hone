import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GRID_PHOTO_REMINT_TIMEOUT_MS,
  initialGridPhoto,
  type GridPhotoState,
  type GridPhotoUrls,
  type GridPhotoVariant,
} from "@/lib/images/grid-photo-recovery";
import { createRemintController, oncePerErrorEvent } from "@/lib/images/remint-controller";

// FETT photos (HON-43), Codex P1 4307807754: a re-mint is an ABORTABLE request.
// A timed-out attempt is aborted before the retry is sent, so the retry is a
// genuinely new request, and nothing outlives the cell.

const URLS: GridPhotoUrls = { previewUrl: "orig-1", thumbUrl: "thumb-1" };
const T = GRID_PHOTO_REMINT_TIMEOUT_MS;

type Call = {
  variant: GridPhotoVariant;
  signal: AbortSignal;
  resolve: (url: string | null) => void;
  reject: (e: unknown) => void;
};

function harness(opts: { honourAbort?: boolean } = {}) {
  const honourAbort = opts.honourAbort ?? true;
  let state: GridPhotoState = initialGridPhoto(URLS);
  const writes: GridPhotoState[] = [];
  const calls: Call[] = [];
  const c = createRemintController({
    urls: URLS,
    read: () => state,
    write: (next) => {
      state = next;
      writes.push(next);
    },
    request: (variant, signal) =>
      new Promise<string | null>((resolve, reject) => {
        calls.push({ variant, signal, resolve, reject });
        if (honourAbort) signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  });
  return {
    c,
    calls,
    writes,
    get state() {
      return state;
    },
    /** Move the cell's state from outside (another transition), for settle cases. */
    force(next: GridPhotoState) {
      state = next;
    },
  };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("timeout ABORTS the in-flight request", () => {
  it("attempt 1 times out: its request is aborted and attempt 2 is a NEW request", async () => {
    const h = harness();
    h.c.onImageError();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].signal.aborted).toBe(false);
    vi.advanceTimersByTime(T);
    await flush();
    expect(h.calls[0].signal.aborted).toBe(true);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].signal).not.toBe(h.calls[0].signal);
    expect(h.calls[1].signal.aborted).toBe(false);
    expect(h.state.pending).toEqual({ variant: "thumb", attempt: 2 });
  });

  it("nothing happens before the timeout (one request, still pending)", async () => {
    const h = harness();
    h.c.onImageError();
    vi.advanceTimersByTime(T - 1);
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].signal.aborted).toBe(false);
  });

  it("attempt 2 times out too: aborted, the cell gives up on the derivative, nothing in flight", async () => {
    const h = harness();
    h.c.onImageError();
    vi.advanceTimersByTime(T);
    await flush();
    vi.advanceTimersByTime(T);
    await flush();
    expect(h.calls.map((c) => c.signal.aborted)).toEqual([true, true]);
    expect(h.state).toMatchObject({ stage: "original", src: "orig-1", pending: null });
    expect(h.c.inFlight()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the abort's own rejection does not count as a second failure (exactly one retry)", async () => {
    const h = harness();
    h.c.onImageError();
    vi.advanceTimersByTime(T);
    await flush();
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.state.pending).toEqual({ variant: "thumb", attempt: 2 });
  });

  it("never-settling requests, every load failing: thumb ×2, original ×2, then broken — four requests", async () => {
    const h = harness();
    h.c.onImageError();
    for (let i = 0; i < 2; i++) {
      vi.advanceTimersByTime(T);
      await flush();
    }
    expect(h.state.stage).toBe("original");
    h.c.onImageError(); // the original fails to load too
    for (let i = 0; i < 2; i++) {
      vi.advanceTimersByTime(T);
      await flush();
    }
    expect(h.calls.map((c) => c.variant)).toEqual(["thumb", "thumb", "original", "original"]);
    expect(h.state.stage).toBe("broken");
    expect(h.c.inFlight()).toBe(0);
  });
});

describe("rejection takes the SAME path as a timeout", () => {
  it("a rejected attempt 1 retries immediately as attempt 2 and clears its timer", async () => {
    const h = harness();
    h.c.onImageError();
    h.calls[0].reject(new TypeError("network"));
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.state.pending).toEqual({ variant: "thumb", attempt: 2 });
    expect(vi.getTimerCount()).toBe(1); // only attempt 2's
  });

  it("a request that THROWS synchronously is a rejection too", async () => {
    let state = initialGridPhoto(URLS);
    let n = 0;
    const c = createRemintController({
      urls: URLS,
      read: () => state,
      write: (s) => (state = s),
      request: () => {
        n++;
        throw new Error("boom");
      },
    });
    c.onImageError();
    await flush();
    await flush();
    expect(n).toBe(2);
    expect(state).toMatchObject({ stage: "original", pending: null });
  });
});

describe("results", () => {
  it("a URL lands: committed, its timer cleared", async () => {
    const h = harness();
    h.c.onImageError();
    h.calls[0].resolve("thumb-fresh");
    await flush();
    expect(h.state).toMatchObject({ stage: "thumb", src: "thumb-fresh", pending: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a definitive null (the route refused, incl. a middleware redirect): terminal, NO retry", async () => {
    const h = harness();
    h.c.onImageError();
    h.calls[0].resolve(null);
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.state).toMatchObject({ stage: "original", pending: null });
  });

  it("a late URL from a superseded attempt that IGNORED its abort is still used while the cell waits on that variant", async () => {
    const h = harness({ honourAbort: false });
    h.c.onImageError();
    vi.advanceTimersByTime(T);
    await flush();
    expect(h.calls).toHaveLength(2);
    h.calls[0].resolve("thumb-from-attempt-1");
    await flush();
    expect(h.state).toMatchObject({ stage: "thumb", src: "thumb-from-attempt-1", pending: null });
  });

  it("a late URL after the cell moved on is ignored", async () => {
    const h = harness({ honourAbort: false });
    h.c.onImageError();
    vi.advanceTimersByTime(T);
    await flush();
    vi.advanceTimersByTime(T);
    await flush();
    const gaveUp = h.state;
    h.calls[0].resolve("too-late");
    await flush();
    expect(h.state).toBe(gaveUp);
  });
});

describe("lifetime", () => {
  it("dispose (unmount / new server URLs) aborts every request, clears every timer, and commits nothing after", async () => {
    const h = harness({ honourAbort: false });
    h.c.onImageError();
    const before = h.writes.length;
    h.c.dispose();
    expect(h.calls[0].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    h.calls[0].resolve("late");
    vi.advanceTimersByTime(10 * T);
    await flush();
    expect(h.writes.length).toBe(before);
    h.c.onImageError();
    expect(h.calls).toHaveLength(1);
  });

  it("settle when the LIVE state has nothing pending aborts whatever is still in flight", async () => {
    const h = harness();
    h.c.onImageError();
    h.force({ ...h.state, pending: null }); // the cell moved on by another transition
    h.c.settle();
    expect(h.calls[0].signal.aborted).toBe(true);
    expect(h.c.inFlight()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Codex P2 4307931365: a STALE settle (the render saw nothing pending) never cancels a LIVE re-mint", async () => {
    // An image that failed BEFORE hydration: the per-src effect calls
    // onImageError(), which starts a re-mint and moves stateRef to pending,
    // and the next effect in the same commit, still holding the render's
    // `pending === null`, calls settle(). That must not abort the request,
    // or the cell stays pending on its dead URL forever.
    const h = harness();
    h.c.onImageError();
    h.c.settle();
    expect(h.calls[0].signal.aborted).toBe(false);
    expect(h.c.inFlight()).toBe(1);
    expect(h.state.pending).toEqual({ variant: "thumb", attempt: 1 });
    h.calls[0].resolve("thumb-fresh");
    await flush();
    expect(h.state).toMatchObject({ stage: "thumb", src: "thumb-fresh", pending: null });
  });

  it("activate after dispose (React StrictMode's effect replay) resumes the cell", async () => {
    const h = harness();
    h.c.dispose();
    h.c.activate();
    h.c.onImageError();
    expect(h.calls).toHaveLength(1);
  });

  it("Codex 4308035620: a StrictMode replay (start → dispose → activate) RE-ISSUES the pending attempt, and the cell recovers", async () => {
    const h = harness();
    h.c.onImageError(); // attempt 1 in flight, state pending
    h.c.dispose(); // StrictMode's simulated unmount aborts it...
    expect(h.calls[0].signal.aborted).toBe(true);
    expect(h.state.pending).toEqual({ variant: "thumb", attempt: 1 });
    h.c.activate(); // ...and the re-mount must not leave it stranded
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].signal.aborted).toBe(false);
    expect(h.c.inFlight()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    h.calls[1].resolve("thumb-fresh");
    await flush();
    expect(h.state).toMatchObject({ stage: "thumb", src: "thumb-fresh", pending: null });
  });

  it("activate re-issues the SAME attempt (the bound of four is unchanged) and nothing when an attempt is in flight", async () => {
    const h = harness();
    h.c.onImageError();
    h.c.activate(); // a plain mount with attempt 1 already in flight: nothing new
    expect(h.calls).toHaveLength(1);
    h.c.dispose();
    h.c.activate();
    vi.advanceTimersByTime(T); // the re-issued attempt 1 times out → attempt 2
    await flush();
    expect(h.calls).toHaveLength(3);
    expect(h.state.pending).toEqual({ variant: "thumb", attempt: 2 });
  });
});

describe("oncePerErrorEvent (Codex 4308035614): one error EVENT, one transition", () => {
  it("the same DOM event via React's onError (nativeEvent) AND the native listener → handled ONCE", () => {
    const h = harness();
    const onError = oncePerErrorEvent(() => h.c.onImageError());
    const ev = new Event("error");
    onError({ nativeEvent: ev }); // React's synthetic event
    onError(ev); // the native listener, same event
    expect(h.calls).toHaveLength(1);
    expect(h.writes).toHaveLength(1);
  });

  it("the double delivery used to demote AND fail the original from one event; now the original is untouched", async () => {
    const h = harness();
    h.c.onImageError();
    h.calls[0].resolve(null); // the derivative refused → demoted to the original
    await flush();
    expect(h.state.stage).toBe("original");
    const onError = oncePerErrorEvent(() => h.c.onImageError());
    const lateDuplicate = new Event("error");
    onError({ nativeEvent: lateDuplicate });
    const before = h.calls.length;
    onError(lateDuplicate); // same event again, through the other path
    expect(h.calls.length).toBe(before);
  });

  it("DIFFERENT events are each handled; a call with no event (the already-failed check) always passes", () => {
    let n = 0;
    const onError = oncePerErrorEvent(() => n++);
    onError(new Event("error"));
    onError(new Event("error"));
    onError();
    onError();
    expect(n).toBe(4);
  });
});


// CLN-005 uses the same deferred-request style as the existing remint cases.
import { createPhotoPreviewController, type PhotoPreviewState } from "@/lib/images/photo-preview-controller";

function previewRequests() {
  let state: PhotoPreviewState | null = null;
  const calls: Array<{ imageId: string; resolve: (r: { ok: true; url: string } | { ok: false }) => void; reject: (e: unknown) => void }> = [];
  const writes: Array<PhotoPreviewState | null> = [];
  const controller = createPhotoPreviewController({
    request: (imageId) => new Promise((resolve, reject) => calls.push({ imageId, resolve, reject })),
    write: (next) => { state = next; writes.push(next); },
  });
  return { controller, calls, writes, get state() { return state; } };
}

describe("CLN-005: preview results belong to the current image generation", () => {
  it("delayed A cannot replace B's URL under B's metadata", async () => {
    const h = previewRequests();
    const a = h.controller.open("A");
    const b = h.controller.open("B");
    h.calls[1].resolve({ ok: true, url: "signed-B" }); await b;
    h.calls[0].resolve({ ok: true, url: "signed-A" }); await a;
    expect(h.state).toMatchObject({ imageId: "B", status: "ready", url: "signed-B" });
    expect(h.writes.some((s) => s?.url === "signed-A")).toBe(false);
  });

  it("A's rejection cannot stop B's loading or mark B unavailable", async () => {
    const h = previewRequests();
    const a = h.controller.open("A"); const b = h.controller.open("B");
    h.calls[0].reject(new Error("A failed")); await a;
    expect(h.state).toMatchObject({ imageId: "B", status: "loading", url: null });
    h.calls[1].resolve({ ok: true, url: "signed-B" }); await b;
    expect(h.state?.url).toBe("signed-B");
  });

  it("close invalidates a pending reply and does not reopen the preview", async () => {
    const h = previewRequests(); const a = h.controller.open("A");
    h.controller.close(); h.calls[0].resolve({ ok: true, url: "signed-A" }); await a;
    expect(h.state).toBeNull();
  });

  it("reopening the SAME image cannot accept its earlier generation", async () => {
    const h = previewRequests(); const old = h.controller.open("A");
    h.controller.close(); const fresh = h.controller.open("A");
    h.calls[0].resolve({ ok: true, url: "expired-A" }); await old;
    expect(h.state).toMatchObject({ imageId: "A", status: "loading", url: null });
    h.calls[1].resolve({ ok: true, url: "fresh-A" }); await fresh;
    expect(h.state?.url).toBe("fresh-A");
  });

  it.each(["refusal", "rejection"])("current signing %s becomes explicit unavailable state", async (failure) => {
    const h = previewRequests(); const a = h.controller.open("A");
    if (failure === "refusal") h.calls[0].resolve({ ok: false });
    else h.calls[0].reject(new Error("signing unavailable"));
    await a;
    expect(h.state).toMatchObject({ imageId: "A", status: "error", url: null });
  });

  it("unmount disposal prevents any later state write", async () => {
    const h = previewRequests(); const a = h.controller.open("A");
    const writes = h.writes.length; h.controller.dispose();
    h.calls[0].resolve({ ok: true, url: "signed-A" }); await a;
    expect(h.writes).toHaveLength(writes);
  });

  it("an old image error cannot clear the current image", async () => {
    const h = previewRequests(); const a = h.controller.open("A");
    const oldGeneration = h.state!.generation;
    h.calls[0].resolve({ ok: true, url: "signed-A" }); await a;
    const b = h.controller.open("B");h.calls[1].resolve({ ok: true, url: "signed-B" }); await b;
    h.controller.onImageError("A", oldGeneration);
    expect(h.state?.url).toBe("signed-B");
    h.controller.onImageError("B", h.state!.generation);
    expect(h.state).toMatchObject({ imageId: "B", status: "error", url: null });
  });
});
