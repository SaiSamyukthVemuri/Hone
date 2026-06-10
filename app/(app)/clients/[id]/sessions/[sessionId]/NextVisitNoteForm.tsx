"use client";

import { useState, useTransition } from "react";
import type { NextSessionNoteResult } from "./actions";

// PR #191 (Chloe smoke feedback). The "Plan for next visit" form
// previously gave no feedback on save; Chloe could not tell whether
// her note was saved. This client wrapper shows explicit
// saving / saved / cleared / error states. Autosave was considered
// and deferred (documented follow-up); explicit state was the
// smallest safe fix.

type Status =
  | { kind: "idle" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved"; cleared: boolean }
  | { kind: "error"; message: string };

export function NextVisitNoteForm({
  sessionId,
  clientId,
  initialNote,
  action,
}: {
  sessionId: string;
  clientId: string;
  initialNote: string;
  action: (formData: FormData) => Promise<NextSessionNoteResult>;
}) {
  const [note, setNote] = useState(initialNote);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  function save() {
    setStatus({ kind: "saving" });
    startTransition(async () => {
      const formData = new FormData();
      formData.set("session_id", sessionId);
      formData.set("client_id", clientId);
      formData.set("next_session_note", note);
      const result = await action(formData);
      if (result.ok) {
        setStatus({ kind: "saved", cleared: result.cleared });
      } else {
        setStatus({ kind: "error", message: result.error });
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <textarea
        rows={2}
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          if (status.kind !== "dirty") setStatus({ kind: "dirty" });
        }}
        placeholder="e.g. Start lower on the upper lip and check sensitivity before continuing"
        className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          {pending ? "Saving…" : "Save note"}
        </button>
        {status.kind === "saved" && (
          <span
            className="text-sm text-green-700 dark:text-green-400"
            role="status"
          >
            {status.cleared ? "Note cleared." : "Saved just now."}
          </span>
        )}
        {status.kind === "dirty" && (
          <span className="text-sm text-neutral-500" role="status">
            Unsaved changes
          </span>
        )}
        {status.kind === "error" && (
          <span className="text-sm text-red-600 dark:text-red-400" role="alert">
            {status.message}
          </span>
        )}
      </div>
    </div>
  );
}
