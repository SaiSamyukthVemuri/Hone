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

/**
 * Slots for ONE studio-local day, with that day named.
 *
 * WHY THE GROUPING EXISTS. An offer may span several days -- "Mondays and
 * Wednesdays" is the ordinary shape -- and a bare list of times renders Monday
 * 9:00 and Wednesday 9:00 as two identical buttons. The recipient cannot tell
 * them apart and can book the wrong day. The window description gives the
 * RANGE; it cannot disambiguate an individual button, so the day travels with
 * the slots rather than being left to the header.
 */
/**
 * At least one slot. A day with none is not a day worth rendering.
 *
 * `readonly OfferedSlot[]` let `days: [{ slots: [] }]` typecheck, which made
 * `days.length` nonzero while nothing was bookable -- so the view showed
 * "Choose a time" with nothing under it, a Book control, and no "Check again"
 * recovery path. Collapsing the old `empty` flag into `days.length` did not
 * remove that contradiction, it relocated it one level down. A non-empty tuple
 * removes it: the illegal state cannot be written.
 */
export type NonEmptySlots = readonly [OfferedSlot, ...OfferedSlot[]];

export type OfferedDay = {
  /** YYYY-MM-DD in the studio's timezone. */
  date: string;
  /** "Mon, Sep 7" -- the shared formatter, not a local one. */
  dateLabel: string;
  slots: NonEmptySlots;
};

/** Everything the screen needs that is not the invitation itself. */
export type OfferPresentation = {
  studioName: string;
  serviceName: string;
  serviceDurationMinutes: number;
  studioTimezone: string;
};

/**
 * The proof failures a recipient can actually recover from.
 *
 * AN EXPLICIT CLOSED LIST, NOT AN `Exclude`. The subset was derived by removing
 * the terminal kinds -- which meant a NEW terminal outcome (a revocation, say)
 * would have been recoverable BY DEFAULT and rendered above live Confirm and
 * Resend, recreating the exact failure the subset was introduced to prevent.
 * Excluding gets the default wrong; enumerating makes every future authority
 * result state its own case, and the exhaustive mapper below forces that
 * decision at compile time.
 *
 * NARROWING THE TYPE, NOT THE MAPPER. `proofStageFromComplete` already sent
 * `not_live` and `invalid_token` to a dead end -- but `failed.reason` was typed
 * as the whole of `CompleteProofOutcome["kind"]`, so a type-correct
 * `InvitationViewState` could still carry `{ kind: "failed", reason:
 * "not_live" }` and render the terminal message above live Confirm and Resend.
 * `verified` and `unavailable` were expressible too, and would have rendered
 * the form with no explanation at all.
 *
 * That is the third time this shape has appeared here: the construction site
 * was fixed and the exported type left able to express the broken state. A
 * subset type ends it -- the combinations cannot be built, and the copy map
 * below cannot omit one.
 */
export type RecoverableProofFailure =
  | "wrong_challenge"
  | "no_challenge"
  | "challenge_expired"
  | "too_many_attempts"
  | "recipient_changed"
  | "invalid_input";

/** Where the recipient is in the proof exchange. B1.5c's shape, not a new one. */
export type ProofStage =
  | { kind: "required" }
  | { kind: "requesting" }
  | { kind: "sent"; maskedContact: string; expiresAt: string }
  /**
   * A submitted code is being checked. Carries the same context as `sent` so
   * the screen can keep showing WHAT was submitted and to which address --
   * blanking the field mid-verification loses the recipient's place.
   */
  | { kind: "verifying"; maskedContact: string; expiresAt: string; submittedCode: string }
  | {
      kind: "failed";
      reason: RecoverableProofFailure;
      maskedContact: string;
      expiresAt: string;
    }
  | { kind: "unavailable"; retryable: boolean }
  | { kind: "proven" };

/**
 * The stages the PROOF VIEW may be asked to render.
 *
 * `proven` is excluded by TYPE rather than handled as an unreachable no-op.
 * `deriveInvitationViewState` returns the offer state once proof lands, so the
 * combination never arises here today -- but the component is exported, and a
 * container updating the stage directly could hand it `proven` and get a header
 * with no times and no controls, with no type error to stop it. "Unreachable by
 * construction" is a comment; this is a compiler.
 */
export type UnprovenProofStage = Exclude<ProofStage, { kind: "proven" }>;

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
      stage: UnprovenProofStage;
    }
  | {
      kind: "offer";
      /*
       * NO INVITATION FIELD AT ALL, and that is the fix rather than a narrower
       * type.
       *
       * This first carried B2's whole `ResolvedInvitation` into a `"use client"`
       * component -- shipping `recipientContactHash` (a hash of the recipient's
       * email, susceptible to offline guessing and documented by the authority
       * layer as server-side), plus `entryId` and `studioId`, to the browser.
       * Narrowing the property to a projection did NOT close that: TypeScript's
       * structural assignability lets a caller assign a `ResolvedInvitation`
       * variable straight into a narrower slot -- excess-property checking only
       * applies to object literals -- and React then serialises the runtime
       * object with every key intact. The type looked like a boundary and was
       * not one.
       *
       * The screen reads no invitation field. A property that does not exist
       * cannot leak, whatever a caller assigns.
       */
      presentation: OfferPresentation;
      /**
       * The narrowed slots, grouped under their studio-local day.
       *
       * THE ONLY COLLECTION, AND THE ONLY SOURCE OF EMPTINESS. This carried a
       * flat `slots` list and a separate `empty` boolean beside it, so the type
       * admitted `empty: true` with populated days -- hiding real availability
       * -- and `empty: false` with none, an empty "Choose a time" with no retry
       * path. The view branched on the flag and rendered from the collection,
       * so the two could disagree. Emptiness is now `days.length === 0`: a fact
       * about what is rendered, not a claim travelling beside it.
       */
      days: readonly OfferedDay[];
      windowDescription: string;
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

/**
 * Group narrowed slots under their studio-local day, in chronological order.
 *
 * The date comes from `localDateString` and the label from
 * `formatLocalDateLabel` -- the same shared helpers the rest of booking uses.
 * A slot whose instant cannot be read is dropped rather than filed under a
 * guessed day; it would already have failed the scope check.
 */
export function groupSlotsByDay(
  studioTimezone: string,
  slots: readonly OfferedSlot[],
): OfferedDay[] {
  const byDate = new Map<string, OfferedSlot[]>();
  for (const slot of slots) {
    const at = new Date(slot.start);
    if (Number.isNaN(at.getTime())) continue;
    const date = localDateString(at, studioTimezone);
    const bucket = byDate.get(date);
    if (bucket) bucket.push(slot);
    else byDate.set(date, [slot]);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([date, daySlots]) => {
      const sorted = [...daySlots].sort((x, y) =>
        x.start < y.start ? -1 : x.start > y.start ? 1 : 0,
      );
      const [first, ...rest] = sorted;
      // A bucket only exists because a slot created it, so this cannot happen.
      // Dropping rather than asserting keeps the non-empty guarantee true by
      // construction instead of by claim.
      if (!first) return [];
      return [{ date, dateLabel: formatSlotDayLabel(date), slots: [first, ...rest] as NonEmptySlots }];
    });
}

/** "Mon, Sep 7" -- short enough for a phone, unambiguous across a week. */
function formatSlotDayLabel(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);
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
          // Narrowed by the guard above; the type now says so too.
          stage: ctx.proof,
        };
      }

      const slots = filterSlotsToScope(scope, ctx.presentation.studioTimezone, ctx.slots);
      return {
        kind: "offer",
        presentation: ctx.presentation,
        days: groupSlotsByDay(ctx.presentation.studioTimezone, slots),
        windowDescription,
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
    // Enumerated rather than defaulted. A catch-all here would classify the
    // NEXT authority result -- a throttle, a transport status -- as a terminal
    // refusal and disable every control, while typechecking perfectly. Each new
    // outcome must make its own retryability decision.
    case "invalid_token":
    case "not_live":
    case "invalid_input":
      // Nothing the recipient can retry into, and none of them says which.
      return { kind: "unavailable", retryable: false };
    default:
      return assertNeverBeginOutcome(outcome);
  }
}

/** Compile-time exhaustiveness over B2's begin-proof outcomes. */
function assertNeverBeginOutcome(outcome: never): ProofStage {
  void outcome;
  // Unreachable; fails closed rather than granting anything if it ever is.
  return { kind: "unavailable", retryable: false };
}

/** Map B2's complete-proof outcome onto the stage the screen renders. */
export function proofStageFromComplete(
  outcome: CompleteProofOutcome,
  previous: { maskedContact: string; expiresAt: string },
): ProofStage {
  switch (outcome.kind) {
    case "verified":
      return { kind: "proven" };
    case "unavailable":
      return { kind: "unavailable", retryable: true };

    // TERMINAL. If the invitation expired, was released or was redeemed between
    // the code being issued and submitted, B2 answers `not_live`; an
    // `invalid_token` is likewise a dead end. Rendering either on the code form
    // showed "no longer available" above a live Confirm and a live Resend.
    case "not_live":
    case "invalid_token":
      return { kind: "unavailable", retryable: false };

    // RECOVERABLE. Each one names itself, so a new authority result cannot join
    // this set by omission.
    case "wrong_challenge":
    case "no_challenge":
    case "challenge_expired":
    case "too_many_attempts":
    case "recipient_changed":
    case "invalid_input":
      return { kind: "failed", reason: outcome.kind, ...previous };

    default:
      return assertNeverCompleteOutcome(outcome);
  }
}

/** Compile-time exhaustiveness over B2's complete-proof outcomes. */
function assertNeverCompleteOutcome(outcome: never): ProofStage {
  void outcome;
  // Unreachable; fails closed rather than offering a retry it cannot justify.
  return { kind: "unavailable", retryable: false };
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
