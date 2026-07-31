"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

// Non-blocking aftercare prompt at the "Done charting" boundary (Charting
// Validation PR 1). If the session has no aftercare_and_risks_explained_at stamp,
// clicking "Done charting" opens a warning with two choices — mark it, or
// continue anyway. It NEVER blocks (emergency-safe): "Continue without marking"
// always proceeds, and marking is only ever done by an explicit click (never
// auto). If the stamp is already present, this behaves exactly like the old
// plain link. It only navigates + calls the existing aftercare toggle action;
// it changes no scheduling, completion, or send behaviour, and adds no schema.

type MarkResult = { ok: boolean; error?: string };

type Props = {
  sessionId: string;
  doneHref: string;
  aftercareExplained: boolean;
  markAction: (formData: FormData) => Promise<MarkResult>;
  // The exit now sits at the foot of the Finish appointment workflow, so it
  // reads "Done — back to client" there. The safe-exit semantics are unchanged:
  // an unmarked aftercare stamp still raises the explicit warning, and
  // "Continue without marking" still proceeds without writing anything.
  label?: string;
};

const DONE_CLASS =
  "inline-flex min-h-[44px] items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200";

export function DoneChartingButton({
  sessionId,
  doneHref,
  aftercareExplained,
  markAction,
  label = "Done charting",
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function proceed() {
    router.push(doneHref);
  }

  function onDoneClick() {
    // Already stamped → behave like the old plain link.
    if (aftercareExplained) {
      proceed();
      return;
    }
    setError(null);
    setOpen(true);
  }

  function markThenProceed() {
    setError(null);
    const fd = new FormData();
    fd.set("session_id", sessionId);
    fd.set("explained", "true"); // explicit intent; never auto/ambiguous
    startTransition(async () => {
      const res = await markAction(fd);
      if (res.ok) {
        proceed();
      } else {
        setError(res.error ?? "Could not save. You can continue without marking.");
      }
    });
  }

  return (
    <>
      <button type="button" onClick={onDoneClick} className={DONE_CLASS}>
        {label}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Aftercare not marked"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/30 backdrop-blur-[1px]"
          />
          <div
            className="relative z-10 flex w-full max-w-sm flex-col gap-4 rounded-lg bg-white p-6 shadow-xl dark:bg-neutral-950"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold">Aftercare not marked</h2>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                You can continue, but this session does not show that aftercare
                and risks were explained.
              </p>
            </div>

            {error && (
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            )}

            <div className="flex flex-col gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={markThenProceed}
                className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
              >
                Mark aftercare explained
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={proceed}
                className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
              >
                Continue without marking
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
