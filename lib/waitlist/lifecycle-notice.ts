// The lifecycle refusals that mean "the row moved since this page was drawn".
//
// A stale page, a second tab or a double click all end the same way: the command
// is asked to move an entry that is no longer where the button assumed, and it
// answers with a refusal code instead of moving anything. That is not a fault,
// so the action sends the owner back to the list with a notice rather than
// throwing into the app error boundary (which, by design, never shows a message).
//
// THE COPY LIVES HERE AND NOWHERE ELSE. The action's refusal maps read these
// strings, and the page renders only a string found in this table. The notice
// travels in a short-lived httpOnly FLASH COOKIE set by the action, as a KEY
// (`release.not_releasable`), never as text. A URL parameter is not read at all, so a
// crafted or bookmarked link cannot show a banner the owner's own action did not
// produce. The page looks the key up by exact own-property match: whatever the cookie
// holds either names one fixed sentence below or renders nothing. Nothing is echoed.

export const STALE_STATE_NOTICES = {
  "claim.not_found": "That waitlist entry no longer exists.",
  "claim.not_waiting": "That entry is no longer waiting, so it cannot be claimed.",
  "release.already_redeemed": "That invitation has already been used. It cannot be released.",
  "release.not_releasable": "Only a claimed or invited entry can be released.",
  "expire.already_redeemed": "That invitation has already been used.",
  "expire.not_invited": "There is no live invitation on that entry.",
  "expire.not_expired": "That invitation has not run out yet. Release it instead to take it back.",
  "requeue.already_active": "That person is already on the waitlist again under the same email.",
  "requeue.not_requeueable": "Only a released or expired entry can be returned to the queue.",
  "requeue.already_redeemed":
    "They already used an invitation, so this entry cannot go back on the waitlist. Remove it — they can join again themselves.",
  "close.not_found": "That waitlist entry no longer exists.",
  "close.not_invited": "There is no used invitation on that entry to close.",
  "close.not_redeemed": "That invitation has not been used yet. Cancel it instead to end it early.",
  "close.already_booked": "They have already booked, so there is nothing to close.",
  "close.already_closed": "That invitation has already been closed.",
  "remove.not_found": "That waitlist entry no longer exists.",
  "remove.already_removed": "That entry has already been removed.",
  "remove.release_required": "That entry has been claimed or invited. Release it before removing it.",
  "remove.not_removable": "That person is already a client. Converted entries stay in waitlist history.",
} as const;

/** Outcomes that are not refusals: the move happened, or its result could not be confirmed. */
export const OUTCOME_NOTICES = {
  "remove.removed": "Removed from the waitlist.",
  "remove.unconfirmed":
    "We could not confirm whether that entry was removed. Check the list before trying again.",
} as const;

export type LifecycleNoticeTone = "refusal" | "success" | "unconfirmed";
export type LifecycleNotice = { tone: LifecycleNoticeTone; text: string };

export type LifecycleNoticeKey = keyof typeof STALE_STATE_NOTICES;

export type LifecycleNoticeAction = "claim" | "release" | "expire" | "requeue" | "close" | "remove";

export type OutcomeNoticeKey = keyof typeof OUTCOME_NOTICES;

/** The flash cookie the action sets and the page reads. Scoped to the waitlist page, httpOnly, 5 s. */
export const LIFECYCLE_NOTICE_COOKIE = "hone_waitlist_notice";
export const LIFECYCLE_NOTICE_MAX_AGE_SECONDS = 5;

function isNoticeKey(value: unknown): value is LifecycleNoticeKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(STALE_STATE_NOTICES, value);
}

/** The key for an action's refusal code, or null when that code is not a stale-state one. */
export function lifecycleNoticeKey(action: LifecycleNoticeAction, code: string): LifecycleNoticeKey | null {
  const key = `${action}.${code}`;
  return isNoticeKey(key) ? key : null;
}

function isOutcomeKey(value: unknown): value is OutcomeNoticeKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(OUTCOME_NOTICES, value);
}

/** The fixed sentence for a browser-supplied value, or null. Never returns the value itself. */
export function lifecycleNoticeCopy(param: unknown): LifecycleNotice | null {
  if (isNoticeKey(param)) return { tone: "refusal", text: STALE_STATE_NOTICES[param] };
  if (isOutcomeKey(param)) {
    return { tone: param === "remove.removed" ? "success" : "unconfirmed", text: OUTCOME_NOTICES[param] };
  }
  return null;
}
