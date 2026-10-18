"use client";

import { useCallback } from "react";
import { getTreatmentImageSignedUrlAction } from "./images/actions";
import type { GridPhotoVariant } from "@/lib/images/grid-photo-recovery";
import { useGridPhotoRecovery } from "@/lib/images/use-grid-photo-recovery";

// FETT photos (HON-43), 0231: the client's ID photo in the profile header.
// The avatar is 56 px, so it loads the bounded derivative first (Codex P2
// 4302682032) and demotes to the original (PERF-IMG-03). A signed URL that
// EXPIRED before the image was requested (60 s TTL; a page left open, or one
// restored from the router cache) is re-minted through the same server action
// the Photos tab uses, by the SHARED bounded recovery
// (lib/images/use-grid-photo-recovery.ts: one retry on a timed-out or rejected
// re-mint, then terminal). If everything fails, the header simply shows no
// portrait. The parent keys this by the server URLs, so fresh URLs remount it.
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
  const remint = useCallback(
    (variant: GridPhotoVariant) =>
      getTreatmentImageSignedUrlAction({ imageId, variant }).then((res) => (res.ok ? res.url : null)),
    [imageId],
  );
  const { state, imgRef, onError } = useGridPhotoRecovery({ previewUrl: url, thumbUrl, remint });

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
      onError={onError}
    />
  );
}
