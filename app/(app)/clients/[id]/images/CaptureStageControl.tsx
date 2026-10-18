"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  setTreatmentImageCaptureStageAction,
  type TreatmentImageCaptureStage,
} from "./actions";

// FETT photos (HON-43), 0232: label a VISIT photo as taken before or after
// treatment, on its Photos-tab tile. Offered ONLY on photos linked to a visit:
// the database refuses a stage on a client-scoped photo, so the UI never offers
// one. Until the upload choice ships (after #892), a photo is labelled right
// after it is attached, from here. Uses the shared Button, so every control is
// on the 44px touch floor by construction. Errors stay generic.
const LABEL: Record<TreatmentImageCaptureStage, string> = { before: "Before", after: "After" };

export function CaptureStageControl({
  clientId,
  imageId,
  visitPhoto,
  stage,
}: {
  clientId: string;
  imageId: string;
  visitPhoto: boolean;
  stage: TreatmentImageCaptureStage | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!visitPhoto) return null;

  function save(next: TreatmentImageCaptureStage | null) {
    setError(null);
    startTransition(async () => {
      const res = await setTreatmentImageCaptureStageAction({ imageId, clientId, stage: next });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-1" data-testid="capture-stage">
      <div className="flex flex-wrap items-center gap-2">
        {stage ? (
          <span
            className="rounded-full bg-neutral-900 px-2 py-0.5 text-xs font-medium text-white dark:bg-white dark:text-neutral-900"
            data-testid="capture-stage-badge"
          >
            {LABEL[stage]}
          </span>
        ) : (
          <span className="text-xs text-neutral-500">Not labelled</span>
        )}
        <div role="group" aria-label="Taken before or after treatment" className="flex flex-wrap gap-1">
          {(["before", "after"] as const).map((s) => (
            <Button
              key={s}
              variant="quiet"
              size="sm"
              aria-pressed={stage === s}
              disabled={pending || stage === s}
              onClick={() => save(s)}
            >
              {LABEL[s]}
            </Button>
          ))}
          {stage && (
            <Button variant="quiet" size="sm" pending={pending} busyLabel="Clearing…" onClick={() => save(null)}>
              Clear label
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
