"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getTreatmentImageSignedUrlAction } from "./actions";
import {
  initialGridPhoto,
  onGridPhotoError,
  onGridPhotoRemint,
  type GridPhotoState,
} from "@/lib/images/grid-photo-recovery";

// FETT photos (HON-43): one Photos-tab grid cell. It renders the derivative,
// demotes to the original, and, when a signed URL has EXPIRED before the lazy
// image was requested, re-mints a fresh URL ONCE per variant through the same
// server action "View larger" uses (lib/images/grid-photo-recovery.ts holds the
// bounded transitions). The parent keys this component by the server URLs, so
// fresh URLs from router.refresh() remount it and clear any failure.
export function GridPhoto({
  imageId,
  previewUrl,
  thumbUrl,
  onOpen,
}: {
  imageId: string;
  previewUrl: string | null;
  thumbUrl: string | null;
  onOpen: () => void;
}) {
  const urls = { previewUrl, thumbUrl };
  const [state, setState] = useState<GridPhotoState>(() => initialGridPhoto(urls));
  const imgRef = useRef<HTMLImageElement | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Transitions run against a ref, never inside a state updater, so React may
  // re-run an updater without issuing a second re-mint request.
  const stateRef = useRef(state);
  stateRef.current = state;
  const handleError = useCallback(() => {
    const next = onGridPhotoError(stateRef.current, { previewUrl, thumbUrl });
    stateRef.current = next.state;
    setState(next.state);
    if (!next.remint) return;
    const variant = next.remint;
    void getTreatmentImageSignedUrlAction({ imageId, variant })
      .then((res) => (res.ok ? res.url : null))
      .catch(() => null)
      .then((url) => {
        if (!alive.current) return;
        const landed = onGridPhotoRemint(stateRef.current, { previewUrl, thumbUrl }, variant, url);
        stateRef.current = landed;
        setState(landed);
      });
  }, [imageId, previewUrl, thumbUrl]);

  // An image that fails AROUND hydration can be missed by React's onError
  // (observed: 2 of 7 strong-expiry browser runs left a cell on a dead URL with
  // no re-mint). So, per src, after mount:
  //   * already failed (`complete` with no pixels) -> handle it now;
  //   * otherwise attach a NATIVE error listener, which catches any later
  //     failure regardless of React's listener.
  // React's onError and this listener can both fire for one failure; the
  // second is a no-op, because the machine ignores errors while a re-mint is
  // pending and the state ref is updated synchronously.
  // A lazy image not yet requested is not `complete`, so it gets the listener.
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

  if (state.stage === "broken" || !state.src) {
    return (
      <div className="grid aspect-square w-full place-items-center rounded-md bg-neutral-100 text-xs text-neutral-400 dark:bg-neutral-900">
        Image not available
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block overflow-hidden rounded-md"
      aria-label="View larger treatment photo"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imgRef}
        src={state.src}
        alt="Treatment photo"
        loading="lazy"
        onError={handleError}
        data-stage={state.stage}
        className="aspect-square w-full object-cover transition hover:opacity-90"
      />
    </button>
  );
}
