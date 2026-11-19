"use client";

import { useActionState, useCallback, useState, useTransition } from "react";
import { OverInviteConfirm } from "@/components/waitlist/over-invite-confirm";
import { RecipientChooser } from "@/components/waitlist/recipient-chooser";
import { buildOverInvitePreview } from "@/lib/waitlist/over-invite-preview";
import type { Candidate } from "@/lib/waitlist/recipient-chooser";
import type { OverInviteResult } from "@/lib/waitlist/over-invite-result";

// The owner's over-invite form: chooser + confirmation, wired to the server actions. The chooser receives NAMES ONLY (no email reaches the browser).
// The "Send N more" line follows the chooser's selection count, so it never claims a number the owner has not chosen. The hidden shown numbers
// and the batch key are only for the re-ask and idempotency; the server recomputes everything and reads none of them as authority.

export function OverInviteForm({
  action,
  retryAction,
  continueAction,
  candidates,
  fit,
  active,
  expiringSoon,
  batchKey,
  scope,
}: {
  action: (prev: OverInviteResult, formData: FormData) => Promise<OverInviteResult>;
  retryAction: (prev: OverInviteResult, formData: FormData) => Promise<OverInviteResult>;
  continueAction: (prev: OverInviteResult) => Promise<OverInviteResult>;
  candidates: readonly Candidate[];
  fit: number;
  active: number;
  expiringSoon: number;
  batchKey: string;
  scope: { serviceId: string; windowDays: number; allowedWeekdays: readonly number[] | null };
}) {
  const [result, formAction] = useActionState(action, { state: "idle" } as OverInviteResult);
  const [retryResult, retryFormAction] = useActionState(retryAction, { state: "idle" } as OverInviteResult);
  const [continuedProgress, setContinuedProgress] = useState<{ from: OverInviteResult; value: OverInviteResult } | null>(null);
  const [pendingContinue, startContinue] = useTransition();
  const [chosen, setChosen] = useState(0);
  const onSelectionChange = useCallback((n: number) => setChosen(n), []);
  // After a re-ask the server's fresh numbers replace the ones the owner saw.
  const shown = result.state === "reconfirm" ? { fit: result.fit, active: result.active, expiringSoon: result.expiringSoon } : { fit, active, expiringSoon };
  const preview = buildOverInvitePreview({ ...shown, extra: chosen });
  const notice = result.state === "notice" || result.state === "reconfirm" ? result.notice : null;
  const base = result.state === "progress" ? result : retryResult.state === "progress" ? retryResult : null;
  // A continuation carries the earlier totals forward (the action adds to them), and is dropped when a new send replaces the result.
  const extended = continuedProgress && continuedProgress.from === base && continuedProgress.value.state === "progress" ? continuedProgress.value : null;
  const done = extended ?? base;
  const retryNotice = retryResult.state === "notice" ? retryResult.notice : null;
  return (
    <div className="flex flex-col gap-4">
      <OverInviteConfirm
        action={formAction as unknown as (formData: FormData) => void}
        preview={preview}
        batchKey={batchKey}
        notice={notice}
        recipientChooser={
          <>
            <input type="hidden" name="serviceId" value={scope.serviceId} />
            <input type="hidden" name="windowDays" value={scope.windowDays} />
            <input type="hidden" name="allowedWeekdays" value={scope.allowedWeekdays ? scope.allowedWeekdays.join(",") : ""} />
            <RecipientChooser candidates={candidates} onSelectionChange={onSelectionChange} />
          </>
        }
      />
      {done ? (
        <section aria-live="polite" data-testid="over-invite-result" className="flex flex-col gap-2 text-sm">
          <p>
            {done.sent} sent · {done.skipped} not sent · {done.failed} could not be delivered · {done.pending} still to send · {done.quantity} chosen
          </p>
          {done.pending > 0 ? (
            <button
              type="button"
              disabled={pendingContinue}
              className="min-h-11 self-start rounded-md border px-3"
              onClick={() => startContinue(async () => setContinuedProgress({ from: base as OverInviteResult, value: await continueAction(done) }))}
            >
              Keep sending the remaining {done.pending}
            </button>
          ) : null}
          {done.refusedDeliveries.length > 0 ? (
            <form action={retryFormAction as unknown as (formData: FormData) => void} className="flex flex-col gap-2">
              {done.refusedDeliveries.map((t) => (
                <input key={t.entryId} type="hidden" name="retry" value={`${t.entryId}:${t.itemId}`} />
              ))}
              <button type="submit" className="min-h-11 self-start rounded-md border px-3">
                Retry {done.refusedDeliveries.length} undelivered
              </button>
            </form>
          ) : null}
          {retryNotice ? <p role="alert">{retryNotice}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
