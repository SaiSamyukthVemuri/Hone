"use client";

import { useState } from "react";

// FETT photos (HON-43), 0231: the client's ID photo in the profile header.
// The avatar is 56 px, so it loads the bounded derivative first (Codex P2
// 4302682032) and demotes to the original only if the derivative will not load
// (legacy photo or missing thumb), the Photos tab rule (PERF-IMG-03). If the
// original fails too, the header simply shows no portrait.
export function ClientPortrait({
  url,
  thumbUrl,
  clientName,
}: {
  url: string;
  thumbUrl: string | null;
  clientName: string;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  const useThumb = Boolean(thumbUrl) && !thumbFailed;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL; next/image would re-host it
    <img
      src={(useThumb ? thumbUrl : url) ?? url}
      alt={`ID photo of ${clientName}`}
      width={56}
      height={56}
      className="h-14 w-14 shrink-0 rounded-full object-cover ring-1 ring-neutral-200 dark:ring-neutral-700"
      data-testid="client-portrait"
      onError={() => {
        if (useThumb) setThumbFailed(true);
        else setBroken(true);
      }}
    />
  );
}
