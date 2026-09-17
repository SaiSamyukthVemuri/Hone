/**
 * INVITATION CAPACITY — the practitioner's word for the admission round.
 *
 * The database calls this a `studio_waitlist_admission_round`, and that term
 * must never reach a practitioner: it describes the mechanism, not the decision.
 * The decision is "how many new clients am I ready to invite right now", and
 * this module is the one place the two vocabularies meet.
 *
 * THE DATABASE REMAINS THE AUTHORITY. Nothing here decides whether an
 * invitation may be sent; 0192 owns the open-round rule and 0193 refuses
 * without one. What this module provides is the view model and the words, so
 * the surface can stop offering an action the command will refuse.
 */

/** A capacity the owner has opened and not yet closed. */
export type OpenCapacity = {
  roundId: string;
  /** How many invitations the owner said they were ready to send. */
  allowance: number;
  /** How many of them have been used, per the database's own count. */
  used: number;
  openedAt: string;
};

export type InvitationCapacity =
  | { state: "open"; capacity: OpenCapacity }
  | { state: "none" }
  /** The capacity could not be read. Treated as "cannot invite", never as open. */
  | { state: "unknown" };

/** Remaining invitations, never negative even if the count outruns the allowance. */
export function remaining(capacity: OpenCapacity): number {
  return Math.max(0, capacity.allowance - capacity.used);
}

export function isExhausted(capacity: OpenCapacity): boolean {
  return remaining(capacity) === 0;
}

/**
 * May the surface OFFER a send?
 *
 * USABILITY, NOT AUTHORIZATION. A false here hides a control the database would
 * refuse anyway; a true here promises nothing. The command re-derives every
 * condition, and a race that closes the capacity between render and press is
 * still refused by the database — which is why the refusal copy below exists.
 */
export function canOfferInvite(capacity: InvitationCapacity): boolean {
  return capacity.state === "open" && !isExhausted(capacity.capacity);
}

/** Why the send is unavailable, in the practitioner's language. */
export function inviteUnavailableReason(capacity: InvitationCapacity): string | null {
  if (capacity.state === "none") {
    return "Set your invitation capacity before inviting someone to book.";
  }
  if (capacity.state === "unknown") {
    return "We couldn't check your invitation capacity just now. Reload the page before inviting.";
  }
  if (isExhausted(capacity.capacity)) {
    return CAPACITY_EXHAUSTED_COPY;
  }
  return null;
}

/** Shown when the allowance is spent. Names the next step, which is a DECISION
 *  the owner makes — never an automatic new capacity. */
export const CAPACITY_EXHAUSTED_COPY =
  "You've used all invitations in this batch. Start a new invitation capacity when you're ready to invite more people.";

/** The panel's own copy, so the page and its tests cannot drift. */
export const CAPACITY_PANEL = {
  title: "Invitation capacity",
  emptyBody:
    "Set how many new clients you're ready to invite before sending invitations.",
  startLabel: "Start inviting",
  closeLabel: "Close invitations",
  allowanceLabel: "How many new clients are you ready to invite right now?",
} as const;

/** "X of Y used" — the only place this sentence is built. */
export function usageLabel(capacity: OpenCapacity): string {
  return `${capacity.used} of ${capacity.allowance} used`;
}

export function remainingLabel(capacity: OpenCapacity): string {
  const left = remaining(capacity);
  return `${left} ${left === 1 ? "invitation" : "invitations"} remaining`;
}

/** The allowance an owner may choose. A positive integer, explicitly given. */
export const ALLOWANCE_MIN = 1;
export const ALLOWANCE_MAX = 100;

export type AllowanceParse =
  | { ok: true; allowance: number }
  | { ok: false; reason: string };

/**
 * Read the allowance the owner typed.
 *
 * NO DEFAULT, EVER. An unreadable or absent value is a refusal, not a guess:
 * inventing a live allowance is exactly the "second capacity engine" this
 * feature must not become, and it would open a real capacity nobody chose.
 */
export function parseAllowance(raw: unknown): AllowanceParse {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "Enter how many new clients you're ready to invite." };
  }
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < ALLOWANCE_MIN || n > ALLOWANCE_MAX) {
    return {
      ok: false,
      reason: `Enter a whole number between ${ALLOWANCE_MIN} and ${ALLOWANCE_MAX}.`,
    };
  }
  return { ok: true, allowance: n };
}
