"use client";

import { useState } from "react";
import Link from "next/link";
import type { SessionPhoto } from "./session-photos";

// FETT photos (HON-43): the photos attached to this visit, on the visit's own
// chart page, so before/after photos sit with the treatment they document.
// Read-only: adding, captioning and archiving stay on the Photos tab, which
// this links to. Renders nothing when the visit has no photos.
//
// Loading is EAGER on purpose (Codex P1 4301862700): the URLs live 60 s, and a
// lazy image below the fold could be requested only after its URL expired. The
// grid uses the derivative and demotes to the original if it will not load
// (Photos tab rule, PERF-IMG-03); only an original that fails shows the
// "reload" note, never a broken image.
export function SessionPhotos({ clientId, photos }: { clientId: string; photos: SessionPhoto[] }) {
  const [thumbFailed, setThumbFailed] = useState<Record<string, boolean>>({});
  const [broken, setBroken] = useState<Record<string, boolean>>({});
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
        {photos.map((p) => {
          const area = p.areaLabel;
          const useThumb = Boolean(p.thumbUrl) && !thumbFailed[p.id];
          return (
            <li key={p.id} className="flex flex-col gap-1">
              {broken[p.id] ? (
                <p className="flex aspect-square w-full items-center justify-center rounded-md bg-neutral-100 p-2 text-center text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
                  Photo unavailable — reload to view
                </p>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                <img
                  src={(useThumb ? p.thumbUrl : p.url) ?? p.url}
                  alt={area ? `Treatment photo, ${area}` : "Treatment photo from this visit"}
                  className="aspect-square w-full rounded-md object-cover"
                  onError={() => {
                    if (useThumb) setThumbFailed((t) => ({ ...t, [p.id]: true }));
                    else setBroken((b) => ({ ...b, [p.id]: true }));
                  }}
                />
              )}
              {area && <span className="text-xs text-neutral-600 dark:text-neutral-300">{area}</span>}
              {p.note && <span className="text-xs text-neutral-500">{p.note}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
