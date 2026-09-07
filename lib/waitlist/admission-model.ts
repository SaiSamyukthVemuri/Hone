// ===========================================================================
// NEW-CLIENT WAITLIST — THE LIFECYCLE A STUDIO CAN ACTUALLY DRIVE TODAY
// ===========================================================================
//
// PURE. No database, no server action, no `server-only` marker — this module is
// consumed by a server component and by tests, and it performs no I/O. It
// decides what the operator surface may OFFER and what it must SAY when it
// offers nothing. It never performs, and never authorises, a mutation.
//
// EVERY ACTION HERE IS WIRED. The five below — claim, expire, release, requeue,
// remove — each reach a shipped command through
// app/(app)/settings/waitlist/actions.ts, and /settings/waitlist is the one
// importer of this module. That is the boundary this file is drawn on: an
// action a studio cannot yet perform does not belong in it.
//
// INVITING IS NOT HERE, AND IS NOT IN THIS REPOSITORY STATE AT ALL.
// `issue_new_client_waitlist_invitation` mints a token that has to reach a real
// recipient, which is B1/B1.5c + B2 work. Invite, reinvite, the TTL bounds and
// the whole invitation-draft apparatus were removed from this module and now
// live on the WAIT-03 B4 prototype branch (`feat/wait03-b4-admission-prototype`,
// draft PR #683) as `lib/waitlist/b4-invitation-draft.ts`. Do not look for that
// file here — it is deliberately absent, so an unwired action cannot be offered
// by a surface that has no way to name it. Keeping the two halves together made
// every review round spend itself on staged code while the live surface waited.
//
// THE VOCABULARY IS THE DATABASE'S, NOT THE BRIEF'S. The seven states below are
// copied from migration 0188's own CHECK constraint. Where the brief's words and
// the database's disagree, the database wins. The map between the two is a
// prototype design artifact, so it left with the prototype; nothing on this
// surface consults it, because this surface renders the database's own words.
//
// DISCLOSURE, NOT JUST DISABLEMENT. Every unavailable action returns its REASON
// from the same function that decides availability, so a greyed control can
// never hide its own prerequisite. That is the EMERG-02 rule applied here: one
// function, one call site, the button state and the sentence beside it derived
// together so they cannot drift.
// ===========================================================================

// --- 1. THE LIFECYCLE, AS THE DATABASE DEFINES IT --------------------------
//
// Verbatim from 0188:
//   check (status in ('waiting','claimed','invited','converted','expired',
//                     'released','removed'))
//
// Seven states. Two of them — `converted` and `removed` — are terminal, and the
// availability rules below refuse every action on both.

export const WAITLIST_ENTRY_STATUSES = [
  "waiting",
  "claimed",
  "invited",
  "converted",
  "expired",
  "released",
  "removed",
] as const;

export type WaitlistEntryStatus = (typeof WAITLIST_ENTRY_STATUSES)[number];

/** Operator-facing label for each shipped state. `claimed` is the state the
 *  brief does not name: the entry is held for this studio but no invitation has
 *  been issued yet, which is a real and visible waiting room of its own. */
export const STATUS_LABEL: Record<WaitlistEntryStatus, string> = {
  waiting: "Waiting",
  claimed: "Held",
  invited: "Invited",
  converted: "Booked",
  expired: "Expired",
  released: "Released",
  removed: "Removed",
};

/** One line explaining what the state MEANS operationally. Shown beside the
 *  status so a practitioner never has to infer the difference between `Held`
 *  and `Invited`, or between `Released` and `Removed`. */
export const STATUS_MEANING: Record<WaitlistEntryStatus, string> = {
  waiting: "In the queue. No one has started admitting them.",
  claimed: "Held for this studio. No invitation has been sent yet.",
  // For an `invited` entry the page may know MORE than the status does — see
  // `statusMeaning` below. This sentence is only the no-context default.
  invited: "An invitation is out.",
  converted: "They booked. This entry is closed.",
  expired: "The invitation ran out before it was used.",
  released: "Out of the queue. Return them to it before they can be claimed again.",
  removed: "Taken off the waitlist by the studio. Terminal.",
};

// --- 2. ACTIONS --------------------------------------------------------------

export const ADMISSION_ACTIONS = [
  "claim",
  "expire",
  "release",
  "requeue",
  "remove",
] as const;

export type AdmissionAction = (typeof ADMISSION_ACTIONS)[number];

export const ACTION_LABEL: Record<AdmissionAction, string> = {
  claim: "Claim",
  expire: "Record expired",
  release: "Release",
  requeue: "Return to queue",
  remove: "Remove from waitlist",
};

/**
 * Whether an action may be offered, and if not, WHY — from one function, so the
 * control and its explanation cannot disagree.
 *
 * `reason` is written for a practitioner, not a developer: it names the current
 * state and the next thing they could do, never a status code.
 */
export type ActionAvailability =
  | { available: true }
  | { available: false; reason: string };

/**
 * Facts beyond the entry's status that an availability ruling needs.
 *
 * Only ONE exists, and it is load-bearing: whether a live invitation's window
 * has already run out. `expire` is NOT a cancel button — see the case below —
 * so it cannot be decided from `status` alone.
 */
export type AdmissionContext = {
  /** True only when the CURRENT invitation's `expires_at` is in the past and it
   *  carries no terminal stamp. Unknown or absent is treated as NOT elapsed,
   *  which withholds the control rather than offering one the DB would refuse. */
  invitationElapsed?: boolean;
  /**
   * True when the current invitation has been REDEEMED.
   *
   * Redemption does not move the entry: `redeem_new_client_waitlist_invitation`
   * stamps `redeemed_at` and leaves the entry at `invited` until a conversion is
   * recorded. So `status === "invited"` alone cannot tell a live invitation from
   * a used one, and every control that a used one forbids has to be told.
   */
  invitationRedeemed?: boolean;
  /**
   * True when the invitation facts could NOT be read at all.
   *
   * Distinct from `invitationRedeemed: false`, and the distinction is the whole
   * point: an unread invitation might be redeemed, and `release` would then
   * answer `already_redeemed`. Treating unknown as "not redeemed" fails OPEN and
   * offers a control that cannot succeed, so every control that depends on the
   * invitation is withheld while this is true.
   */
  invitationFactsUnknown?: boolean;
};

export function actionAvailability(
  action: AdmissionAction,
  status: WaitlistEntryStatus,
  context: AdmissionContext = {},
): ActionAvailability {
  const label = STATUS_LABEL[status].toLowerCase();

  if (status === "converted") {
    return {
      available: false,
      reason: "They have already booked. Nothing further is needed here.",
    };
  }
  if (status === "removed") {
    return {
      available: false,
      reason: "This entry was removed from the waitlist and cannot be reopened.",
    };
  }

  switch (action) {
    case "claim":
      if (status === "waiting") return { available: true };
      return {
        available: false,
        reason: `Only a waiting entry can be claimed — this one is ${label}.`,
      };

    case "release":
      // The operator's way to END something early, and the only one. It is
      // offered on `claimed` (give the hold back) and on `invited` (end a live
      // invitation before its window runs out).
      //
      // NOT ON A REDEEMED ONE. Redemption leaves the entry at `invited` until a
      // conversion is recorded, so status alone would keep offering Release for
      // that whole interval — and `release_new_client_waitlist_entry` guards on
      // `redeemed_at is null`, so the control is guaranteed to return
      // `already_redeemed`. Offering a control that cannot succeed is exactly
      // what deriving availability from stored state is meant to prevent.
      if (status === "invited" && context.invitationFactsUnknown) {
        // FAIL CLOSED. The invitation could not be read, so whether it has been
        // used is unknown — and a used one can only answer `already_redeemed`.
        return {
          available: false,
          reason:
            "This invitation could not be checked just now, so it cannot be released safely. Try again shortly.",
        };
      }
      if (status === "invited" && context.invitationRedeemed) {
        return {
          available: false,
          reason: "That invitation has already been used. It can no longer be released.",
        };
      }
      if (status === "claimed" || status === "invited") return { available: true };
      return {
        available: false,
        reason: `There is nothing to release — this entry is ${label}.`,
      };

    case "expire":
      // EXPIRE IS NOT CANCELLATION. It records a fact the clock has already
      // established; it does not cause it. Offering it on a live invitation
      // would present "end this early" twice under two names, and one of them
      // would be a lie about what the command does.
      if (status !== "invited") {
        return {
          available: false,
          reason: "There is no invitation on that entry to record as expired.",
        };
      }
      if (context.invitationRedeemed) {
        // A used invitation is terminal; the command answers `already_redeemed`.
        return {
          available: false,
          reason: "That invitation has already been used, so it cannot expire.",
        };
      }
      if (!context.invitationElapsed) {
        return {
          available: false,
          reason: `This invitation has not run out yet. Use “${ACTION_LABEL.release}” to end it early.`,
        };
      }
      return { available: true };

    case "requeue":
      if (status === "released" || status === "expired") return { available: true };
      if (status === "waiting") {
        return { available: false, reason: "They are already in the queue." };
      }
      return {
        available: false,
        reason: `Release the invitation first, then return them to the queue.`,
      };

    case "remove":
      // NOT while the entry is held or invited. `remove_new_client_waitlist_entry`
      // answers `release_required` for both, changing nothing — so an owner who
      // opened the confirm disclosure and pressed it would get an avoidable
      // error. The remedy is named instead.
      if (status === "claimed" || status === "invited") {
        return {
          available: false,
          reason: `This entry is ${label}. Release it first, then it can be removed.`,
        };
      }
      return { available: true };
  }
}

/**
 * The status sentence, refined by whatever the caller actually knows.
 *
 * `redeem_new_client_waitlist_invitation` stamps the invitation and LEAVES the
 * entry at `invited` until a conversion is recorded, so a status-only sentence
 * says "an invitation is out and has not yet been used" while the page's own
 * controls have already recognised it as used. Where the invitation facts are
 * loaded, the description has to agree with them — a surface that contradicts
 * its own buttons teaches an operator to distrust both.
 */
export function statusMeaning(
  status: WaitlistEntryStatus,
  context: AdmissionContext = {},
): string {
  if (status === "invited") {
    if (context.invitationFactsUnknown) {
      return "An invitation is out. Its current state could not be checked just now.";
    }
    if (context.invitationRedeemed) {
      return "The invitation has been used. This entry stays here until the booking is recorded.";
    }
    if (context.invitationElapsed) {
      return "The invitation ran out and has not been recorded as expired yet.";
    }
    return "An invitation is out and has not yet been used.";
  }
  return STATUS_MEANING[status];
}
