"use client";

import { useState } from "react";

// Migration 0114: "Remove pass" replaces the old bare ✕ hard-delete on a
// treatment pass (electrolysis / laser entry). It asks for confirmation, lets
// the practitioner record an optional reason, and posts to the server action,
// which performs an AUDITED SOFT-DELETE (deleted_at/deleted_by/delete_reason).
// Only the selected pass is voided; other passes, the area, the session, the
// appointment, the client, and photos are untouched. The record is preserved.
export function RemovePassButton({
  action,
  entryId,
  sessionId,
  clientId,
  ariaLabel = "Remove pass",
}: {
  action: (formData: FormData) => Promise<void>;
  entryId: string;
  sessionId: string;
  clientId: string;
  ariaLabel?: string;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={() => setConfirming(true)}
        className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
      >
        Remove pass
      </button>
    );
  }

  return (
    <form
      action={action}
      className="flex flex-col gap-2 rounded-md border border-neutral-300 bg-neutral-50 p-3 text-xs dark:border-neutral-700 dark:bg-neutral-900"
    >
      <input type="hidden" name="id" value={entryId} />
      <input type="hidden" name="session_id" value={sessionId} />
      <input type="hidden" name="client_id" value={clientId} />
      <p className="text-neutral-700 dark:text-neutral-300">
        Remove this pass from the active treatment record? Other passes for this
        area will stay.
      </p>
      <input
        type="text"
        name="reason"
        placeholder="Reason (optional)"
        maxLength={200}
        className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
      />
      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1 font-medium text-rose-800 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          Remove pass
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded-md border border-neutral-300 px-2.5 py-1 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
