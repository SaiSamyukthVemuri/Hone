"use client";

import { useGridPhotoRecovery } from "@/lib/images/use-grid-photo-recovery";

// FETT photos (HON-43): one Photos-tab grid cell. It renders the derivative,
// demotes to the original, and re-mints an EXPIRED signed URL through the
// abortable signed-url route (never a server action, which would queue every
// other action on the page behind a hung one). The bounded recovery (one retry
// on a timed-out or rejected re-mint, then terminal; the hydration-window
// check) is lib/images/use-grid-photo-recovery.ts, shared with the profile ID
// photo and the visit chart. The hook resets recovery on fresh server URLs;
// the parent keeps image identity stable so the preview opener stays mounted.
export function GridPhoto({
  clientId,
  imageId,
  previewUrl,
  thumbUrl,
  onOpen,
}: {
  clientId: string;
  imageId: string;
  previewUrl: string | null;
  thumbUrl: string | null;
  onOpen: () => void;
}) {
  const { state, imgRef, onError } = useGridPhotoRecovery({ previewUrl, thumbUrl, clientId, imageId });

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
