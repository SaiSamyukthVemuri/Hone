"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DRAFT_COPY, draftRestoredLabel, draftSavedLabel } from "@/lib/note-drafts/types";
import type { DraftState } from "@/lib/note-drafts/draft-saver";

function hhmm(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// The honest draft states. "Draft saved" appears only after the server acknowledged that text; a failed save keeps the text and
// says so in fixed wording (no draft text in any message). "Saved" is never used here: the clinical record is the Save button's job.
export function NoteDraftStatus({
  state,
  restoredAt,
  onRetry,
  onKeepMine,
  onUseTheirs,
  onDiscard,
  onKeepAsNew,
}: {
  onKeepAsNew?: () => void;
  state: DraftState;
  restoredAt: string | null;
  onRetry: () => void;
  onKeepMine: () => void;
  onUseTheirs: () => void;
  onDiscard: () => void;
}) {
  const [confirmTheirs, setConfirmTheirs] = useState(false);
  let line: string | null = null;
  let tone = "text-neutral-500";
  if (state.phase === "saving") line = DRAFT_COPY.saving;
  else if (state.phase === "unsaved") line = DRAFT_COPY.unsaved;
  else if (state.phase === "saved") line = draftSavedLabel(hhmm(state.savedAt));
  else if (state.phase === "error") {
    line = DRAFT_COPY.failure;
    tone = "text-red-700";
  } else if (state.phase === "cleared") {
    line = DRAFT_COPY.cleared;
    tone = "text-red-700";
  } else if (state.phase === "conflict") {
    line = DRAFT_COPY.conflict;
    tone = "text-red-700";
  } else if (restoredAt) line = draftRestoredLabel(hhmm(restoredAt));

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="note-draft-status">
      {line && (
        <span role="status" aria-live="polite" className={tone}>
          {line}
        </span>
      )}
      {state.phase === "error" && (
        <button type="button" onClick={onRetry} className="min-h-[44px] px-2 font-medium underline">
          Retry
        </button>
      )}
      {state.phase === "cleared" && (
        <>
          <button type="button" onClick={onKeepAsNew} className="min-h-[44px] px-2 font-medium underline">
            Keep as new draft
          </button>
          <button type="button" onClick={onDiscard} className="min-h-[44px] px-2 font-medium underline">
            {DRAFT_COPY.discard}
          </button>
        </>
      )}
      {state.phase === "conflict" && (
        <>
          <button type="button" onClick={onKeepMine} className="min-h-[44px] px-2 font-medium underline">
            Keep mine
          </button>
          <button type="button" onClick={() => setConfirmTheirs(true)} className="min-h-[44px] px-2 font-medium underline">
            Use theirs
          </button>
          <ConfirmDialog
            open={confirmTheirs}
            title="Use the other window's draft?"
            description="Your version stays on screen until you dismiss it."
            confirmLabel="Use theirs"
            onConfirm={() => {
              setConfirmTheirs(false);
              onUseTheirs();
            }}
            onCancel={() => setConfirmTheirs(false)}
          />
        </>
      )}
      {(restoredAt || state.phase === "saved") && (
        <button type="button" onClick={onDiscard} className="min-h-[44px] px-2 font-medium underline">
          {DRAFT_COPY.discard}
        </button>
      )}
    </div>
  );
}
