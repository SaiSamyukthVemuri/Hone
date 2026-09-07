// ===========================================================================
// WAIT-03 B4 — THE PRACTITIONER'S WAITLIST, WITH THE STATE MACHINE HIDDEN
// ===========================================================================
//
// PURE, AND NOT REACHED BY THE APPLICATION. Nothing under `app/` imports this
// module, and `tests/lib/waitlist/b4-invitation-draft.test.ts` walks the
// application to prove it. It exists so the B4 prototype has somewhere to live
// that a reviewer can tell apart from the surface a studio uses today.
//
// THE PRODUCT RULING THIS FILE IMPLEMENTS
// ---------------------------------------
// A practitioner does not know, and must never be asked, what a waitlist entry
// "is". There is ONE action on a person who is waiting:
//
//     Invite to book
//
// There is no Claim, no Claim next, and no Reinvite. Those were the database's
// words on a practitioner's screen. An earlier revision of this prototype
// rendered all seven internal actions as a menu, disabled the ones the entry's
// status forbade, and explained each refusal — a faithful rendering of the
// state machine, and exactly the thing the ruling removes. A person who has
// been invited before and is eligible again gets "Invite to book", the same as
// anyone else; whether the server calls that an invitation or a re-invitation
// is not a question this screen asks.
//
// WHERE THE RULES ACTUALLY LIVE, AND WHY THIS IS NOT A SECOND ENGINE
// ------------------------------------------------------------------
// `lib/waitlist/admission-model.ts` is the live authority on what may be done
// to an entry. It ships, it is imported by /settings/waitlist, and it encodes
// the shipped commands' preconditions — including the two fail-closed rulings
// that are easy to get wrong (a redeemed invitation cannot be released; an
// invitation whose facts could not be READ is treated as unreleasable rather
// than as unredeemed).
//
// This module does not restate any of that. For every action it offers, the
// VERDICT — available or not — is delegated to `actionAvailability`, and
// `entryActionSurface` is a projection of the live model, not a parallel copy
// of it. The test file pins this: for every action, at every status, under
// every invitation context, our boolean must equal the live model's boolean.
// A rule that changed here and not there turns that test red.
//
// WHAT IS GENUINELY OURS, AND IT IS ONLY THIS:
//
//   1. WHICH actions appear, and which is primary. A projection, not a rule.
//   2. The SENTENCE beside a refused action, where the live model's own
//      sentence names a control this surface does not have. The live copy says
//      «Use "Release" to end it early»; there is no Release button here, so
//      repeating it would send a practitioner looking for a control that does
//      not exist. The verdict is still the live model's; only the wording is
//      re-translated, and `RETRANSLATED_REFUSALS` names every case.
//   3. Two compound actions the live model does not model, because no single
//      shipped command performs them — see the contract module. Their verdicts
//      are still derived from the live verdict of their FIRST hop.
//
// ONE EXTRA RULE, STATED RATHER THAN SMUGGLED. `expire` in the live model
// treats "the window has not elapsed" and "we could not read the window" the
// same way, because `expire` alone is never offered on an unread invitation.
// This surface's "Return to waitlist" runs THROUGH expire on a live invitation,
// so it has to tell those apart, and it fails closed on unknown — the same
// ruling `release` already applies one line above it. See
// `UNKNOWN_INVITATION_FAILS_CLOSED`.
// ===========================================================================

import {
  actionAvailability,
  type ActionAvailability,
  type AdmissionAction,
  type AdmissionContext,
  type WaitlistEntryStatus,
} from "@/lib/waitlist/admission-model";
import {
  SCOPE_UNSUPPORTED_REASON,
  adapterMissingReason,
  type AdapterCapabilities,
  type BookingScope,
  type InviteToBookInput,
} from "@/lib/waitlist/invite-to-book-contract";

// --- 1. WHAT A PRACTITIONER SEES A STATE CALLED -----------------------------

/**
 * The seven shipped states, in practitioner language.
 *
 * The database's vocabulary — `claimed`, `released`, `converted` — describes
 * what the row did. These describe what the studio should understand. Neither
 * `claimed` nor `released` survives as a word on screen.
 *
 * `claimed` IS STILL REACHABLE, so it still needs a label. Under this design no
 * practitioner action produces it — "Invite to book" claims and issues as one
 * operation — but entries held by the older surface exist, and a row with no
 * label is worse than a row with an internal one. It reads "Ready to invite",
 * which is what it is, and its primary action is the ordinary one.
 *
 * `released` reads "Ready to return" rather than "Invitation canceled".
 * Cancelling a live invitation is the common way to reach it, but not the only
 * one: a `claimed` entry released without ever being invited lands here too,
 * and a row that announces a cancelled invitation where none was ever sent is a
 * false statement about a person. The forward-looking half of the product
 * ruling's own wording is true in both cases.
 */
export const PRACTITIONER_STATUS_LABEL: Record<WaitlistEntryStatus, string> = {
  waiting: "Waiting",
  claimed: "Ready to invite",
  invited: "Invitation sent",
  converted: "Booked",
  expired: "Invitation expired",
  released: "Ready to return",
  removed: "Removed",
};

/**
 * The label, refined by what the caller actually knows about the invitation.
 *
 * AN ELAPSED INVITATION READS "Invitation expired" EVEN THOUGH THE ENTRY IS
 * STILL `invited`. Recording the expiry is a bookkeeping transition the
 * database performs; whether it has happened yet is not a fact a practitioner
 * should be able to observe, let alone one they should have to fix with a
 * "Record expired" button. The live model's own status sentence says the quiet
 * part out loud — "has not been recorded as expired yet" — which is precisely
 * the leak this surface exists to close.
 */
export function practitionerStatusLabel(
  status: WaitlistEntryStatus,
  context: AdmissionContext = {},
): string {
  if (status === "invited" && invitationHasRunOut(context)) {
    return PRACTITIONER_STATUS_LABEL.expired;
  }
  return PRACTITIONER_STATUS_LABEL[status];
}

/**
 * Has this invitation's window actually closed, so far as we can tell?
 *
 * UNKNOWN FACTS BEAT A STALE ELAPSED FLAG, and that precedence is the whole
 * point of this helper existing rather than the expression being inlined three
 * times. An unreadable invitation may already have been REDEEMED, and a
 * redeemed one has not expired at all — so trusting `invitationElapsed` while
 * `invitationFactsUnknown` is set would let the row announce "Invitation
 * expired" and hide the live-invitation controls on the strength of a bit we
 * just admitted we could not verify.
 *
 * An earlier revision read the flags independently in the label, the detail
 * sentence and the action surface, and the three disagreed: the pill said
 * "Invitation expired" while the sentence underneath it said the state could
 * not be checked. One predicate, three call sites, no way to drift.
 */
export function invitationHasRunOut(context: AdmissionContext): boolean {
  if (context.invitationFactsUnknown) return false;
  if (context.invitationRedeemed) return false;
  return context.invitationElapsed === true;
}

/** One line of plain explanation under the name. Never mentions a state name,
 *  a command, or a transition. */
export function practitionerStatusDetail(
  status: WaitlistEntryStatus,
  context: AdmissionContext = {},
): string {
  switch (status) {
    case "waiting":
      return "In the queue, waiting for an invitation.";
    case "claimed":
      return "Held for this studio. Nothing has been sent yet.";
    case "invited":
      if (context.invitationFactsUnknown) {
        return "An invitation is out. Its current state could not be checked just now.";
      }
      if (context.invitationRedeemed) {
        return "They have used their invitation. This entry stays here until their booking is recorded.";
      }
      if (invitationHasRunOut(context)) {
        return "Their invitation ran out before they booked.";
      }
      return "They have a live booking link and have not used it yet.";
    case "converted":
      return "They booked. Nothing further is needed here.";
    case "expired":
      return "Their invitation ran out before they booked.";
    case "released":
      return "They are out of the queue. Return them to it to invite them again.";
    case "removed":
      return "Taken off the waitlist by the studio.";
  }
}

// --- 2. THE ACTIONS A PRACTITIONER HAS ---------------------------------------

export const PRACTITIONER_ACTIONS = [
  "invite_to_book",
  "resend_invitation",
  "cancel_invitation",
  "return_to_waitlist",
  "remove_from_waitlist",
] as const;

export type PractitionerAction = (typeof PRACTITIONER_ACTIONS)[number];

export const PRACTITIONER_ACTION_LABEL: Record<PractitionerAction, string> = {
  invite_to_book: "Invite to book",
  resend_invitation: "Resend invitation",
  cancel_invitation: "Cancel invitation",
  return_to_waitlist: "Return to waitlist",
  remove_from_waitlist: "Remove from waitlist",
};

/** Actions that undo something a person may already be acting on, or that end
 *  their place in the queue. The surface confirms these before performing them;
 *  the component owns the confirmation, this is the fact it keys off. */
export const DESTRUCTIVE_ACTIONS: ReadonlyArray<PractitionerAction> = [
  "cancel_invitation",
  "remove_from_waitlist",
];

/**
 * The live action whose verdict governs a practitioner action AT A GIVEN
 * STATUS — the delegation, written as code so a test can execute it rather
 * than take the prose above on trust.
 *
 * IT DEPENDS ON THE STATUS, which is the whole reason this is a function and
 * not a map. "Return to waitlist" is `requeue` from `expired` and `released`;
 * from `invited` it runs through `expire` first, and from `claimed` through
 * `release` — three different first hops behind one label, because the
 * practitioner is not the one who should be choosing between them.
 *
 * `null` means no single live action decides it. `invite_to_book` is the only
 * such case: from `waiting` it is claim-then-issue and from `claimed` it is
 * issue alone, and `issue` has no live-model action at all because no server
 * action carries it. Its domain is stated as `INVITE_TO_BOOK_STATUSES` and
 * proved against migration 0188's own transition table instead.
 *
 * `tests/lib/waitlist/b4-invitation-draft.test.ts` walks every action this
 * surface renders, at every status, under every invitation context, and asserts
 * our verdict against the delegate's. The only permitted divergence is
 * REFUSING where the live model permits — never the reverse, which would offer
 * a control the database is guaranteed to reject.
 */
export function delegateFor(
  action: PractitionerAction,
  status: WaitlistEntryStatus,
): AdmissionAction | null {
  switch (action) {
    case "invite_to_book":
      return null;
    // Resending replaces a live invitation, and its first hop is the release of
    // the one that is out. Everything release refuses — a redeemed invitation,
    // an unreadable one — resending refuses identically and for the same
    // reason.
    case "resend_invitation":
    case "cancel_invitation":
      return "release";
    case "return_to_waitlist":
      if (status === "invited") return "expire";
      if (status === "claimed") return "release";
      return "requeue";
    case "remove_from_waitlist":
      return "remove";
  }
}

/**
 * The statuses "Invite to book" accepts.
 *
 * DERIVED FROM THE SHIPPED TRANSITION TABLE, not chosen. `issue` requires
 * `claimed`; `claimed` is reachable in one hop from `waiting` and from nowhere
 * else that the studio drives. So the compound command's domain is exactly
 * {waiting, claimed}, and the test recomputes that from 0188's own edge list.
 *
 * `expired` and `released` are deliberately NOT here even though a path exists
 * (requeue, claim, issue). The product ruling gives those rows one action —
 * "Return to waitlist" — because a person who is out of the queue rejoins it
 * before they are invited from it, and collapsing three hops into an invite
 * button would silently re-order the queue on the studio's behalf.
 */
export const INVITE_TO_BOOK_STATUSES: ReadonlyArray<WaitlistEntryStatus> = [
  "waiting",
  "claimed",
];

/**
 * WHERE THIS SURFACE WRITES ITS OWN REFUSAL, AND WHY IT HAS TO.
 *
 * The live model's sentences are written for the live screen, and several of
 * them name controls that do not exist here: «Use "Release" to end it early»,
 * «Release it first, then it can be removed», «It can no longer be released».
 * Repeating those verbatim would send a practitioner hunting for a Release
 * button on a screen whose whole premise is that there isn't one.
 *
 * So a handful of refusals below are re-worded. NONE of them changes a verdict
 * — the availability still comes from `actionAvailability`, and the test file
 * executes that claim against every action at every status.
 *
 * There is deliberately no hand-maintained list of which sentences are ours.
 * That list existed, and it was already stale by the time the first test ran:
 * two delegated refusals leaked "released" through paths the list did not
 * name. The guard is mechanical instead — the test walks every label and every
 * refusal this surface can produce and fails on any database word in any of
 * them, which catches the case nobody thought to add.
 */

/**
 * Why an unreadable invitation withholds "Return to waitlist".
 *
 * `actionAvailability("expire", …)` folds "not elapsed" and "could not be read"
 * into one branch, which is safe there because `expire` is only ever offered
 * beside a readable invitation. Here the same call decides a compound that a
 * practitioner reaches from a row whose facts may have failed to load, and
 * "we do not know" must not be answered as "not yet". Unknown fails closed, the
 * way `release` already does one branch above.
 */
export const UNKNOWN_INVITATION_FAILS_CLOSED =
  "This invitation could not be checked just now, so they cannot be returned to the waitlist safely. Try again shortly.";

/**
 * The verdict `release` gives on a live invitation, in this surface's words.
 *
 * Both resending and cancelling begin by releasing the invitation that is out,
 * so both inherit exactly what release refuses. Only the SENTENCE differs, and
 * only because the live one says "released" — a state name, and the name of a
 * control this screen does not have.
 */
function invitationRefusal(
  action: "resend_invitation" | "cancel_invitation",
  context: AdmissionContext,
): ActionAvailability {
  const live = actionAvailability("release", "invited", context);
  if (live.available) return live;

  // FAIL CLOSED, and say which of the two things went wrong. An unreadable
  // invitation might already be used, and the command would answer
  // `already_redeemed`; withholding the control is the live model's ruling and
  // this only re-words it.
  if (context.invitationFactsUnknown) {
    return {
      available: false,
      reason:
        action === "resend_invitation"
          ? "Their invitation could not be checked just now, so it cannot be replaced safely. Try again shortly."
          : "Their invitation could not be checked just now, so it cannot be canceled safely. Try again shortly.",
    };
  }
  if (context.invitationRedeemed) {
    return {
      available: false,
      reason:
        action === "resend_invitation"
          ? "They have already used their invitation, so there is nothing left to resend."
          : "They have already used their invitation, so it can no longer be canceled.",
    };
  }
  return live;
}

export function practitionerActionAvailability(
  action: PractitionerAction,
  status: WaitlistEntryStatus,
  context: AdmissionContext = {},
): ActionAvailability {
  // A CLOSED ENTRY REFUSES EVERYTHING WITH ONE SENTENCE, and the sentence is a
  // fact about the entry rather than about the action. The live model already
  // holds both, so this reads them there instead of keeping a copy that can
  // drift; `claim` is merely the probe, and the test proves the premise — that
  // every live action refuses a closed entry identically.
  if (status === "converted" || status === "removed") {
    return actionAvailability("claim", status);
  }

  switch (action) {
    case "invite_to_book": {
      if (INVITE_TO_BOOK_STATUSES.includes(status)) return { available: true };
      if (status === "invited") {
        return {
          available: false,
          reason: "They already have an invitation. Resend it or cancel it first.",
        };
      }
      // expired | released
      return {
        available: false,
        reason: "Return them to the waitlist first, then you can invite them.",
      };
    }

    case "resend_invitation": {
      if (status !== "invited") {
        return {
          available: false,
          reason: "Nothing has been sent to them yet, so there is nothing to resend.",
        };
      }
      // NOT ON AN INVITATION THAT HAS ALREADY RUN OUT. Resending begins with
      // `release`, which would record an expiry as a cancellation; the entry's
      // own history would then be wrong about what happened. The surface above
      // does not offer it there either, and this refusal keeps the model honest
      // for any other caller.
      if (invitationHasRunOut(context)) {
        return {
          available: false,
          reason:
            "Their invitation has run out. Return them to the waitlist, then invite them again.",
        };
      }
      // The first hop IS release, so its verdict is this action's verdict: a
      // used invitation cannot be replaced, and an unreadable one must not be.
      return invitationRefusal("resend_invitation", context);
    }

    case "cancel_invitation": {
      if (status !== "invited") {
        return {
          available: false,
          reason: "There is no invitation out, so there is nothing to cancel.",
        };
      }
      return invitationRefusal("cancel_invitation", context);
    }

    case "return_to_waitlist": {
      if (status === "invited") {
        // FAIL CLOSED FIRST. See UNKNOWN_INVITATION_FAILS_CLOSED: the delegate
        // below cannot tell "not yet" from "we could not look".
        if (context.invitationFactsUnknown) {
          return { available: false, reason: UNKNOWN_INVITATION_FAILS_CLOSED };
        }
        const viaExpire = actionAvailability("expire", status, context);
        if (viaExpire.available) return { available: true };
        // RETRANSLATED. The live sentence for a still-live invitation names
        // "Release", which is not a control on this screen.
        if (context.invitationRedeemed) {
          return {
            available: false,
            reason:
              "They have already used their invitation. This entry stays here until their booking is recorded.",
          };
        }
        return {
          available: false,
          reason: "Their invitation is still live. Cancel it first, then return them to the waitlist.",
        };
      }
      if (status === "claimed") {
        // Held but never invited: release, then requeue. The release hop
        // governs, and on `claimed` it is unconditionally available.
        return actionAvailability("release", status, context);
      }
      return actionAvailability("requeue", status, context);
    }

    case "remove_from_waitlist": {
      const live = actionAvailability("remove", status, context);
      if (live.available) return live;
      // RETRANSLATED. The live sentence says the entry is "held" or "invited"
      // and to "Release it first" — three words this surface does not use.
      if (status === "claimed") {
        return {
          available: false,
          reason: "Return them to the waitlist first, then you can remove them.",
        };
      }
      if (status === "invited") {
        // NAME THE EXIT THIS ROW ACTUALLY OFFERS. A refusal that says "cancel
        // it first" on a row whose invitation has already expired points at a
        // control that is not there — the same defect as explaining a disabled
        // Remove button with a sentence about sending, one layer down.
        if (context.invitationRedeemed) {
          // The known lifecycle gap: a person who used their invitation and
          // never booked has no operator exit at all until the booking is
          // recorded. Saying so is better than naming a control that will
          // refuse them too.
          return {
            available: false,
            reason:
              "They have already used their invitation. This entry stays here until their booking is recorded.",
          };
        }
        if (context.invitationElapsed) {
          return {
            available: false,
            reason: "Return them to the waitlist first, then you can remove them.",
          };
        }
        return {
          available: false,
          reason: "Cancel their invitation first, then you can remove them.",
        };
      }
      return live;
    }
  }
}

// --- 3. WHICH ACTIONS A ROW ACTUALLY SHOWS ----------------------------------

export type PractitionerActionItem = {
  action: PractitionerAction;
  label: string;
  destructive: boolean;
} & ActionAvailability;

export type EntryActionSurface = {
  /** The one thing this row is FOR, rendered as a full-width primary control.
   *  `null` where the row needs nothing done to it — a live invitation is
   *  waiting on the invitee, not on the studio, and inventing a primary action
   *  for it would push a practitioner to interfere with a person who is
   *  already deciding. */
  primary: PractitionerActionItem | null;
  secondary: ReadonlyArray<PractitionerActionItem>;
};

function item(
  action: PractitionerAction,
  status: WaitlistEntryStatus,
  context: AdmissionContext,
): PractitionerActionItem {
  return {
    action,
    label: PRACTITIONER_ACTION_LABEL[action],
    destructive: DESTRUCTIVE_ACTIONS.includes(action),
    ...practitionerActionAvailability(action, status, context),
  };
}

/**
 * The row's whole action surface.
 *
 * A PROJECTION, NOT A RULE SET. Which actions appear is a layout decision; each
 * one's availability came from the live model above. The two shapes worth
 * stating explicitly:
 *
 * TERMINAL ROWS SHOW NOTHING. `converted` and `removed` return an empty
 * surface. The prototype's earlier rule — always render every action, disabled,
 * with its reason, because hiding one teaches a practitioner it does not exist
 * — is right for an action that will become available later. On a closed entry
 * nothing ever will, so five greyed buttons under a person who has already
 * booked teach nothing and bury the one row that does need attention.
 *
 * A REFUSED ACTION IS STILL RENDERED where it can come back. An invitation
 * whose facts failed to load disables Cancel and says why; hiding it would tell
 * a practitioner the control does not exist on a row where it does.
 */
export function entryActionSurface(
  status: WaitlistEntryStatus,
  context: AdmissionContext = {},
): EntryActionSurface {
  if (status === "converted" || status === "removed") {
    return { primary: null, secondary: [] };
  }

  const make = (action: PractitionerAction) => item(action, status, context);

  switch (status) {
    case "waiting":
      return { primary: make("invite_to_book"), secondary: [make("remove_from_waitlist")] };

    case "claimed":
      // Reachable only from the older surface. It gets the ordinary primary
      // action plus a way back out, so a legacy hold is never a dead end.
      return {
        primary: make("invite_to_book"),
        secondary: [make("return_to_waitlist"), make("remove_from_waitlist")],
      };

    case "invited": {
      // An elapsed invitation has one next step: put them back in the queue.
      //
      // THIS SURFACE MUST MATCH `expired` EXACTLY. The bookkeeping transition
      // from `invited` to `expired` is invisible to a practitioner, so if the
      // two rows offered different actions, the moment that transition happened
      // would show as a control appearing or vanishing on its own — which is
      // the state machine leaking through the one seam this design closes.
      // An earlier revision left Resend here and not there, and said in this
      // very comment that resending into a closed window was wrong.
      //
      // It is also wrong for a second reason. Resending starts with `release`,
      // so it would stamp an invitation that RAN OUT as one the studio
      // CANCELLED, and the evidence trail would then disagree with what
      // actually happened. Return them to the waitlist and invite them again;
      // that path lets the expiry be recorded as an expiry.
      // Unknown facts fall through to the LIVE shape below, where every control
      // refuses with "could not be checked". Rendering the expired shape here
      // would hide Cancel on a row whose invitation may still be live.
      if (invitationHasRunOut(context)) {
        return {
          primary: make("return_to_waitlist"),
          secondary: [make("remove_from_waitlist")],
        };
      }
      return {
        primary: null,
        secondary: [
          make("resend_invitation"),
          make("cancel_invitation"),
          make("remove_from_waitlist"),
        ],
      };
    }

    case "expired":
    case "released":
      return {
        primary: make("return_to_waitlist"),
        secondary: [make("remove_from_waitlist")],
      };
  }
}

// --- 4. THE COMPOSER'S DRAFT -------------------------------------------------
//
// Every field below is a REQUIREMENT on B2, not decorative intent. See
// `lib/waitlist/invite-to-book-contract.ts`: the composer collects a scope, the
// adapter interface demands the invitation carry it, and an adapter that cannot
// refuses the send rather than widening it silently.

/** Booking-window presets, in the product's words. `null` days marks the
 *  custom option, which is bounded by the same validator. */
export const BOOKING_WINDOW_PRESETS: ReadonlyArray<{
  days: number;
  label: string;
}> = [
  { days: 7, label: "Next 7 days" },
  { days: 14, label: "Next 2 weeks" },
  { days: 30, label: "Next 30 days" },
];

export const WINDOW_DAYS_MIN = 1;
export const WINDOW_DAYS_MAX = 365;

export type AllowedDaysPreset = "every" | "weekdays" | "weekends" | "custom";

/**
 * The weekday sets behind the three fixed presets. `null` is every day.
 *
 * 0 = Sunday .. 6 = Saturday, matching both the contract's `allowedWeekdays`
 * and JavaScript's own `Date#getDay`, so no call site has to re-base an index.
 */
export const ALLOWED_DAYS_PRESET_VALUES: Record<
  Exclude<AllowedDaysPreset, "custom">,
  ReadonlyArray<number> | null
> = {
  every: null,
  weekdays: [1, 2, 3, 4, 5],
  weekends: [0, 6],
};

export const ALLOWED_DAYS_PRESET_LABEL: Record<AllowedDaysPreset, string> = {
  every: "Every day",
  weekdays: "Weekdays",
  weekends: "Weekends",
  custom: "Custom weekdays",
};

/**
 * The weekday toggles in READING order, which is not index order.
 *
 * A studio's week starts on Monday; the array index starts on Sunday. Rendering
 * the buttons in index order would put Sunday first, and a practitioner
 * selecting "Mon–Fri" by position would silently pick Sunday to Thursday. The
 * display order and the value travel together for exactly that reason.
 */
export const WEEKDAYS_IN_DISPLAY_ORDER: ReadonlyArray<{
  index: number;
  label: string;
}> = [
  { index: 1, label: "Mon" },
  { index: 2, label: "Tue" },
  { index: 3, label: "Wed" },
  { index: 4, label: "Thu" },
  { index: 5, label: "Fri" },
  { index: 6, label: "Sat" },
  { index: 0, label: "Sun" },
];

// The expiry bound is the shipped command's own: 1 hour .. 7 days, and out of
// range is REFUSED rather than clamped, because a clamped window is one the
// caller did not ask for and cannot see. This model refuses identically, so the
// composer never offers a value the server would have changed underneath it.
export const TTL_HOURS_MIN = 1;
export const TTL_HOURS_MAX = 168;
export const TTL_HOURS_DEFAULT = 72;

export const TTL_PRESETS: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 24, label: "24 hours" },
  { hours: 48, label: "2 days" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
];

export type InviteDraft = {
  serviceId: string | null;
  windowDays: number;
  allowedWeekdays: ReadonlyArray<number> | null;
  expiresInHours: number;
};

export function emptyDraft(): InviteDraft {
  return {
    serviceId: null,
    windowDays: BOOKING_WINDOW_PRESETS[0].days,
    allowedWeekdays: null,
    expiresInHours: TTL_HOURS_DEFAULT,
  };
}

export type DraftFieldId = "service" | "window" | "days" | "expiry";

export type DraftValidation =
  | { ok: true; scope: BookingScope; expiresInHours: number }
  | { ok: false; errors: Partial<Record<DraftFieldId, string>> };

/**
 * Validate a draft for submission.
 *
 * NO SERVICE MEANS ANY SERVICE, and that is a legitimate choice rather than a
 * missing answer — a studio that does not care which service the invitee books
 * should not have to pick one to get past this screen.
 *
 * AN EMPTY WEEKDAY SET IS NOT. `null` means every day; `[]` means no day is
 * permitted, which is an invitation that cannot be redeemed. The distinction is
 * the reason `allowedWeekdays` is nullable rather than defaulting to a full
 * array, and refusing here is what keeps a practitioner from sending a link
 * that opens onto an empty calendar.
 */
export type DraftContext = {
  /** The services the studio can actually offer right now. When supplied, a
   *  `serviceId` that is not among them invalidates the draft. */
  serviceIds?: ReadonlyArray<string>;
};

export function validateDraft(
  draft: InviteDraft,
  { serviceIds }: DraftContext = {},
): DraftValidation {
  const errors: Partial<Record<DraftFieldId, string>> = {};

  // A SERVICE THAT VANISHED IS NOT "ANY SERVICE". The composer renders the
  // chosen service by looking it up in the list; when the lookup misses — the
  // service was deleted, or the list refreshed under an open composer — the
  // summary silently read "any service" while `draftToInviteInput` still
  // forwarded the stale id. The practitioner would then confirm one scope and
  // send a different one. Refusing is the only honest option, because the two
  // readings are both wrong: sending the stale id sends something invisible,
  // and dropping it silently widens the invitation.
  if (serviceIds !== undefined && draft.serviceId !== null && !serviceIds.includes(draft.serviceId)) {
    errors.service = "That service is no longer available. Choose another, or choose any service.";
  }

  if (
    !Number.isInteger(draft.windowDays) ||
    draft.windowDays < WINDOW_DAYS_MIN ||
    draft.windowDays > WINDOW_DAYS_MAX
  ) {
    errors.window = `Choose a booking window between ${WINDOW_DAYS_MIN} and ${WINDOW_DAYS_MAX} days.`;
  }

  if (draft.allowedWeekdays !== null) {
    if (draft.allowedWeekdays.length === 0) {
      errors.days = "Choose at least one day they can book on.";
    } else if (
      draft.allowedWeekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
    ) {
      errors.days = "Unrecognised day.";
    }
  }

  if (
    !Number.isInteger(draft.expiresInHours) ||
    draft.expiresInHours < TTL_HOURS_MIN ||
    draft.expiresInHours > TTL_HOURS_MAX
  ) {
    errors.expiry = "An invitation must last between 1 hour and 7 days.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    scope: {
      serviceId: draft.serviceId,
      windowDays: draft.windowDays,
      allowedWeekdays: draft.allowedWeekdays,
    },
    expiresInHours: draft.expiresInHours,
  };
}

/**
 * The exact payload `WaitlistInvitationAdapter.inviteToBook` receives.
 *
 * Returns `null` for an invalid draft rather than throwing or coercing: the
 * composer has already rendered the field errors, and a partially-repaired
 * payload is the one thing worse than no payload.
 */
export function draftToInviteInput(
  entryId: string,
  draft: InviteDraft,
  context: DraftContext = {},
): InviteToBookInput | null {
  const validation = validateDraft(draft, context);
  if (!validation.ok) return null;
  return { entryId, scope: validation.scope, expiresInHours: validation.expiresInHours };
}

/** Plain-language summary of what the invitation will permit. Used by the
 *  composer's confirm line; it describes the SCOPE only and never claims the
 *  send has happened. */
export function scopeSummary(
  draft: InviteDraft,
  serviceName: string | null,
): string {
  const service = serviceName ? serviceName : "any service";
  const window =
    BOOKING_WINDOW_PRESETS.find((p) => p.days === draft.windowDays)?.label ??
    `next ${draft.windowDays} days`;
  const days =
    draft.allowedWeekdays === null
      ? "any day"
      : WEEKDAYS_IN_DISPLAY_ORDER.filter((d) =>
          draft.allowedWeekdays?.includes(d.index),
        )
          .map((d) => d.label)
          .join(", ");
  return `${service}, ${window.toLowerCase()}, ${days}`;
}

// --- 5. WIRING STATE, WHICH IS NOT THE SAME AS ELIGIBILITY ------------------
//
// TWO INDEPENDENT REASONS A CONTROL IS OFF, AND THEY MUST NOT BE MERGED.
//
//   "You cannot cancel an invitation that has already been used"   — eligibility
//   "Cancelling is not connected yet"                              — wiring
//
// The earlier prototype applied ONE sentence — "Sending is not available in
// this release yet." — to every unwired control, including Claim, Release,
// Requeue and Remove, none of which send anything. A waiting row explained its
// disabled Remove button with a sentence about sending. That is the same
// conflation this project rejected when a failed read was reported as a
// question nobody asked: a control disabled for a reason describing some other
// control teaches a practitioner to stop reading the reasons.
//
// So wiring copy NAMES THE ACTION IT IS ATTACHED TO — `adapterMissingReason`
// takes the label — and eligibility copy is never overwritten by it. An action
// the entry's own state forbids keeps its own explanation whether an adapter is
// bound or not; wiring only ever downgrades an action that WOULD have been
// available.

/**
 * The adapter capability each action depends on.
 *
 * `invite_to_book` maps to `enforcesScope` because this composer always sends a
 * scope. An adapter that can issue an invitation but cannot carry the service
 * and booking window the practitioner just chose would produce an invitation
 * that ignores both, which the invitee then books outside of. There is no
 * "send it unscoped" fallback on purpose.
 */
export const ACTION_CAPABILITIES: Record<
  PractitionerAction,
  ReadonlyArray<keyof AdapterCapabilities>
> = {
  // Both sending actions carry a scope, so both need an adapter that enforces
  // one. `resendInvitation` takes a scope for the same reason `inviteToBook`
  // does — it mints a NEW invitation rather than re-delivering the old one, and
  // the contract forbids silently dropping what the practitioner chose. An
  // earlier revision gated resend on `canResend` alone, so an adapter reporting
  // `{ canResend: true, enforcesScope: false }` — a combination the contract
  // explicitly permits as an intermediate state — would have advertised a
  // resend it could not honour as written.
  // OPENS THE COMPOSER; IT DOES NOT SEND. It needs an adapter to exist — there
  // is no point opening a form nothing can submit — but NOT scope enforcement,
  // because no scope has been written yet. Gating the opener on `enforcesScope`
  // made the composer's own supported half-wired state unreachable: the form is
  // meant to stay visible with only Send disabled, and an opener that refuses
  // first means nobody ever sees it. Scope is gated at `sendState`, which is
  // the control that actually carries one.
  invite_to_book: [],
  resend_invitation: ["canResend", "enforcesScope"],
  cancel_invitation: ["canCancel"],
  return_to_waitlist: ["canReturnToWaitlist"],
  remove_from_waitlist: ["canRemove"],
};

export type ControlState = {
  disabled: boolean;
  /** The one sentence rendered beside the control, or `null` when it is
   *  available and connected. Eligibility wins over wiring: a control the
   *  entry's state forbids keeps its own reason. */
  reason: string | null;
};

/**
 * Whether a control may be pressed, and what to say when it may not.
 *
 * `capabilities` is `null` while no adapter is bound, which is the state this
 * whole prototype renders in today — there is no stub adapter anywhere in the
 * repository, so there is nothing to accidentally wire to.
 */
export function controlState(
  item: PractitionerActionItem,
  capabilities: AdapterCapabilities | null,
): ControlState {
  // ELIGIBILITY FIRST. "They have already booked" stays true whether or not the
  // invitation service exists, and it is the more useful sentence of the two.
  if (!item.available) return { disabled: true, reason: item.reason };
  if (capabilities === null) {
    return { disabled: true, reason: adapterMissingReason(item.label) };
  }
  const missing = ACTION_CAPABILITIES[item.action].filter((c) => !capabilities[c]);
  if (missing.length > 0) {
    // NAME THE ACTUAL GAP. An adapter that exists but cannot carry a service or
    // booking window is a different problem from no adapter at all, and the
    // practitioner can do something about only one of them.
    return {
      disabled: true,
      reason: missing.includes("enforcesScope")
        ? SCOPE_UNSUPPORTED_REASON
        : adapterMissingReason(item.label),
    };
  }
  return { disabled: false, reason: null };
}

/** True once an adapter can carry everything this surface sends. The composer
 *  keys its send control off this, and the test file asserts it is false for
 *  the only value that exists today. */
export function readyToBind(capabilities: AdapterCapabilities | null): boolean {
  return capabilities !== null && capabilities.enforcesScope;
}

// --- 6. WHICH PRESET IS SELECTED — DERIVED, NEVER STORED --------------------
//
// The composer holds ONE value per question, and which preset button reads as
// pressed is computed from it. A stored "selected preset" field beside a stored
// value is two facts that can disagree, and the disagreement is invisible until
// a practitioner sees "Weekdays" highlighted above a set that is not the
// weekdays. Deriving costs a comparison and removes the failure entirely.

export type BookingWindowSelection = number | "custom";

export function activeWindowPreset(windowDays: number): BookingWindowSelection {
  return BOOKING_WINDOW_PRESETS.some((p) => p.days === windowDays) ? windowDays : "custom";
}

function sameDaySet(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((d) => left.has(d)) && left.size === b.length;
}

export function activeAllowedDaysPreset(
  weekdays: ReadonlyArray<number> | null,
): AllowedDaysPreset {
  if (weekdays === null) return "every";
  if (sameDaySet(weekdays, ALLOWED_DAYS_PRESET_VALUES.weekdays!)) return "weekdays";
  if (sameDaySet(weekdays, ALLOWED_DAYS_PRESET_VALUES.weekends!)) return "weekends";
  return "custom";
}

export function activeTtlPreset(hours: number): number | "custom" {
  return TTL_PRESETS.some((p) => p.hours === hours) ? hours : "custom";
}

// --- 7. WHETHER THE COMPOSER MAY SEND ---------------------------------------

/**
 * The send control's state, decided here rather than in the component.
 *
 * THREE DISTINCT REASONS, IN THE ORDER A PRACTITIONER CAN ACT ON THEM. A field
 * they can fix comes first; a capability the studio's service lacks comes
 * second; "not built yet" comes last. Reporting the unbuildable one over a
 * typo'd number would leave a fixable draft looking permanently broken.
 */
export function sendState(
  draft: InviteDraft,
  capabilities: AdapterCapabilities | null,
  context: DraftContext = {},
): ControlState {
  const validation = validateDraft(draft, context);
  if (!validation.ok) {
    return { disabled: true, reason: "Fix the highlighted fields before sending." };
  }
  if (capabilities === null) {
    return {
      disabled: true,
      reason: adapterMissingReason(PRACTITIONER_ACTION_LABEL.invite_to_book),
    };
  }
  if (!capabilities.enforcesScope) {
    return { disabled: true, reason: SCOPE_UNSUPPORTED_REASON };
  }
  return { disabled: false, reason: null };
}
