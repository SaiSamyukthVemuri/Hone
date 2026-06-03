"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { archiveClientAction } from "../actions";

// Two-step archive control. The first click reveals the confirmation
// copy and a primary "Archive" submit; the second click actually
// archives. The Cancel button disarms. This is the safest small-PR
// equivalent of a "type the client's name to confirm" modal -- it
// stops a single misclick from hiding a real client, without adding
// a new modal component.
//
// The action redirects to /clients on success so the practitioner
// lands on the active list and immediately sees the archived row is
// gone. The "Historical records may remain" copy makes the
// non-destructive nature of archive explicit.
export function ArchiveClientControl({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const [arming, setArming] = useState(false);

  if (!arming) {
    return (
      <button
        type="button"
        onClick={() => setArming(true)}
        className="rounded-md border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-700/60 dark:text-red-300 dark:hover:bg-red-950/30"
      >
        Archive client
      </button>
    );
  }

  return (
    <form
      action={archiveClientAction}
      className="flex flex-col gap-3 rounded-md border border-red-300 bg-red-50 p-4 dark:border-red-700/60 dark:bg-red-950/20"
    >
      <input type="hidden" name="client_id" value={clientId} />
      <p className="text-sm font-medium text-red-900 dark:text-red-100">
        Archive {clientName}?
      </p>
      <p className="text-xs text-red-900/80 dark:text-red-100/80">
        This hides the client from active lists. Historical records
        may remain (past appointments, sessions, intake, audit). You
        can unarchive later from this page.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <ArchiveSubmit />
        <button
          type="button"
          onClick={() => setArming(false)}
          className="rounded-md border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-700/60 dark:bg-neutral-950 dark:text-red-300 dark:hover:bg-red-950/30"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ArchiveSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-red-700 px-3 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-60"
    >
      {pending ? "Archiving..." : "Archive client"}
    </button>
  );
}
