"use client";

import { useState, useTransition } from "react";
import type { Practitioner } from "@/lib/types/database";

type Props = {
  sessionId: string;
  clientId: string;
  practitioners: Practitioner[];
  initialPerformerId: string | null;
  updatePerformerAction: (formData: FormData) => Promise<void>;
};

// PR #199 (Chloe iPad retest): the session page showed the performer
// twice; a static "Performed by X" line under the title AND a separate
// "Performed by" card with a dropdown. This inline line is now the
// single performer surface. It reads as plain text with a small Edit
// affordance; Edit swaps in the same practitioner select, saving
// through the unchanged updateSessionPerformerAction.
export function SessionPerformerLine({
  sessionId,
  clientId,
  practitioners,
  initialPerformerId,
  updatePerformerAction,
}: Props) {
  const [performerId, setPerformerId] = useState(initialPerformerId ?? "");
  const [editing, setEditing] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const current = practitioners.find((p) => p.id === performerId);
  const performerName = current
    ? current.display_name?.trim() || current.email
    : null;

  function handlePerformerChange(next: string) {
    setPerformerId(next);
    setState("saving");
    setError(null);

    const fd = new FormData();
    fd.set("session_id", sessionId);
    fd.set("client_id", clientId);
    fd.set("performer_id", next);

    startTransition(async () => {
      try {
        await updatePerformerAction(fd);
        setState("saved");
        setEditing(false);
        setTimeout(() => setState("idle"), 1500);
      } catch (err) {
        setState("error");
        setError(err instanceof Error ? err.message : "Failed to save.");
      }
    });
  }

  if (!editing) {
    return (
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-neutral-500">
        <span>
          Performed by{" "}
          <span className="text-neutral-700 dark:text-neutral-300">
            {performerName ?? "not set"}
          </span>
        </span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          Edit
        </button>
        {state === "saved" && (
          <span className="text-xs text-green-600 dark:text-green-400">
            Saved
          </span>
        )}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor="performer" className="text-neutral-500">
        Performed by
      </label>
      <select
        id="performer"
        value={performerId}
        onChange={(e) => handlePerformerChange(e.target.value)}
        disabled={state === "saving"}
        className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
      >
        <option value="">Select practitioner</option>
        {practitioners.map((p) => (
          <option key={p.id} value={p.id}>
            {p.display_name?.trim() ? p.display_name : p.email}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => setEditing(false)}
        disabled={state === "saving"}
        className="text-xs text-neutral-500 underline hover:text-neutral-900 disabled:opacity-50 dark:hover:text-neutral-100"
      >
        Cancel
      </button>
      {state === "saving" && (
        <span className="text-xs text-neutral-500">Saving…</span>
      )}
      {state === "error" && error && (
        <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
      )}
    </div>
  );
}
