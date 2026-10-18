"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GRID_PHOTO_REMINT_TIMEOUT_MS,
  initialGridPhoto,
  onGridPhotoError,
  onGridPhotoRemint,
  onGridPhotoRemintFailed,
  type GridPhotoState,
  type GridPhotoUrls,
  type GridPhotoVariant,
  type RemintRequest,
} from "./grid-photo-recovery";

// FETT photos (HON-43): the ONE client-side driver for every photo cell (the
// Photos grid, the profile ID photo, the visit chart). The pure, bounded
// transitions live in ./grid-photo-recovery; this hook only wires them to the
// DOM and to the re-mint call, so all three cells behave identically.
//
// * Transitions run against a ref, never inside a state updater, so React may
//   re-run an updater without issuing a second re-mint request.
// * Every re-mint has a TIMER (GRID_PHOTO_REMINT_TIMEOUT_MS). A re-mint that
//   neither lands nor rejects in time is treated as failed: retried once, then
//   terminal. A REJECTED call takes the same path. Timers are cleared when the
//   re-mint ends, when the src changes, and on unmount.
// * An image that fails AROUND hydration can be missed by React's onError.
//   Per src: an image that has already failed (`complete`, no pixels) is
//   handled now; otherwise a NATIVE error listener catches a later failure. A
//   duplicate signal is a no-op (errors are ignored while a re-mint is pending).
//
// `remint` is the server call that signs a fresh URL for one variant, passed
// in by the cell so this module never imports application code. It resolves to
// the URL, or null when the server has nothing to give.
export function useGridPhotoRecovery(input: {
  previewUrl: string | null;
  thumbUrl: string | null;
  remint: (variant: GridPhotoVariant) => Promise<string | null>;
}) {
  const { previewUrl, thumbUrl, remint } = input;
  const [state, setState] = useState<GridPhotoState>(() => initialGridPhoto({ previewUrl, thumbUrl }));
  const imgRef = useRef<HTMLImageElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const alive = useRef(true);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const clearTimers = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current.clear();
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimers();
    };
  }, [clearTimers]);

  const commit = useCallback((next: GridPhotoState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const issue = useCallback(
    function issueRemint(req: RemintRequest) {
      const urls: GridPhotoUrls = { previewUrl, thumbUrl };
      let settled = false;
      const fail = () => {
        if (settled || !alive.current) return;
        settled = true;
        const next = onGridPhotoRemintFailed(stateRef.current, urls, req.variant, req.attempt);
        commit(next.state);
        if (next.remint) issueRemint(next.remint);
      };
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        fail();
      }, GRID_PHOTO_REMINT_TIMEOUT_MS);
      timers.current.add(timer);
      remint(req.variant).then(
        (url) => {
          clearTimeout(timer);
          timers.current.delete(timer);
          if (!alive.current) return;
          settled = true;
          commit(onGridPhotoRemint(stateRef.current, urls, req.variant, url));
        },
        () => {
          clearTimeout(timer);
          timers.current.delete(timer);
          fail();
        },
      );
    },
    [previewUrl, thumbUrl, remint, commit],
  );

  const handleError = useCallback(() => {
    const next = onGridPhotoError(stateRef.current, { previewUrl, thumbUrl });
    commit(next.state);
    if (next.remint) issue(next.remint);
  }, [previewUrl, thumbUrl, commit, issue]);

  // Per src: catch an image that already failed, and listen natively for a
  // later failure. The listener is removed when the src changes or on unmount.
  useEffect(() => {
    const el = imgRef.current;
    if (!el || !el.getAttribute("src")) return;
    if (el.complete && el.naturalWidth === 0) {
      handleError();
      return;
    }
    const onNativeError = () => handleError();
    el.addEventListener("error", onNativeError);
    return () => el.removeEventListener("error", onNativeError);
  }, [state.src, handleError]);

  // Nothing pending (a URL landed, or the cell gave up): no timer may outlive it.
  useEffect(() => {
    if (!state.pending) clearTimers();
  }, [state.pending, clearTimers]);

  return { state, imgRef, onError: handleError };
}
