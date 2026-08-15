"use client";

// Client wrapper around the practitioner cancellation server action.
// Replaces the previous inline `<form action={server-fn}>` pattern,
// which silently swallowed any error returned by the server action.
// This component surfaces a safe user-facing message on failure and
// refreshes the detail page on success.

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { cancelAppointmentAction } from "./actions";

export type PractitionerCancelFormProps = {
  appointmentId: string;
  // Optional: notified after a successful cancellation so an enclosing surface
  // can dismiss itself. The calendar preview drawer uses it — once the row is
  // cancelled the drawer's own summary is stale, and leaving it open would keep
  // offering actions the command now refuses. router.refresh() always runs.
  onCancelled?: () => void;
};

export function PractitionerCancelForm({
  appointmentId,
  onCancelled,
}: PractitionerCancelFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const fd = new FormData();
    fd.set("appointment_id", appointmentId);
    fd.set("reason", reason);
    startTransition(async () => {
      const res = await cancelAppointmentAction(fd);
      if (!res.ok) {
        // Surface the action's user-facing message. The server
        // action itself returns sanitized messages (it does NOT
        // leak raw DB error text).
        setError(res.error);
        return;
      }
      router.refresh();
      onCancelled?.();
    });
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
    >
      <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        Cancel
      </h2>
      <textarea
        name="reason"
        rows={2}
        placeholder="Reason (optional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
      />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-red-500 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-400 dark:text-red-400 dark:hover:bg-red-950/40"
        >
          {pending ? "Cancelling…" : "Cancel appointment"}
        </button>
        {error && (
          <span className="text-xs text-red-700 dark:text-red-300">{error}</span>
        )}
      </div>
    </form>
  );
}
