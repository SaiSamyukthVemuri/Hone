import { localDateString, localDayOfWeek, formatLocalDateLabel } from "@/lib/booking/tz";
import {
  evaluateInvitationScope,
  type InvitationScope,
} from "@/lib/booking/waitlist-invitation-scope";
import type {
  BeginProofOutcome,
  CompleteProofOutcome,
  DeclineOutcome,
  RedeemOutcome,
  ResolveOutcome,
  ResolvedInvitation,
} from "@/lib/booking/waitlist-invitation";

// WAIT-03 B3 — the RECIPIENT's view of an invitation, bound to B2's authority.
//
// PRESENTATION AND STATE ONLY. Nothing here authorizes anything: B1.5c owns
// recipient proof, B2 owns server authority, and this module turns B2's
// outcomes into something a phone can render.
//
// WHAT BINDING CHANGED, AND IT MATTERED
// The pure slice modelled the offer window itself, and got the weekday
// semantics BACKWARDS: it treated an empty `allowedWeekdays` as "every day".
// B1's canonical rule -- `evaluateInvitationScope`, and the CHECK behind it --
// is the opposite: NULL means every day inside the range, and an EMPTY ARRAY
// authorises NOTHING and fails closed as `unreadable_scope`. An offer carrying
// `[]` would have rendered every day to the recipient while the server refused
// all of them.
//
// So B3 no longer decides. `slotWithinScope` calls B2's evaluator, with the
// same studio-local projection, so the screen and the server reach their
// verdict through ONE function. There is no second window engine and no second
// weekday convention -- the numbering is `extract(dow)` because that is what
// B1 stores, and this file never restates it.

/** A bookable time produced by the existing availability engine. */
export type OfferedSlot = {
  /** ISO instant. */
  start: string;
  /** ISO instant. */
  end: string;
  /** Pre-formatted for the studio's timezone and time format by the caller. */
  startLabel: string;
};

/** Everything the screen needs that is not the invitation itself. */
export type OfferPresentation = {
  studioName: string;
  serviceName: string;
  serviceDurationMinutes: number;
  studioTimezone: string;
};

/** Where the recipient is in the proof exchange. B1.5c's shape, not a new one. */
export type ProofStage =
  | { kind: "required" }
  | { kind: "requesting" }
  | { kind: "sent"; maskedContact: string; expiresAt: string }
  | { kind: "verifying" }
  | { kind: "failed"; reason: CompleteProofOutcome["kind"]; maskedContact: string; expiresAt: string }
  | { kind: "unavailable"; retryable: boolean }
  | { kind: "proven" };

export type InvitationClosedReason =
  | "expired"
  | "revoked"
  | "already_redeemed"
  | "declined";

export type InvitationViewState =
  | { kind: "loading" }
  | {
      kind: "proof";
      presentation: OfferPresentation;
      windowDescription: string;
      stage: ProofStage;
    }
  | {
      kind: "offer";
      invitation: ResolvedInvitation;
      presentation: OfferPresentation;
      slots: readonly OfferedSlot[];
      windowDescription: string;
      empty: boolean;
    }
  | { kind: "closed"; reason: InvitationClosedReason; presentation: OfferPresentation | null }
  | { kind: "booked"; presentation: OfferPresentation; startLabel: string; dateLabel: string }
  | { kind: "declined" }
  | { kind: "error"; retryable: boolean };

/**
 * Does this slot fall inside the offer?
 *
 * Delegates to B2's `evaluateInvitationScope` rather than re-deriving the
 * rule. The server is the authority and refuses out-of-scope bookings itself;
 * this is the second narrowing, and it is the SAME function, so the two cannot
 * disagree about a null weekday list, an empty one, or a studio east of UTC.
 */
export function slotWithinScope(
  scope: InvitationScope,
  studioTimezone: string,
  slot: OfferedSlot,
): boolean {
  const startsAt = new Date(slot.start);
  if (Number.isNaN(startsAt.getTime())) return false;
  const decision = evaluateInvitationScope({
    scope,
    requestedServiceId: scope.serviceId,
    requestedStartsAt: startsAt,
    studioTimezone,
    localDateString,
    localDayOfWeek,
  });
  return decision.ok;
}

/** Drop every slot the offer does not cover, by B2's own verdict. */
export function filterSlotsToScope(
  scope: InvitationScope,
  studioTimezone: string,
  slots: readonly OfferedSlot[],
): OfferedSlot[] {
  return slots.filter((s) => slotWithinScope(scope, studioTimezone, s));
}

/** `extract(dow)` order, as B1 stores it. Index is the stored value, not a choice. */
const WEEKDAY_LABELS: Record<number, string> = {
  0: "Sundays",
  1: "Mondays",
  2: "Tuesdays",
  3: "Wednesdays",
  4: "Thursdays",
  5: "Fridays",
  6: "Saturdays",
};

/**
 * The offered horizon in words, so a recipient never has to infer what they
 * were offered from which buttons happen to exist.
 *
 * NULL weekdays means every day in the range; an EMPTY list authorises nothing
 * and says so, rather than quietly reading as "unrestricted".
 */
export function describeScopeWindow(scope: InvitationScope): string {
  const from = formatLocalDateLabel(scope.startDate);
  const to = formatLocalDateLabel(scope.endDate);
  const span = from === to ? from : `${from} – ${to}`;

  const weekdays = scope.allowedWeekdays;
  if (weekdays === null || weekdays === undefined) return span;
  if (weekdays.length === 0) return "No days are currently offered";

  const named = [...weekdays]
    .sort((a, b) => a - b)
    .map((d) => WEEKDAY_LABELS[d])
    .filter((label): label is string => typeof label === "string");
  if (named.length === 0) return span;
  return `${named.join(", ")}, ${span}`;
}

/** What the container has resolved so far. `null` means still loading. */
export type RecipientContext = {
  resolve: ResolveOutcome | null;
  presentation: OfferPresentation | null;
  /** B1.5c proof progress. `proven` is what unlocks the slot list. */
  proof: ProofStage;
  slots: readonly OfferedSlot[];
  /** Set once a redeem has succeeded. */
  booked: { startLabel: string; dateLabel: string } | null;
  /** Set once a decline has succeeded. */
  declined: boolean;
};

/**
 * The whole screen decision, in one total function over B2's outcomes.
 *
 * The ORDER matters: a completed booking or decline outranks the resolve
 * verdict, because the resolve that follows a successful redeem legitimately
 * reports `already_redeemed`, and showing the recipient a dead end after they
 * just booked would be a lie.
 */
export function deriveInvitationViewState(ctx: RecipientContext): InvitationViewState {
  if (ctx.declined) return { kind: "declined" };
  if (ctx.booked && ctx.presentation) {
    return {
      kind: "booked",
      presentation: ctx.presentation,
      startLabel: ctx.booked.startLabel,
      dateLabel: ctx.booked.dateLabel,
    };
  }

  const resolve = ctx.resolve;
  if (resolve === null) return { kind: "loading" };

  switch (resolve.kind) {
    case "expired":
      return { kind: "closed", reason: "expired", presentation: ctx.presentation };
    case "released":
      // B2's wire word for a withdrawn offer.
      return { kind: "closed", reason: "revoked", presentation: ctx.presentation };
    case "already_redeemed":
      return { kind: "closed", reason: "already_redeemed", presentation: ctx.presentation };
    case "declined":
      return { kind: "closed", reason: "declined", presentation: ctx.presentation };
    case "invalid_token":
    case "unscoped":
      // ONE answer for both. Telling them apart would confirm to a bearer that
      // a token exists.
      return { kind: "error", retryable: false };
    case "unavailable":
      return { kind: "error", retryable: true };
    case "live": {
      if (!ctx.presentation) return { kind: "loading" };
      const scope = resolve.invitation.scope;
      const windowDescription = describeScopeWindow(scope);

      // POSSESSION SHOWS THE OFFER; PROOF UNLOCKS THE TIMES. Until B1.5c has
      // minted a capability there is no slot list to render, so a forwarded
      // link reveals what was offered and nothing bookable.
      if (ctx.proof.kind !== "proven") {
        return {
          kind: "proof",
          presentation: ctx.presentation,
          windowDescription,
          stage: ctx.proof,
        };
      }

      const slots = filterSlotsToScope(scope, ctx.presentation.studioTimezone, ctx.slots);
      return {
        kind: "offer",
        invitation: resolve.invitation,
        presentation: ctx.presentation,
        slots,
        windowDescription,
        empty: slots.length === 0,
      };
    }
  }
}

/** Map B2's begin-proof outcome onto the stage the screen renders. */
export function proofStageFromBegin(outcome: BeginProofOutcome): ProofStage {
  switch (outcome.kind) {
    case "challenge_issued":
      return { kind: "sent", maskedContact: outcome.maskedContact, expiresAt: outcome.expiresAt };
    case "unavailable":
      return { kind: "unavailable", retryable: true };
    default:
      // invalid_token, not_live, invalid_input: nothing the recipient can retry
      // into, and none of them says which.
      return { kind: "unavailable", retryable: false };
  }
}

/** Map B2's complete-proof outcome onto the stage the screen renders. */
export function proofStageFromComplete(
  outcome: CompleteProofOutcome,
  previous: { maskedContact: string; expiresAt: string },
): ProofStage {
  if (outcome.kind === "verified") return { kind: "proven" };
  if (outcome.kind === "unavailable") return { kind: "unavailable", retryable: true };
  return { kind: "failed", reason: outcome.kind, ...previous };
}

/**
 * Whether a redeem or decline outcome means the recipient's proof has lapsed
 * and the exchange must restart.
 *
 * `proof_required`, `proof_expired` and `proof_invalid` are all recoverable by
 * requesting a new code -- they are not dead ends, and must not be rendered as
 * ones.
 */
export function isProofLapse(
  outcome: RedeemOutcome | DeclineOutcome,
): outcome is Extract<RedeemOutcome, { kind: "proof_required" | "proof_expired" | "proof_invalid" }> {
  return (
    outcome.kind === "proof_required" ||
    outcome.kind === "proof_expired" ||
    outcome.kind === "proof_invalid"
  );
}
