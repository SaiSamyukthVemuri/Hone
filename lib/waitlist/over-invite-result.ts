// What the over-invite actions return to the page. Fixed sentences and counts only: never a name, an email, a token or provider text.

export const OVER_INVITE_NOTICES = {
  malformed: "That submission could not be read. Reload the page and try again. Nothing was sent.",
  nobody: "Choose at least one person to invite. Nothing was sent.",
  needConfirm: "Tick the box to confirm that some clients may find no availability. Nothing was sent.",
  ownerOnly: "Only the studio owner can send these invitations. Nothing was sent.",
  unavailable: "We couldn't prepare these invitations just now. Nothing was sent. Please try again.",
  notYetAvailable: "Sending beyond the estimate is not available yet. Nothing was sent.",
  noneEligible: "None of the chosen people can be invited right now (they may already be invited or have a follow-up open). Nothing was sent.",
  changed: "The numbers changed since you looked. Check them below and confirm again. Nothing was sent.",
  keyReused: "This page was already used for a different selection. Reload the page and choose again. Nothing was sent.",
  alreadyQueued: "Some of the chosen people are already in a batch that is being sent. Reload the page and choose again. Nothing was sent.",
  invalidEntries: "Some of the chosen people are no longer on the waitlist. Reload the page and choose again. Nothing was sent.",
} as const;

export type OverInviteRetryTarget = { entryId: string; itemId: string };

export type OverInviteResult =
  | { state: "idle" }
  | { state: "notice"; notice: string }
  | { state: "reconfirm"; notice: string; fit: number; active: number; extra: number; expiringSoon: number }
  | {
      state: "progress";
      quantity: number;
      extraRequested: number;
      /** Confirmed recipients not yet processed. They stay queued in the batch; this is pagination, never a cap. */
      pending: number;
      sent: number;
      skipped: number;
      failed: number;
      /** Deliveries the provider REFUSED. Only these may be retried (through replace); an unknown delivery never is. */
      refusedDeliveries: OverInviteRetryTarget[];
    };
