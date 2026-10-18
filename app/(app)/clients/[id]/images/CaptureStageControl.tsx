"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  setTreatmentImageCaptureStageAction,
  type TreatmentImageCaptureStage,
} from "./actions";

// FETT photos (HON-43), 0232: label a VISIT photo as taken before or after
// treatment, on its Photos-tab tile (the upload panel offers the same choice
// at attach time). Offered ONLY on photos linked to a visit: the database
// refuses a stage on a client-scoped photo, so the UI never offers one. Uses
// the shared Button, so every control is on the 44px touch floor by
// construction. Errors stay generic.
//
// KEYBOARD: a choice never disables its own button (pressing the current
// stage is a no-op; aria-pressed carries the state). All three are disabled
// only while a save is in flight, and focus then returns to the button that
// was pressed; after "Clear label" (which unmounts) it moves to "Before". The
// result is announced in a visually hidden live region.
const LABEL: Record<TreatmentImageCaptureStage, string> = { before: "Before", after: "After" };
const ANNOUNCE: Record<TreatmentImageCaptureStage | "cleared", string> = {
  before: "Labelled Before",
  after: "Labelled After",
  cleared: "Label cleared",
};

type FocusTarget = TreatmentImageCaptureStage | "clear";

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
  const [announcement, setAnnouncement] = useState("");
  const group = useRef<HTMLDivElement | null>(null);
  const refocus = useRef<FocusTarget | null>(null);

  // Once the save settles and the buttons are enabled again, put focus back
  // where the keyboard user left it ("clear" no longer exists: use "before").
  useEffect(() => {
    if (pending || !refocus.current) return;
    const target = refocus.current === "clear" && !stage ? "before" : refocus.current;
    refocus.current = null;
    group.current?.querySelector<HTMLButtonElement>(`[data-stage-button="${target}"]`)?.focus();
  }, [pending, stage]);

  if (!visitPhoto) return null;

  function save(next: TreatmentImageCaptureStage | null, from: FocusTarget) {
    if (next === stage) return; // already this label: nothing to save
    setError(null);
    refocus.current = from;
    startTransition(async () => {
      const res = await setTreatmentImageCaptureStageAction({ imageId, clientId, stage: next });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setAnnouncement(ANNOUNCE[next ?? "cleared"]);
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
        <div ref={group} role="group" aria-label="Taken before or after treatment" className="flex flex-wrap gap-1">
          {(["before", "after"] as const).map((s) => (
            <Button
              key={s}
              variant="quiet"
              size="sm"
              data-stage-button={s}
              aria-pressed={stage === s}
              disabled={pending}
              onClick={() => save(s, s)}
            >
              {LABEL[s]}
            </Button>
          ))}
          {stage && (
            <Button
              variant="quiet"
              size="sm"
              data-stage-button="clear"
              pending={pending}
              busyLabel="Clearing…"
              onClick={() => save(null, "clear")}
            >
              Clear label
            </Button>
          )}
        </div>
      </div>
      <p className="sr-only" aria-live="polite" data-testid="capture-stage-announce">
        {announcement}
      </p>
      {error && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
