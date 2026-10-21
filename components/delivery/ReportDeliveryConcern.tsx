"use client";

import { useActionState } from "react";
import { CONCERN_TARGETS, concernTargetValue, ledgerStatusWords } from "@/lib/delivery/concerns";
import { reportDeliveryConcernAction, type ReportConcernState } from "./report-concern-actions";

// DELIVERY-VISIBILITY-04 — "Client says they didn't receive it", on the
// appointment page, for the studio owner. One choice (which message), one
// button. It records a concern for Hone support; it does not resend anything
// and does not change what the delivery record says.

const INITIAL: ReportConcernState = { status: "idle" };

export function ReportDeliveryConcern({ studioId, appointmentId }: { studioId: string; appointmentId: string }) {
  const [state, action, pending] = useActionState(reportDeliveryConcernAction, INITIAL);

  return (
    <details className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
      <summary className="cursor-pointer font-medium text-neutral-900 dark:text-neutral-100">
        Client says they didn&apos;t receive a message
      </summary>
      <form action={action} className="mt-3 flex flex-col gap-3">
        <input type="hidden" name="studio_id" value={studioId} />
        <input type="hidden" name="appointment_id" value={appointmentId} />
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-600 dark:text-neutral-400">Which message?</span>
          <select name="message" required defaultValue="" className="rounded border px-2 py-1">
            <option value="" disabled>
              Choose a message
            </option>
            {CONCERN_TARGETS.map((t) => (
              <option key={concernTargetValue(t)} value={concernTargetValue(t)}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          This tells Hone support to look into it. Nothing is resent, and nothing about the client is shared.
        </p>
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md border border-neutral-900 px-3 py-1.5 text-xs font-medium disabled:opacity-60 dark:border-white"
        >
          {pending ? "Reporting…" : "Report to Hone support"}
        </button>
        <p role="status" aria-live="polite" className="text-xs">
          {state.status === "reported" && `Reported. When you reported it, ${ledgerStatusWords(state.ledgerStatus)}.`}
          {state.status === "already_open" &&
            `Already reported and still open. At that time, ${ledgerStatusWords(state.ledgerStatus)}.`}
          {state.status === "error" && state.message}
        </p>
      </form>
    </details>
  );
}
