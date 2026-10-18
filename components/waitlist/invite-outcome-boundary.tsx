"use client";

import { createContext, useActionState, useContext } from "react";
import { cx } from "@/components/ui/control-base";
import { COMPOSER_FIELD_NAMES } from "@/lib/waitlist/b4-invitation-draft";
import {
  invitationNoticeFor,
  type InvitationNotice,
  type InvitationOutcome,
} from "@/lib/waitlist/invite-to-book-contract";

/**
 * WHO OWNS THE SUBMISSION RESULT — and why it cannot be the composer.
 *
 * `inviteToBookAction` calls `revalidatePath` on a COMMITTED admission, which is
 * correct: the queue must show the truth immediately. The entry's status then
 * moves `waiting`/`claimed` -> `invited`, and the page mounts a composer only for
 * `INVITE_TO_BOOK_STATUSES` (`["waiting", "claimed"]`). So on exactly the
 * outcomes that carry a delivery disposition, the composer UNMOUNTS and any
 * state it owned goes with it.
 *
 * The first attempt at this feature put `useActionState` inside the composer. It
 * rendered correctly for `refused` and `indeterminate` — which do not revalidate
 * — and showed NOTHING for all three committed cases. That is the exact
 * inversion of the requirement: the delivery disposition only exists when the
 * admission committed.
 *
 * This boundary is mounted ABOVE every section, so it survives the row changing
 * status, the composer disappearing, and the row leaving the visible list
 * entirely.
 *
 * NOTHING IS PERSISTED. No store, cookie, localStorage or URL payload, and no
 * read-back to reconstruct a disposition. A fresh page load shows no notice,
 * because a fresh page load has not observed a send — inventing one would be the
 * "infer delivery after reload" failure this feature exists to avoid.
 */
export type SubmittedInvitation = {
  /** Which prospect this answer belongs to. Attribution, never authority. */
  entryId: string;
  entryName: string;
  notice: InvitationNotice;
};

export type InviteOutcomeResult =
  | { outcome: InvitationOutcome }
  | { outcome: null; reason: "malformed_submission" };

/**
 * The one field this boundary reads from the submission.
 *
 * THE PROSPECT'S NAME IS NOT READ FROM THE FORM. It is resolved from the
 * server-rendered roster below, because the composer's own guard requires every
 * hidden input to be a declared INTENT field — and a display name is not intent.
 * Adding one would have widened what the browser may say about a submission to
 * win a label.
 */
/**
 * READ FROM THE COMPOSER'S OWN CONSTANT, never a literal. The field is
 * `entry_id`, not `entryId`; guessing it produced an empty id and a notice that
 * said "This prospect" for everyone — attribution silently lost while every
 * assertion about the MESSAGE still passed.
 */
export const OUTCOME_ENTRY_FIELD = COMPOSER_FIELD_NAMES.entryId;

type InviteOutcomeBinding = {
  action: (formData: FormData) => void;
  /**
   * A submission is in flight.
   *
   * THIS IS THE ONLY OBSERVER OF THE RESULT. Nothing is persisted — no store, no
   * cookie, no URL payload — so a full navigation during the round trip destroys
   * the answer before anyone reads it, and the invitation may already have
   * committed and consumed the round's allowance. Queue navigation is therefore
   * withheld until the action settles, and returns immediately afterwards.
   */
  pending: boolean;
};

const InviteOutcomeContext = createContext<InviteOutcomeBinding | null>(null);

/**
 * The bound action a composer submits through.
 *
 * `null` when no boundary is present, which is how the void-action callers #683
 * supports keep working untouched.
 */
export function useInviteOutcomeAction(): ((formData: FormData) => void) | null {
  return useContext(InviteOutcomeContext)?.action ?? null;
}

/**
 * Is a submission in flight?
 *
 * `false` when no boundary is present, so a surface without one navigates
 * exactly as it always did.
 */
export function useInviteOutcomePending(): boolean {
  return useContext(InviteOutcomeContext)?.pending ?? false;
}

/**
 * The result, rendered.
 *
 * PURE AND EXPORTED so every outcome is provable by static rendering. A status
 * that only appeared after a live submission could not be tested at all.
 *
 * `role="status"` + `aria-live="polite"`: the practitioner's attention is on the
 * row they just acted on, and the queue has just changed underneath them. A
 * committed invitation whose email was REFUSED is exactly the case that must not
 * pass unannounced.
 */
export function InvitationOutcomeNotice({
  submitted,
}: {
  submitted: SubmittedInvitation | null;
}) {
  if (!submitted) return null;
  const { notice, entryName, entryId } = submitted;
  const tone =
    notice.tone === "success"
      ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
      : notice.tone === "warning"
        ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        : "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200";
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="invite-outcome"
      data-tone={notice.tone}
      data-entry-id={entryId}
      data-invitation-exists={notice.invitationExists ? "true" : "false"}
      className={cx("rounded-md border px-3 py-2 text-sm", tone)}
    >
      {/* THE PROSPECT IS NAMED. One notice serves every row, so without the name
          a practitioner who invites Sarah and then Amara cannot tell whose
          answer they are reading. */}
      <span className="font-medium">{entryName}: </span>
      {notice.message}
    </div>
  );
}

export function InviteOutcomeBoundary({
  action,
  entryNames,
  children,
}: {
  action: (formData: FormData) => Promise<InviteOutcomeResult>;
  /** Server-rendered id -> display name for the rows on this page. */
  entryNames: Readonly<Record<string, string>>;
  children: React.ReactNode;
}) {
  const [submitted, boundAction, pending] = useActionState<
    SubmittedInvitation | null,
    FormData
  >(
    async (_prev, formData) => {
      // Identity is captured from THIS submission before the action runs, so the
      // answer cannot be attributed to whichever row happens to be rendered when
      // it returns. A later submission replaces this state wholesale — one
      // answer at a time, always the most recent, always named.
      const entryId = String(formData.get(OUTCOME_ENTRY_FIELD) ?? "");
      // Resolved from server state. The row may be gone from the list by the
      // time this renders, which is exactly why the map is captured up here.
      const entryName = entryNames[entryId] ?? "This prospect";
      const result = await action(formData);
      return {
        entryId,
        entryName,
        notice: invitationNoticeFor(
          result.outcome,
          result.outcome === null ? result.reason : undefined,
        ),
      };
    },
    null,
  );

  return (
    <InviteOutcomeContext.Provider value={{ action: boundAction, pending }}>
      <div className="flex flex-col gap-3">
        <InvitationOutcomeNotice submitted={submitted} />
        {children}
      </div>
    </InviteOutcomeContext.Provider>
  );
}
