"use client";

import { useState } from "react";
import { softDeleteSessionAction } from "./actions";

type Props = {
  sessionId: string;
  clientId: string;
};

const MIN_REASON_LENGTH = 10;

export function DeleteSessionForm({ sessionId, clientId }: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-neutral-400 underline hover:text-red-600"
      >
        Delete session
      </button>
    );
  }

  const trimmed = reason.trim();
  const canSubmit = trimmed.length >= MIN_REASON_LENGTH && !submitting;

  async function handleSubmit(formData: FormData) {
    setError(null);
    setSubmitting(true);
    try {
      await softDeleteSessionAction(formData);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to delete session.";
      if (message.includes("NEXT_REDIRECT")) {
        return;
      }
      setError(message);
      setSubmitting(false);
    }
  }

  return (
    <form
      action={handleSubmit}
      className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm"
    >
      <input type="hidden" name="session_id" value={sessionId} />
      <input type="hidden" name="client_id" value={clientId} />
      <p className="text-red-700">
        Deleting this session hides it from charts and exports. The record is
        kept on file for audit. Tell us why you are deleting it.
      </p>
      <textarea
        name="delete_reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        required
        minLength={MIN_REASON_LENGTH}
        placeholder="Reason (at least 10 characters)"
        className="w-full rounded-md border border-red-300 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
      />
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          {submitting ? "Deleting..." : "Delete session"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setReason("");
            setError(null);
          }}
          className="rounded-md border border-neutral-300 bg-white px-3 py-1 text-xs text-neutral-700"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
