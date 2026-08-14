"use client";

import { useState, useTransition } from "react";
import type { RemoveSessionAreaResult } from "@/app/(app)/clients/[id]/sessions/[sessionId]/block-actions";

// Willow P1-B: remove a whole incorrectly-recorded treatment AREA from a DRAFT
// chart. Before removal it summarizes what is attached (recorded passes; any
// attached photos are voided with the area too), requires a reason (>=10 chars,
// enforced by the RPC), and calls the atomic aggregate soft-delete action: the
// area + its passes + its images are voided in one trusted transaction. Only
// rendered inside the draft (non-finalized) charting view; the record is
// preserved (soft-delete), never hard-deleted.
export function RemoveAreaButton({
  action,
  blockId,
  sessionId,
  clientId,
  areaLabel,
  passCount,
}: {
  action: (input: {
    clientId: string;
    sessionId: string;
    blockId: string;
    reason: string;
  }) => Promise<RemoveSessionAreaResult>;
  blockId: string;
  sessionId: string;
  clientId: string;
  areaLabel: string;
  passCount: number;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const r = await action({ clientId, sessionId, blockId, reason });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Success: the action revalidates the page; the area disappears on refresh.
      setConfirming(false);
      setReason("");
    });
  }

  if (!confirming) {
    return (
      <button
        type="button"
        aria-label={`Remove treatment area ${areaLabel}`}
        onClick={() => setConfirming(true)}
        className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
      >
        Remove area
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-rose-300 bg-rose-50 p-3 text-xs dark:border-rose-800 dark:bg-rose-950/30">
      <p className="font-medium text-rose-900 dark:text-rose-200">
        Remove the whole “{areaLabel}” area from this chart?
      </p>
      <p className="text-rose-800 dark:text-rose-300">
        {passCount > 0 ? (
          <>
            This area has <strong>{passCount}</strong> recorded pass
            {passCount === 1 ? "" : "es"}. Removing the area also removes{" "}
            {passCount === 1 ? "it" : "them"} and any photos attached to this area.
          </>
        ) : (
          <>This area has no recorded passes.</>
        )}{" "}
        The record is preserved (soft-deleted) for audit: it just leaves the
        active chart.
      </p>
      <label className="flex flex-col gap-1">
        <span className="text-rose-800 dark:text-rose-300">
          Reason (required, at least 10 characters)
        </span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          maxLength={300}
          className="rounded border border-rose-300 bg-white px-2 py-1 text-neutral-900 dark:border-rose-800 dark:bg-neutral-950 dark:text-neutral-100"
        />
      </label>
      {error && (
        <p role="alert" className="font-medium text-rose-800 dark:text-rose-300">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending || reason.trim().length < 10}
          className="rounded-md border border-rose-400 bg-rose-100 px-2.5 py-1 font-medium text-rose-900 disabled:opacity-50 dark:border-rose-700 dark:bg-rose-900/40 dark:text-rose-100"
        >
          {pending ? "Removing…" : "Remove area"}
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
          className="rounded-md border border-neutral-300 px-2.5 py-1 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
