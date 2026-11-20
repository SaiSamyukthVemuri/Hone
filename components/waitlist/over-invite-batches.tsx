"use client";

import { useActionState } from "react";
import { ageLabel, type BatchProgress } from "@/lib/waitlist/over-invite-progress";
import type { OverInviteResult } from "@/lib/waitlist/over-invite-result";

// Confirmed batches and where each one is, read from the database on every load. Sending continues in the background with no page open and no
// click; this panel only REPORTS. The one control is a separate, explicitly confirmed retry of deliveries the provider refused. An outcome we do
// not know is never retried.

export type BatchView = { id: string; confirmedAt: string; quantity: number; fitShown: number; liveShown: number; progress: BatchProgress };

export function OverInviteBatches({
  batches,
  retryAction,
  stopAction,
  renderedAt,
}: {
  batches: readonly BatchView[];
  retryAction: (prev: OverInviteResult, formData: FormData) => Promise<OverInviteResult>;
  stopAction: (prev: OverInviteResult, formData: FormData) => Promise<OverInviteResult>;
  renderedAt: number;
}) {
  const [result, formAction] = useActionState(retryAction, { state: "idle" } as OverInviteResult);
  const [stopResult, stopFormAction] = useActionState(stopAction, { state: "idle" } as OverInviteResult);
  if (batches.length === 0) return null;
  const refused = batches.reduce((n, b) => n + b.progress.refused, 0);
  const stopNote = stopResult.state === "notice" ? stopResult.notice : null;
  const note = result.state === "notice" ? result.notice : result.state === "progress" ? `${result.sent} resent, ${result.failed} still not delivered.` : null;
  return (
    <section data-testid="over-invite-progress" className="flex flex-col gap-2 text-sm" aria-label="Invitation batches">
      <h2 className="font-medium">Your confirmed batches</h2>
      <ul className="flex flex-col gap-2">
        {batches.map((b) => (
          <li key={b.id} data-testid="batch-progress">
            <span>
              Confirmed {ageLabel(b.confirmedAt, renderedAt)} · {b.quantity} chosen · estimate then: {b.fitShown} available, {b.liveShown} active
            </span>
            <br />
            <span>
              {b.progress.sent} sent · {b.progress.waiting} waiting to send · {b.progress.refused} refused by the email provider · {b.progress.unknown} outcome unknown ·{" "}
              {b.progress.skipped} not sent · {b.progress.stopped} stopped{b.progress.otherFailed > 0 ? ` · ${b.progress.otherFailed} failed` : ""}
            </span>
            {b.progress.waiting > 0 ? (
              <form action={stopFormAction as unknown as (formData: FormData) => void} className="mt-1">
                <input type="hidden" name="batchId" value={b.id} />
                <button type="submit" className="min-h-11 rounded-md border px-3">
                  Stop sending the rest
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      <p>Waiting invitations are sent in the background; you do not need to keep this page open. An outcome we do not know is never resent automatically.</p>
      {refused > 0 ? (
        <form action={formAction as unknown as (formData: FormData) => void} className="flex flex-col gap-2">
          <label className="flex min-h-11 items-start gap-2">
            <input type="checkbox" name="confirmRetry" className="mt-1" />
            <span>Retry the {refused} refused deliveries now. Each gets a fresh invitation link and a new email. If an email was in fact delivered without being confirmed, the person receives a second email and the first link stops working.</span>
          </label>
          <button type="submit" className="min-h-11 self-start rounded-md border px-3">
            Retry refused deliveries
          </button>
        </form>
      ) : null}
      {stopNote ? <p role="status">{stopNote}</p> : null}
      {note ? <p role="status">{note}</p> : null}
    </section>
  );
}
