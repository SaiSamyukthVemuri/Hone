import {
  GRID_PHOTO_REMINT_TIMEOUT_MS,
  onGridPhotoError,
  onGridPhotoRemint,
  onGridPhotoRemintFailed,
  type GridPhotoState,
  type GridPhotoUrls,
  type GridPhotoVariant,
  type RemintRequest,
} from "./grid-photo-recovery";

// FETT photos (HON-43): drives ONE photo cell's re-mints in time. The pure
// transitions live in ./grid-photo-recovery; this adds the clock and the
// network, with no React, so it is unit-testable with fake timers. The hook
// (./use-grid-photo-recovery) owns one controller per cell.
//
// Each attempt gets its OWN AbortController and timer:
//   * timeout   -> ABORT the in-flight request, then the failed path (attempt
//                  1 retries as a NEW request; attempt 2 gives up);
//   * rejection -> the same failed path (a network error, or the abort above,
//                  which is ignored because that attempt already failed);
//   * a URL     -> committed whenever the cell still waits on that variant,
//                  even from a superseded attempt (a request that ignored its
//                  abort); the machine ignores it once the cell has moved on.
// `dispose` (unmount, or new server URLs) aborts everything and clears every
// timer; nothing commits after it. `settle` (nothing pending any more) aborts
// whatever is still in flight.

export type RemintFetch = (variant: GridPhotoVariant, signal: AbortSignal) => Promise<string | null>;

type Attempt = { ac: AbortController; timer: ReturnType<typeof setTimeout>; failed: boolean };

export type RemintController = {
  onImageError: () => void;
  settle: () => void;
  dispose: () => void;
  activate: () => void;
  /** In-flight attempts (tests and diagnostics only). */
  inFlight: () => number;
};

export function createRemintController(deps: {
  urls: GridPhotoUrls;
  request: RemintFetch;
  read: () => GridPhotoState;
  write: (next: GridPhotoState) => void;
  timeoutMs?: number;
}): RemintController {
  const { urls, request, read, write } = deps;
  const timeoutMs = deps.timeoutMs ?? GRID_PHOTO_REMINT_TIMEOUT_MS;
  const attempts = new Set<Attempt>();
  let disposed = false;

  const end = (a: Attempt) => {
    clearTimeout(a.timer);
    attempts.delete(a);
  };

  function issue(req: RemintRequest) {
    if (disposed) return;
    const a: Attempt = { ac: new AbortController(), timer: undefined as never, failed: false };
    const fail = () => {
      if (a.failed || disposed) return;
      a.failed = true;
      end(a);
      const next = onGridPhotoRemintFailed(read(), urls, req.variant, req.attempt);
      write(next.state);
      if (next.remint) issue(next.remint);
    };
    a.timer = setTimeout(() => {
      a.ac.abort();
      fail();
    }, timeoutMs);
    attempts.add(a);
    let pending: Promise<string | null>;
    try {
      pending = request(req.variant, a.ac.signal);
    } catch (e) {
      pending = Promise.reject(e);
    }
    pending.then(
      (url) => {
        if (disposed) return;
        end(a);
        write(onGridPhotoRemint(read(), urls, req.variant, url));
      },
      () => fail(),
    );
  }

  return {
    onImageError() {
      if (disposed) return;
      const next = onGridPhotoError(read(), urls);
      write(next.state);
      if (next.remint) issue(next.remint);
    },
    settle() {
      for (const a of [...attempts]) {
        a.failed = true;
        end(a);
        a.ac.abort();
      }
    },
    dispose() {
      disposed = true;
      for (const a of [...attempts]) {
        a.failed = true;
        end(a);
        a.ac.abort();
      }
    },
    activate() {
      disposed = false;
    },
    inFlight: () => attempts.size,
  };
}
