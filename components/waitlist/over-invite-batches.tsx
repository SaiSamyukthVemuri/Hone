"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { RETRY_CLICK_MAX, ageLabel, type BatchProgress } from "@/lib/waitlist/over-invite-progress";
import type { OverInviteResult } from "@/lib/waitlist/over-invite-result";

// Confirmed batches and where each one is, read from the database on every load. Sending continues in the background with no page open and no
// click; this panel only REPORTS. The one control is a separate, explicitly confirmed retry of deliveries the provider refused. An outcome we do
// not know is never retried.

/** Disabled while its form is pending, so a double click or a second tap cannot submit twice. */
function SubmitOnce({ children }: { children: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="min-h-11 self-start rounded-md border px-3">
      {pending ? "Working…" : children}
    </button>
  );
}

export type BatchView = { id: string; confirmedAt: string; quantity: number; fitShown: number; liveShown: number; progress: BatchProgress };

export function OverInviteBatches({
  batches,
  retryAction,
  stopAction,
  unknownRetryAction,
  renderedAt,
}: {
  batches: readonly BatchView[];
  retryAction: (prev: OverInviteResult, formData: FormData) => Promise<OverInviteResult>;
  stopAction: (prev: OverInviteResult, formData: FormData) => Promise<OverInviteResult>;
  unknownRetryAction: (prev: OverInviteResult, formData: FormData) => Promise<OverInviteResult>;
  renderedAt: number;
}) {
  const [result, formAction] = useActionState(retryAction, { state: "idle" } as OverInviteResult);
  const [unknownResult, unknownFormAction] = useActionState(unknownRetryAction, { state: "idle" } as OverInviteResult);
  const [stopResult, stopFormAction] = useActionState(stopAction, { state: "idle" } as OverInviteResult);
  if (batches.length === 0) return null;
  const refused = batches.reduce((n, b) => n + b.progress.refused, 0);
  const thisClick = Math.min(refused, RETRY_CLICK_MAX);
  const unknownN = batches.reduce((n, b) => n + b.progress.unknownRetryable, 0);
  const unknownClick = Math.min(unknownN, RETRY_CLICK_MAX);
  const unknownNote = unknownResult.state === "notice" ? unknownResult.notice : unknownResult.state === "progress" ? `${unknownResult.sent} resent, ${unknownResult.failed} still not confirmed.` : null;
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
              {b.progress.sent} sent · {b.progress.waiting} waiting to send · {b.progress.sending} sending now · {b.progress.refused} refused by the email provider · {b.progress.unknown} outcome unknown ·{" "}
              {b.progress.skipped} not sent · {b.progress.stopped} stopped{b.progress.otherFailed > 0 ? ` · ${b.progress.otherFailed} failed (can't be retried here)` : ""}
            </span>
            {b.progress.waiting > 0 ? (
              <form action={stopFormAction as unknown as (formData: FormData) => void} className="mt-1">
                <input type="hidden" name="batchId" value={b.id} />
                <SubmitOnce>Stop sending the rest</SubmitOnce>
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
            <span>Retry {thisClick} of the {refused} refused deliveries now{refused > thisClick ? ` (each click retries up to ${RETRY_CLICK_MAX}; click again for the rest)` : ""}. Each gets a fresh invitation link and a new email.</span>
          </label>
          <SubmitOnce>Retry refused deliveries</SubmitOnce>
        </form>
      ) : null}
      {unknownN > 0 ? (
        <form action={unknownFormAction as unknown as (formData: FormData) => void} className="flex flex-col gap-2">
          <label className="flex min-h-11 items-start gap-2">
            <input type="checkbox" name="confirmRetryUnknown" className="mt-1" />
            <span>
              Retry {unknownClick} of the {unknownN} whose outcome is unknown{unknownN > unknownClick ? ` (each click retries up to ${RETRY_CLICK_MAX})` : ""}. We can&apos;t tell whether these emails
              arrived. Retrying may send a second email, and the first link will stop working.
            </span>
          </label>
          <SubmitOnce>Retry unknown-outcome deliveries</SubmitOnce>
        </form>
      ) : null}
      {batches.some((b) => b.progress.otherFailed > 0) ? (
        <p>
          Some invitations failed in a way that can&apos;t be retried from here, and we can&apos;t tell whether the person got the email. To invite them again,
          contact them directly, or remove and re-add them to the waitlist.
        </p>
      ) : null}
      {unknownNote ? <p role="status">{unknownNote}</p> : null}
      {stopNote ? <p role="status">{stopNote}</p> : null}
      {note ? <p role="status">{note}</p> : null}
    </section>
  );
}
