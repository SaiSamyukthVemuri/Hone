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
export type OfferedDay = {
  /** YYYY-MM-DD in the studio's timezone. */
  date: string;
  /** "Mon, Sep 7" -- the shared formatter, not a local one. */
  dateLabel: string;
  slots: readonly OfferedSlot[];
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
export type RecoverableProofFailure = Exclude<
  CompleteProofOutcome["kind"],
  "verified" | "unavailable" | "invalid_token" | "not_live"
>;

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
      invitation: ResolvedInvitation;
      presentation: OfferPresentation;
      /** Flat, still narrowed, for callers that want the raw list. */
      slots: readonly OfferedSlot[];
      /** The same slots, grouped under their studio-local day. */
      days: readonly OfferedDay[];
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
    .map(([date, daySlots]) => ({
      date,
      dateLabel: formatSlotDayLabel(date),
      slots: [...daySlots].sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : 0)),
    }));
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
        invitation: resolve.invitation,
        presentation: ctx.presentation,
        slots,
        days: groupSlotsByDay(ctx.presentation.studioTimezone, slots),
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
  if (outcome.kind === "verified") return { kind: "proven" };
  if (outcome.kind === "unavailable") return { kind: "unavailable", retryable: true };

  // TERMINAL OUTCOMES ARE TERMINAL. If the invitation expired, was released or
  // was redeemed between the code being issued and submitted, B2 answers
  // `not_live` -- and `invalid_token` is likewise a dead end. A catch-all
  // `failed` sent both to the code form, which then said "no longer available"
  // above a live Confirm and a live Resend. That is the same defect the resolve
  // union was made exhaustive to prevent, left in the proof mapping.
  if (outcome.kind === "not_live" || outcome.kind === "invalid_token") {
    return { kind: "unavailable", retryable: false };
  }

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
