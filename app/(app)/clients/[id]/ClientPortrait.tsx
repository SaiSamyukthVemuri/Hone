"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getTreatmentImageSignedUrlAction } from "./images/actions";
import {
  initialGridPhoto,
  onGridPhotoError,
  onGridPhotoRemint,
  type GridPhotoState,
} from "@/lib/images/grid-photo-recovery";

// FETT photos (HON-43), 0231: the client's ID photo in the profile header.
// The avatar is 56 px, so it loads the bounded derivative first (Codex P2
// 4302682032) and demotes to the original (PERF-IMG-03). A signed URL that
// EXPIRED before the image was requested (60 s TTL; a page left open, or one
// restored from the router cache) is re-minted ONCE per variant through the
// same server action the Photos tab uses, the bounded transitions in
// lib/images/grid-photo-recovery.ts. If everything fails, the header simply
// shows no portrait. The parent keys this by the server URLs, so fresh URLs
// remount it.
export function ClientPortrait({
  imageId,
  url,
  thumbUrl,
  clientName,
}: {
  imageId: string;
  url: string;
  thumbUrl: string | null;
  clientName: string;
}) {
  const [state, setState] = useState<GridPhotoState>(() => initialGridPhoto({ previewUrl: url, thumbUrl }));
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
    const urls = { previewUrl: url, thumbUrl };
    const next = onGridPhotoError(stateRef.current, urls);
    stateRef.current = next.state;
    setState(next.state);
    if (!next.remint) return;
    const variant = next.remint;
    void getTreatmentImageSignedUrlAction({ imageId, variant })
      .then((res) => (res.ok ? res.url : null))
      .catch(() => null)
      .then((fresh) => {
        if (!alive.current) return;
        const landed = onGridPhotoRemint(stateRef.current, urls, variant, fresh);
        stateRef.current = landed;
        setState(landed);
      });
  }, [imageId, url, thumbUrl]);

  // An image that failed BEFORE hydration never reached React's onError.
  useEffect(() => {
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth === 0 && el.getAttribute("src")) handleError();
  }, [state.src, handleError]);

  if (state.stage === "broken" || !state.src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL; next/image would re-host it
    <img
      ref={imgRef}
      src={state.src}
      alt={`ID photo of ${clientName}`}
      width={56}
      height={56}
      className="h-14 w-14 shrink-0 rounded-full object-cover ring-1 ring-neutral-200 dark:ring-neutral-700"
      data-testid="client-portrait"
      data-stage={state.stage}
      onError={handleError}
    />
  );
}
