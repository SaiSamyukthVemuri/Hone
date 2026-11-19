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
export const OVER_INVITE_SUBMIT_LABEL = "Send invitations";

export type OverInviteRecipient = { entryId: string; name: string };

export function OverInviteConfirm({
  action,
  preview,
  recipients,
  batchKey,
  notice,
}: {
  action: (formData: FormData) => void | Promise<void>;
  preview: OverInvitePreview;
  recipients: readonly OverInviteRecipient[];
  /** Generated once per page render, so a double submit is one batch. */
  batchKey: string;
  notice?: string | null;
}) {
  return (
    <form action={action} data-testid="over-invite-confirm" className="flex flex-col gap-3 text-sm">
      <input type="hidden" name="batchKey" value={batchKey} />
      <input type="hidden" name="shownFit" value={preview.fit} />
      <input type="hidden" name="shownActive" value={preview.active} />
      <input type="hidden" name="shownExtra" value={preview.extra} />
      <p data-testid="over-invite-line" className="font-medium">{preview.line}</p>
      <p data-testid="over-invite-expiring" className="text-neutral-600 dark:text-neutral-400">{expiringSoonLabel(preview.expiringSoon)}</p>
      <p data-testid="over-invite-warning" role="note">{preview.ownerCopy}</p>
      <fieldset className="flex flex-col gap-1">
        <legend className="font-medium">Choose who to invite</legend>
        {recipients.map((r) => (
          <label key={r.entryId} className="flex min-h-11 items-center gap-2">
            <input type="checkbox" name="entryId" value={r.entryId} />
            <span className="break-words">{r.name}</span>
          </label>
        ))}
      </fieldset>
      <label className="flex min-h-11 items-start gap-2">
        <input type="checkbox" name="confirmed" className="mt-1" />
        <span>{OVER_INVITE_CONFIRM_LABEL}</span>
      </label>
      {notice ? <p role="alert" data-testid="over-invite-notice">{notice}</p> : null}
      <button type="submit" className="min-h-11 self-start rounded-md border px-3">{OVER_INVITE_SUBMIT_LABEL}</button>
    </form>
  );
}
