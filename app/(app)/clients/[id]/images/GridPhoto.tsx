"use client";

import { useCallback } from "react";
import { getTreatmentImageSignedUrlAction } from "./actions";
import type { GridPhotoVariant } from "@/lib/images/grid-photo-recovery";
import { useGridPhotoRecovery } from "@/lib/images/use-grid-photo-recovery";

// FETT photos (HON-43): one Photos-tab grid cell. It renders the derivative,
// demotes to the original, and re-mints an EXPIRED signed URL through the same
// server action "View larger" uses. The bounded recovery (one retry on a
// timed-out or rejected re-mint, then terminal; the hydration-window check) is
// lib/images/use-grid-photo-recovery.ts, shared with the profile ID photo and
// the visit chart. The parent keys this component by the server URLs, so fresh
// URLs from router.refresh() remount it and clear any failure.
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
  const remint = useCallback(
    (variant: GridPhotoVariant) =>
      getTreatmentImageSignedUrlAction({ imageId, variant }).then((res) => (res.ok ? res.url : null)),
    [imageId],
  );
  const { state, imgRef, onError } = useGridPhotoRecovery({ previewUrl, thumbUrl, remint });

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
        onError={onError}
        data-stage={state.stage}
        className="aspect-square w-full object-cover transition hover:opacity-90"
      />
    </button>
  );
}
