"use client";

import { useState, useTransition } from "react";
import { markIntakeReviewedAction, saveIntakeNotesAction } from "./actions";

type Props = {
  intakeId: string;
  clientId: string;
  initialNotes: string | null;
  alreadyReviewed: boolean;
};

// Notes + Mark reviewed only. The prior toast-only "Request update
// from client" button has been replaced by the dedicated
// IntakeReissueCard surface, which actually creates a new intake row
// and produces a fresh tokenized link.
export function IntakeReviewForm({
  intakeId,
  clientId,
  initialNotes,
  alreadyReviewed,
}: Props) {
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(action: "review" | "save") {
    const fd = new FormData();
    fd.set("intake_id", intakeId);
    fd.set("client_id", clientId);
    fd.set("practitioner_notes", notes);
    setError(null);
    setSavedHint(null);
    startTransition(async () => {
      const res =
        action === "review"
          ? await markIntakeReviewedAction(fd)
          : await saveIntakeNotesAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSavedHint(action === "review" ? "Marked reviewed." : "Notes saved.");
      setTimeout(() => setSavedHint(null), 2500);
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950">
      <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
        Practitioner notes
      </h2>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={4}
        placeholder="Notes for your own records (not visible to the client)."
        className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm leading-relaxed focus:border-neutral-900 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950"
      />
      {error && (
        <p className="text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
      {savedHint && <p className="text-xs text-neutral-500">{savedHint}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => submit("save")}
          disabled={isPending}
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950"
        >
          Save notes
        </button>
        {!alreadyReviewed && (
          <button
            type="button"
            onClick={() => submit("review")}
            disabled={isPending}
            className="rounded-md bg-neutral-900 px-3 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            {isPending ? "Saving..." : "Mark reviewed"}
          </button>
        )}
      </div>
    </div>
  );
}
