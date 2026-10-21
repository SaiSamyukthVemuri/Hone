"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { currentGridPhoto, initialGridPhoto, type GridPhotoState } from "./grid-photo-recovery";
import { createRemintController, oncePerErrorEvent, type RemintController } from "./remint-controller";
import { fetchSignedImageUrl } from "./remint-request";

// FETT photos (HON-43): the ONE client-side driver for every photo cell (the
// Photos grid, the profile ID photo, the visit chart). The pure, bounded
// transitions live in ./grid-photo-recovery; the clock and the network live in
// ./remint-controller; this hook only wires them to React and the DOM, so all
// three cells behave identically.
//
// * The re-mint is a plain, ABORTABLE GET to the signed-url route
//   (./remint-request), never a server action: Next runs a page's server
//   actions one at a time, so a hung re-mint action held its own retry and
//   every later action on the page (Codex P1 4307807754). Each attempt has a
//   timer; on timeout it is aborted and retried once as a NEW request, then
//   the cell gives up on that variant.
// * Transitions run against a ref, never inside a state updater, so React may
//   re-run an updater without issuing a second request.
// * One controller per cell's server URLs. Unmount, or new URLs, abort every
//   request and clear every timer; once nothing is pending, anything still in
//   flight is aborted too.
// * An image that fails AROUND hydration can be missed by React's onError.
//   Per src: an image that has already failed (`complete`, no pixels) is
//   handled now; otherwise a NATIVE error listener catches a later failure.
//   React's onError and that listener receive the SAME event, which is
//   handled once (oncePerErrorEvent); a duplicate signal for an earlier event
//   is a no-op too (errors are ignored while a re-mint is pending).
export function useGridPhotoRecovery(input: {
  previewUrl: string | null;
  thumbUrl: string | null;
  clientId: string;
  imageId: string;
}) {
  const { previewUrl, thumbUrl, clientId, imageId } = input;
  const [storedState, setState] = useState<GridPhotoState>(() => initialGridPhoto({ previewUrl, thumbUrl }));
  const state = currentGridPhoto(storedState, { previewUrl, thumbUrl });
  const imgRef = useRef<HTMLImageElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Created during render (not in an effect) so an error that fires before
  // effects run still has a controller to report to.
  const key = `${clientId}\n${imageId}\n${previewUrl ?? ""}\n${thumbUrl ?? ""}`;
  const ctl = useRef<{ key: string; c: RemintController } | null>(null);
  if (!ctl.current || ctl.current.key !== key) {
    ctl.current?.c.dispose();
    ctl.current = {
      key,
      c: createRemintController({
        urls: { previewUrl, thumbUrl },
        request: (variant, signal) => fetchSignedImageUrl({ clientId, imageId, variant, signal }),
        read: () => stateRef.current,
        write: (next) => {
          stateRef.current = next;
          setState(next);
        },
      }),
    };
  }
  const controller = ctl.current.c;

  useEffect(() => {
    controller.activate();
    return () => controller.dispose();
  }, [controller]);

  // React's onError and the native listener both receive each error event;
  // it is handled once (Codex 4308035614).
  const handleError = useMemo(() => oncePerErrorEvent(() => controller.onImageError()), [controller]);

  // Per src: catch an image that already failed, and listen natively for a
  // later failure. The listener is removed when the src changes or on unmount.
  useEffect(() => {
    const el = imgRef.current;
    if (!el || !el.getAttribute("src")) return;
    if (el.complete && el.naturalWidth === 0) {
      handleError();
      return;
    }
    const onNativeError = (e: Event) => handleError(e);
    el.addEventListener("error", onNativeError);
    return () => el.removeEventListener("error", onNativeError);
  }, [state.src, handleError]);

  // Nothing pending (a URL landed, or the cell gave up): no request or timer
  // may outlive it.
  useEffect(() => {
    if (!state.pending) controller.settle();
  }, [state.pending, controller]);

  return { state, imgRef, onError: handleError };
}
