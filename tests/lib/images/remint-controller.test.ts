import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GRID_PHOTO_REMINT_TIMEOUT_MS,
  initialGridPhoto,
  type GridPhotoState,
  type GridPhotoUrls,
  type GridPhotoVariant,
} from "@/lib/images/grid-photo-recovery";
import { createRemintController } from "@/lib/images/remint-controller";

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
  return { c, calls, writes, get state() { return state; } };
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

  it("settle (nothing pending any more) aborts whatever is still in flight", async () => {
    const h = harness();
    h.c.onImageError();
    h.c.settle();
    expect(h.calls[0].signal.aborted).toBe(true);
    expect(h.c.inFlight()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("activate after dispose (React StrictMode's effect replay) resumes the cell", async () => {
    const h = harness();
    h.c.dispose();
    h.c.activate();
    h.c.onImageError();
    expect(h.calls).toHaveLength(1);
  });
});
