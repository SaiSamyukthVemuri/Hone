"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { IntakeStatus } from "@/lib/types/database";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { markIntakeReviewedAction, saveIntakeNotesAction } from "./actions";

type Props = {
  intakeId: string;
  clientId: string;
  initialNotes: string | null;
  // F-CLIN-004: the component now receives the ACTUAL server status rather
  // than an `alreadyReviewed` boolean. The boolean collapsed in_progress and
  // submitted into one "not yet reviewed" state, which is exactly why the
  // review CTA was rendered for an intake the client had never submitted.
  status: IntakeStatus;
  // Server-rendered reviewed attribution, shown as the durable Reviewed
  // state. Never inferred from a transient toast.
  reviewedAtIso?: string | null;
  reviewedByName?: string | null;
};

// Notes + Mark reviewed. The prior toast-only "Request update from client"
// button has been replaced by the dedicated IntakeReissueCard surface, which
// actually creates a new intake row and produces a fresh tokenized link.
export function IntakeReviewForm({
  intakeId,
  clientId,
  initialNotes,
  status,
  reviewedAtIso = null,
  reviewedByName = null,
}: Props) {
  const router = useRouter();
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [error, setError] = useState<string | null>(null);
  // Which action produced `error`. A review refusal has to be re-worded once
  // the page settles onto a different server status (see displayedError).
  const [errorSource, setErrorSource] = useState<"review" | "notes" | null>(
    null,
  );
  const [savedHint, setSavedHint] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  // Single-flight latch. useTransition's isPending already disables the
  // buttons, but a double-activation (double tap / Enter+click) can queue two
  // calls before React re-renders. The ref is checked and set synchronously,
  // so the second activation returns before ever reaching the server action.
  const inFlight = useRef(false);

  function buildFormData(): FormData {
    const fd = new FormData();
    fd.set("intake_id", intakeId);
    fd.set("client_id", clientId);
    fd.set("practitioner_notes", notes);
    return fd;
  }

  // Editing the textarea invalidates any "Notes saved." confirmation: the text
  // on screen no longer matches what was persisted. Without this the hint sits
  // under the field asserting a saved state while the practitioner types
  // unsaved clinical notes.
  function onNotesChange(value: string) {
    setNotes(value);
    if (savedHint) setSavedHint(null);
  }

  function saveNotes() {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setErrorSource(null);
    setSavedHint(null);
    startTransition(async () => {
      try {
        const res = await saveIntakeNotesAction(buildFormData());
        if (!res.ok) {
          setError(res.error);
          setErrorSource("notes");
          return;
        }
        setSavedHint("Notes saved.");
      } finally {
        inFlight.current = false;
      }
    });
  }

  function confirmReview() {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setErrorSource(null);
    setSavedHint(null);
    startTransition(async () => {
      try {
        const res = await markIntakeReviewedAction(buildFormData());
        if (!res.ok) {
          setError(res.error);
          setErrorSource("review");
          // Close the dialog and re-read the server. A stale "submitted" page
          // whose row has since been reviewed (or was never reviewable)
          // settles onto its real current state instead of sitting on a
          // contradiction. The durable state always comes from the server.
          setConfirmOpen(false);
          router.refresh();
          return;
        }
        // No optimistic reviewed state: close, then let the refreshed server
        // render supply the Reviewed state and drop the CTA.
        setConfirmOpen(false);
        router.refresh();
      } finally {
        inFlight.current = false;
      }
    });
  }

  // A review refusal is captured while the page still believes the intake is
  // submitted. router.refresh() then settles the page onto the real server
  // status, and once that status is `reviewed` the generic refusal copy
  // ("...can only be reviewed after this client submits it") sits directly
  // above a Reviewed banner and flatly contradicts it. Re-word it to match what
  // the practitioner is now looking at. This discloses nothing new: the
  // Reviewed state is already on screen, rendered from the server row.
  const displayedError =
    error && errorSource === "review" && status === "reviewed"
      ? "This intake was already reviewed. The current record is shown below."
      : error;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950">
      <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
        Practitioner notes
      </h2>

      {/* Notes stay editable in every status: in_progress, submitted and
          reviewed. Only the review CTA is status-gated. */}
      <textarea
        value={notes}
        onChange={(e) => onNotesChange(e.target.value)}
        rows={4}
        aria-label="Practitioner notes"
        placeholder="Notes for your own records (not visible to the client)."
        className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm leading-relaxed focus:border-neutral-900 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950"
      />

      {displayedError && (
        <p className="text-xs text-red-700" role="alert" data-testid="intake-review-error">
          {displayedError}
        </p>
      )}
      {savedHint && (
        <p className="text-xs text-neutral-500" data-testid="intake-review-hint">
          {savedHint}
        </p>
      )}

      {/* IN PROGRESS: durable explanation, no review CTA. This text is
          rendered from the server status, so it survives a reload; it is not
          a toast. */}
      {status === "in_progress" && (
        <p
          className="rounded-md border border-neutral-300 bg-neutral-50 p-3 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
          data-testid="intake-review-blocked-notice"
        >
          The client must submit this intake before it can be marked reviewed.
        </p>
      )}

      {/* REVIEWED: durable server-derived state, no review CTA. */}
      {status === "reviewed" && (
        <p
          className="rounded-md border border-neutral-300 bg-neutral-50 p-3 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
          data-testid="intake-reviewed-state"
        >
          {/* Timestamps go through the house FormattedDateTime: the server
              cannot know the viewer's timezone, so it renders empty on SSR and
              fills in on mount (with suppressHydrationWarning). Formatting this
              inline with toLocaleString() would both hydrate-mismatch and
              disagree with the page header, which renders this same value. */}
          Reviewed
          {reviewedAtIso ? (
            <>
              {" on "}
              <FormattedDateTime iso={reviewedAtIso} />
            </>
          ) : null}
          {reviewedByName ? ` by ${reviewedByName}` : ""}.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={saveNotes}
          disabled={isPending}
          data-testid="intake-save-notes"
          className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950"
        >
          Save notes
        </button>

        {/* SUBMITTED is the ONLY status that exposes Mark reviewed. */}
        {status === "submitted" && (
          <button
            type="button"
            // Opening the confirmation performs zero server action calls.
            onClick={() => {
              setError(null);
              setErrorSource(null);
              setSavedHint(null);
              setConfirmOpen(true);
            }}
            disabled={isPending}
            data-testid="intake-mark-reviewed"
            className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-neutral-900 px-3 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Mark reviewed
          </button>
        )}
      </div>

      {/* House accessible in-DOM confirmation (role="alertdialog", focus trap,
          idle-gated Escape, >=44px targets). It is presentational only and
          never calls a server action itself: Cancel simply closes, issuing
          zero requests. */}
      <ConfirmDialog
        open={confirmOpen}
        title="Mark this intake reviewed?"
        description="Hone will record you as the reviewer and stamp the current time. This is kept as part of the client's clinical record."
        confirmLabel="Mark reviewed"
        busyLabel="Marking reviewed…"
        pending={isPending}
        onConfirm={confirmReview}
        onCancel={() => {
          if (isPending) return;
          setConfirmOpen(false);
        }}
      />
    </div>
  );
}
