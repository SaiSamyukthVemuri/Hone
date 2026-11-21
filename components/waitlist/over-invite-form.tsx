"use client";

import { useActionState, useCallback, useState } from "react";
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
  candidates,
  fit,
  active,
  expiringSoon,
  batchKey,
  scope,
}: {
  action: (prev: OverInviteResult, formData: FormData) => Promise<OverInviteResult>;
  candidates: readonly Candidate[];
  fit: number;
  active: number;
  expiringSoon: number;
  batchKey: string;
  scope: { serviceId: string; windowDays: number; allowedWeekdays: readonly number[] | null };
}) {
  const [result, formAction] = useActionState(action, { state: "idle" } as OverInviteResult);
  const [chosen, setChosen] = useState(0);
  // The selection size when the server last asked again; while it is unchanged the line shows the SERVER's numbers (what it can actually invite).
  const [reconfirmAt, setReconfirmAt] = useState<{ result: OverInviteResult; chosen: number } | null>(null);
  if (result.state === "reconfirm" && reconfirmAt?.result !== result) setReconfirmAt({ result, chosen });
  const onSelectionChange = useCallback((n: number) => setChosen(n), []);
  // After a re-ask the server's fresh numbers replace the ones the owner saw.
  const shown = result.state === "reconfirm" ? { fit: result.fit, active: result.active, expiringSoon: result.expiringSoon } : { fit, active, expiringSoon };
  const serverExtra = result.state === "reconfirm" && reconfirmAt?.result === result && reconfirmAt.chosen === chosen ? result.extra : null;
  const preview = buildOverInvitePreview({ ...shown, extra: serverExtra ?? chosen });
  const notice = result.state === "notice" || result.state === "reconfirm" ? result.notice : null;
  const done = result.state === "progress" ? result : null;
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
            {done.quantity} confirmed · {done.sent} sent so far · {done.pending} waiting to send
          </p>
          {done.pending > 0 ? <p>The rest are sent in the background. You can leave this page; reopening it shows where the batch is.</p> : null}
        </section>
      ) : null}
    </div>
  );
}
