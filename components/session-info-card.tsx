"use client";

import { useState, useTransition } from "react";
import type { Practitioner } from "@/lib/types/database";

type Props = {
  sessionId: string;
  clientId: string;
  practitioners: Practitioner[];
  initialPerformerId: string | null;
  initialPriceCents: number | null;
  updatePriceAction: (formData: FormData) => Promise<void>;
  updatePerformerAction: (formData: FormData) => Promise<void>;
};


export function SessionInfoCard({
  sessionId,
  clientId,
  practitioners,
  initialPerformerId,
  updatePerformerAction,
}: Props) {
  const [performerId, setPerformerId] = useState(initialPerformerId ?? "");
  const [performerState, setPerformerState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [performerError, setPerformerError] = useState<string | null>(null);
  const [, startPerformerTransition] = useTransition();

  function handlePerformerChange(next: string) {
    setPerformerId(next);
    setPerformerState("saving");
    setPerformerError(null);

    const fd = new FormData();
    fd.set("session_id", sessionId);
    fd.set("client_id", clientId);
    fd.set("performer_id", next);

    startPerformerTransition(async () => {
      try {
        await updatePerformerAction(fd);
        setPerformerState("saved");
        setTimeout(() => setPerformerState("idle"), 1500);
      } catch (err) {
        setPerformerState("error");
        setPerformerError(err instanceof Error ? err.message : "Failed to save.");
      }
    });
  }

  return (
    <div className="grid gap-5 rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950 md:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="performer"
          className="text-sm font-medium text-neutral-700 dark:text-neutral-300"
        >
          Performed by
        </label>
        <select
          id="performer"
          value={performerId}
          onChange={(e) => handlePerformerChange(e.target.value)}
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        >
          <option value="">Select practitioner</option>
          {practitioners.map((p) => (
            <option key={p.id} value={p.id}>
              {p.display_name?.trim() ? p.display_name : p.email}
            </option>
          ))}
        </select>
        <SaveHint state={performerState} error={performerError} />
      </div>

      {/* PR #198 (Chloe iPad retest): the session price block is gone
          from charting entirely. Custom pricing lives on the client
          profile; billing reminders belong near payment, not beside
          the performer. updateSessionPriceAction remains for future
          billing surfaces. */}
    </div>
  );
}

function SaveHint({
  state,
  error,
}: {
  state: "idle" | "saving" | "saved" | "error";
  error: string | null;
}) {
  if (state === "saving") {
    return <span className="text-xs text-neutral-500">Saving…</span>;
  }
  if (state === "saved") {
    return <span className="text-xs text-green-600 dark:text-green-400">Saved</span>;
  }
  if (state === "error" && error) {
    return <span className="text-xs text-red-600 dark:text-red-400">{error}</span>;
  }
  return <span className="text-xs text-neutral-400">&nbsp;</span>;
}
