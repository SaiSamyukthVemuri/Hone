"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { SessionPhoto } from "./session-photos";
import { getTreatmentImageSignedUrlAction } from "../../images/actions";
import {
  initialGridPhoto,
  onGridPhotoError,
  onGridPhotoRemint,
  type GridPhotoState,
} from "@/lib/images/grid-photo-recovery";

// FETT photos (HON-43): the photos attached to this visit, on the visit's own
// chart page, so before/after photos sit with the treatment they document.
// Read-only: adding, captioning and archiving stay on the Photos tab, which
// this links to. Renders nothing when the visit has no photos.
//
// Loading is EAGER on purpose (Codex P1 4301862700): the URLs live 60 s, and a
// lazy image below the fold could be requested only after its URL expired.
// Each cell runs the SAME bounded recovery as the Photos-tab grid (#913,
// lib/images/grid-photo-recovery.ts): derivative, then original, re-minting an
// EXPIRED URL once per variant (a chart left open, or restored from the router
// cache), and only then the "reload" note, never a broken image.
export function SessionPhotos({ clientId, photos }: { clientId: string; photos: SessionPhoto[] }) {
  if (photos.length === 0) return null;
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
      aria-labelledby="session-photos-heading"
      data-testid="session-photos"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="session-photos-heading" className="text-lg font-medium">
          Photos from this visit
        </h2>
        <Link
          href={`/clients/${clientId}/images`}
          className="inline-flex min-h-[44px] items-center text-sm font-medium underline"
        >
          Open Photos
        </Link>
      </div>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {photos.map((p) => (
          <SessionPhotoCell key={`${p.id}:${p.url}:${p.thumbUrl ?? ""}`} photo={p} />
        ))}
      </ul>
    </section>
  );
}

function SessionPhotoCell({ photo: p }: { photo: SessionPhoto }) {
  const [state, setState] = useState<GridPhotoState>(() => initialGridPhoto({ previewUrl: p.url, thumbUrl: p.thumbUrl }));
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
    const urls = { previewUrl: p.url, thumbUrl: p.thumbUrl };
    const next = onGridPhotoError(stateRef.current, urls);
    stateRef.current = next.state;
    setState(next.state);
    if (!next.remint) return;
    const variant = next.remint;
    void getTreatmentImageSignedUrlAction({ imageId: p.id, variant })
      .then((res) => (res.ok ? res.url : null))
      .catch(() => null)
      .then((fresh) => {
        if (!alive.current) return;
        const landed = onGridPhotoRemint(stateRef.current, urls, variant, fresh);
        stateRef.current = landed;
        setState(landed);
      });
  }, [p.id, p.url, p.thumbUrl]);

  // An image that failed BEFORE hydration never reached React's onError.
  useEffect(() => {
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth === 0 && el.getAttribute("src")) handleError();
  }, [state.src, handleError]);

  const area = p.areaLabel;
  return (
    <li className="flex flex-col gap-1">
      {state.stage === "broken" || !state.src ? (
        <p className="flex aspect-square w-full items-center justify-center rounded-md bg-neutral-100 p-2 text-center text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
          Photo unavailable — reload to view
        </p>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
        <img
          ref={imgRef}
          src={state.src}
          alt={area ? `Treatment photo, ${area}` : "Treatment photo from this visit"}
          className="aspect-square w-full rounded-md object-cover"
          data-stage={state.stage}
          onError={handleError}
        />
      )}
      {area && <span className="text-xs text-neutral-600 dark:text-neutral-300">{area}</span>}
      {p.note && <span className="text-xs text-neutral-500">{p.note}</span>}
    </li>
  );
}
