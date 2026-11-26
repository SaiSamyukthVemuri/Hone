"use client";

import type { KeyboardEvent, ReactNode } from "react";
import { expiringSoonLabel, type OverInvitePreview } from "@/lib/waitlist/over-invite-preview";

// The owner's "Invite beyond estimated capacity" confirmation. Presentational: the page decides whether to render it (owner only) and passes the
// server action, so this calls no command itself. The estimate is a WARNING the owner acknowledges, never a block: the submit button is always
// present, there is no capacity ceiling, and with nothing chosen the action (not a disabled button) says so. Recipients are chosen explicitly;
// nobody is selected by default. Invitations do not reserve appointments, and the owner copy says so.

// CALLER CONTRACT (from review of the logic this sits on):
//  - The expiring label says "within 24 hours", so the caller must compute `expiringSoon` with a 24-hour horizon. The count is STUDIO-WIDE, can
//    exceed the window's active count, and is informational: a change in it alone does not re-ask the owner.
//  - The caller owns the batch's `previous` results. Omitting them re-attempts everything.
//  - A failed delivery that actually reached the provider can be sent twice if it is reopened; only the server's duplicate guard stops that.

export const OVER_INVITE_CONFIRM_LABEL = "I understand some clients may find no availability";
/** Required ONLY when no appointments are estimated: the server refuses the send without it. Pinned verbatim by a test. */
export const OVER_INVITE_NO_TIMES_LABEL = "These clients may open the invitation and find no times to book.";
export const OVER_INVITE_SUBMIT_LABEL = "Send invitations";

/**
 * Enter on a focused checkbox or text box can submit a form in some browsers. Only the submit button may: any other Enter inside this form is
 * ignored, so an invitation batch is never sent by a stray keypress. (Space on a checkbox and Enter on a button still work as normal.)
 */
export function blockImplicitSubmit(e: KeyboardEvent<HTMLFormElement>) {
  if (e.key !== "Enter") return;
  const t = e.target as HTMLElement;
  if (t instanceof HTMLButtonElement || t instanceof HTMLTextAreaElement) return;
  e.preventDefault();
}

export function OverInviteConfirm({
  action,
  preview,
  recipientChooser,
  batchKey,
  notice,
  scopeSummary,
}: {
  action: (formData: FormData) => void | Promise<void>;
  preview: OverInvitePreview;
  /**
   * The recipient list, supplied by the caller (the chooser). THIS FORM RENDERS NO entryId INPUTS OF ITS OWN: the chooser is the one source of
   * `entryId`, so combining the two can never post a person twice.
   */
  recipientChooser: ReactNode;
  /** Generated once per page render, so a double submit is one batch. */
  batchKey: string;
  notice?: string | null;
  /** The service, booking window and number of people selected, shown before the send. */
  scopeSummary?: { service: string; window: string; people: string };
}) {
  return (
    <form action={action} onKeyDown={blockImplicitSubmit} data-testid="over-invite-confirm" className="flex flex-col gap-3 text-sm">
      <input type="hidden" name="batchKey" value={batchKey} />
      <input type="hidden" name="shownFit" value={preview.fit} />
      <input type="hidden" name="shownActive" value={preview.active} />
      <input type="hidden" name="shownExtra" value={preview.extra} />
      <p data-testid="over-invite-line" className="font-medium">{preview.line}</p>
      <p data-testid="over-invite-expiring" className="text-neutral-600 dark:text-neutral-400">{expiringSoonLabel(preview.expiringSoon)}</p>
      <p data-testid="over-invite-warning" role="note">{preview.ownerCopy}</p>
      {recipientChooser}
      {scopeSummary ? (
        <ul data-testid="over-invite-scope" className="flex flex-col gap-0.5">
          <li>{scopeSummary.service}</li>
          <li>{scopeSummary.window}</li>
          <li data-testid="over-invite-people">{scopeSummary.people}</li>
        </ul>
      ) : null}
      <label className="flex min-h-11 items-start gap-2">
        <input type="checkbox" name="confirmed" className="mt-1" />
        <span>{OVER_INVITE_CONFIRM_LABEL}</span>
      </label>
      {preview.fit === 0 ? (
        <label className="flex min-h-11 items-start gap-2" data-testid="over-invite-no-times">
          <input type="checkbox" name="ackNoTimes" className="mt-1" />
          <span>{OVER_INVITE_NO_TIMES_LABEL}</span>
        </label>
      ) : null}
      {notice ? <p role="alert" data-testid="over-invite-notice">{notice}</p> : null}
      <button type="submit" className="min-h-11 self-start rounded-md border px-3">{OVER_INVITE_SUBMIT_LABEL}</button>
    </form>
  );
}
