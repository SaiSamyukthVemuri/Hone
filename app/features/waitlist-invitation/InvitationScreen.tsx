"use client";

import type {
  BookingRefusal,
  ProofNotice,
  InvitationClosedReason,
  InvitationViewState,
  OfferedDay,
  OfferedSlot,
  OfferPresentation,
  RecoverableProofFailure,
  UnprovenProofStage,
} from "@/lib/waitlist/invitation-offer";
import { CONTROL_MIN_TOUCH, FOCUS_RING } from "@/components/ui/control-base";

// WAIT-03 B3 — the recipient's invitation screen. PRESENTATION ONLY.
//
// NO SERVER ACTION IS IMPORTED OR DEFINED HERE, and that is a requirement
// rather than an omission: possession of the invitation URL must never perform
// a mutation, so this component cannot reach one. Booking and declining are
// CALLBACKS the eventual B2-owned container supplies, once its authority
// interface is frozen. A source guard pins that.
//
// MOBILE FIRST, LITERALLY
// The recipient is on a phone, opening a link from an email, probably
// one-handed. So: a single column at every width, full-width primary controls,
// 44px minimum touch targets from the shared primitive, no horizontal scroll,
// and the decline action deliberately NOT adjacent to book -- a mis-tap that
// declines an offer is unrecoverable for the recipient.
//
// WHAT THE RECIPIENT IS NEVER SHOWN
// Their position in any queue, that a queue exists, anything about any other
// prospect, and any availability outside the offered window. The first three
// are absences; the fourth is enforced twice, here and in the state module.

type Props = {
  state: InvitationViewState;
  /** Currently selected slot start, if any. Owned by the container. */
  selectedSlotStart: string | null;
  onSelectSlot: (slot: OfferedSlot) => void;
  /** Supplied by B2's container. Never defined in this file. */
  onBook: () => void;
  onDecline: () => void;
  onRetry: () => void;
  /** B1.5c proof exchange, both supplied by the container. */
  onRequestCode: () => void;
  onSubmitCode: (code: string) => void;
  /** True while a book/decline the container initiated is in flight. */
  pending?: boolean;
};

export function InvitationScreen({
  state,
  selectedSlotStart,
  onSelectSlot,
  onBook,
  onDecline,
  onRetry,
  onRequestCode,
  onSubmitCode,
  pending = false,
}: Props) {
  return <main className="mx-auto w-full max-w-md px-4 py-8">{renderState()}</main>;

  // EXHAUSTIVE AT THE TOP LEVEL TOO.
  //
  // This was seven independent `state.kind === "x" ? … : null` renders. A new
  // `InvitationViewState` member would have made every one of them evaluate to
  // null and handed the recipient an empty page, with `tsc` perfectly happy --
  // the same union-growth failure that put `verifying` on the "start over"
  // screen one level down. Hardening the inner switch and leaving the outer one
  // as a ternary chain fixed the instance and not the class.
  function renderState() {
    switch (state.kind) {
      case "loading":
        return <LoadingView />;
      case "error":
        return <ErrorView retryable={state.retryable} onRetry={onRetry} />;
      case "declined":
        return <DeclinedView />;
      case "closed":
        return <ClosedView reason={state.reason} presentation={state.presentation} />;
      case "booked":
        return (
          <BookedView
            presentation={state.presentation}
            startLabel={state.startLabel}
            dateLabel={state.dateLabel}
          />
        );
      case "proof":
        return (
          <ProofView
            presentation={state.presentation}
            windowDescription={state.windowDescription}
            stage={state.stage}
            notice={state.notice}
            onRequestCode={onRequestCode}
            onSubmitCode={onSubmitCode}
            pending={pending}
          />
        );
      case "offer":
        return (
          <OfferView
            presentation={state.presentation}
            days={state.days}
            windowDescription={state.windowDescription}
            refusal={state.refusal}
            selectedSlotStart={selectedSlotStart}
            onSelectSlot={onSelectSlot}
            onBook={onBook}
            onDecline={onDecline}
            onRetry={onRetry}
            pending={pending}
          />
        );
      default:
        return assertNeverState(state);
    }
  }
}

/**
 * One line per refusal, and a Record so adding a `BookingRefusal` without copy
 * is a compile error rather than a blank alert.
 */
const PROOF_NOTICE_COPY: Record<ProofNotice, string> = {
  proof_lapsed: "We couldn’t confirm it was you. Request a new code and try again.",
  decline_unavailable: "We couldn’t complete that just now. Please try again in a moment.",
};

const BOOKING_REFUSAL_COPY: Record<BookingRefusal, string> = {
  slot_taken: "That time was taken while you were choosing. Please pick another.",
  not_permitted: "Your invitation doesn't cover that time. Please choose one of the times shown.",
  unavailable: "We couldn't complete that booking. Please try again in a moment.",
};

/** Compile-time exhaustiveness for the screen's own union. */
function assertNeverState(state: never): null {
  void state;
  return null;
}

function LoadingView() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-live="polite">
      <p className="text-sm text-[#6B6B6B]">Loading your invitation…</p>
      <div className="h-6 w-2/3 animate-pulse bg-[#F5F2EB]" />
      <div className="h-24 w-full animate-pulse bg-[#F5F2EB]" />
    </div>
  );
}

function ErrorView({ retryable, onRetry }: { retryable: boolean; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-4" role="alert">
      <h1 className="text-xl text-[#0A0A0A]">This link isn’t working</h1>
      <p className="text-sm text-[#6B6B6B]">
        {retryable
          ? "We couldn’t load your invitation just now."
          : "This invitation link is no longer valid. If you think it should be, please contact the studio."}
      </p>
      {retryable ? (
        <button
          type="button"
          onClick={onRetry}
          className={`${CONTROL_MIN_TOUCH} ${FOCUS_RING} w-full bg-[#0A0A0A] px-4 text-sm text-[#FAFAF7]`}
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

function DeclinedView() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl text-[#0A0A0A]">Thanks for letting us know</h1>
      {/* NO PROMISE THE SYSTEM DOES NOT KEEP. Declining releases the entry;
          only a practitioner-authorised requeue returns it to the waiting list,
          so "you're still on the list and they'll be in touch" claimed an
          automatic future contact that does not happen. */}
      <p className="text-sm text-[#6B6B6B]">
        You’ve declined this appointment and the studio has been told. If you’d still like to be
        seen, please contact them directly.
      </p>
    </div>
  );
}

/**
 * Keyed by the REASON UNION, so a new terminal reason fails the build here.
 *
 * It was `Record<string, …>` with an `?? CLOSED_COPY.expired` fallback, which
 * meant a future reason would quietly tell a recipient their invitation had
 * expired when it had not -- a factual claim about their own invitation,
 * invented by a default.
 */
const CLOSED_COPY: Record<InvitationClosedReason, { title: string; body: string }> = {
  expired: {
    title: "This invitation has expired",
    body: "This offer was only held for a short time and has now lapsed. Please contact the studio if you’d still like an appointment.",
  },
  revoked: {
    title: "This invitation is no longer available",
    body: "The studio has withdrawn this offer. Please contact them directly if you’d still like an appointment.",
  },
  already_redeemed: {
    title: "This appointment is already booked",
    body: "This invitation has already been used. Check your email for the confirmation, or contact the studio.",
  },
  declined: {
    title: "You’ve already declined this offer",
    body: "If you’d still like an appointment, please contact the studio directly.",
  },
};

function ClosedView({
  reason,
  presentation,
}: {
  reason: InvitationClosedReason;
  presentation: OfferPresentation | null;
}) {
  // No fallback: the map is exhaustive over the union by type.
  const copy = CLOSED_COPY[reason];
  return (
    // A DEAD END, and it renders no booking control at all -- not a disabled
    // one. A greyed button invites tapping and explains nothing.
    <div className="flex flex-col gap-4">
      <h1 className="text-xl text-[#0A0A0A]">{copy.title}</h1>
      {presentation ? (
        <p className="text-sm text-[#6B6B6B]">
          {presentation.serviceName} at {presentation.studioName}
        </p>
      ) : null}
      <p className="text-sm text-[#6B6B6B]">{copy.body}</p>
    </div>
  );
}

function BookedView({
  presentation,
  startLabel,
  dateLabel,
}: {
  presentation: OfferPresentation;
  startLabel: string;
  dateLabel: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl text-[#0A0A0A]">You’re booked</h1>
      <p className="text-sm text-[#0A0A0A]">
        {presentation.serviceName} · {dateLabel} at {startLabel}
      </p>
      <p className="text-sm text-[#6B6B6B]">
        {presentation.studioName} will send a confirmation. Add it to your calendar from that email.
      </p>
    </div>
  );
}

function OfferView({
  presentation,
  days,
  windowDescription,
  refusal,
  selectedSlotStart,
  onSelectSlot,
  onBook,
  onDecline,
  onRetry,
  pending,
}: {
  presentation: OfferPresentation;
  days: readonly OfferedDay[];
  windowDescription: string;
  refusal?: BookingRefusal;
  selectedSlotStart: string | null;
  onSelectSlot: (slot: OfferedSlot) => void;
  onBook: () => void;
  onDecline: () => void;
  onRetry: () => void;
  pending: boolean;
}) {
  // DERIVED, never carried. A separate `empty` flag could contradict the
  // collection it described; this cannot.
  const empty = days.length === 0;
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-[#6B6B6B]">{presentation.studioName}</p>
        <h1 className="text-xl text-[#0A0A0A]">{presentation.serviceName}</h1>
        <p className="text-sm text-[#6B6B6B]">{presentation.serviceDurationMinutes} minutes</p>
      </header>

      {/* A refused Book, said out loud. Before this the screen re-rendered
          unchanged and the recipient's tap appeared to do nothing. `role=alert`
          so a screen reader announces it without the focus moving. */}
      {refusal ? (
        <p
          role="alert"
          className="rounded-md bg-[#FDF2F2] px-3 py-2 text-sm text-[#8A2A2A]"
        >
          {BOOKING_REFUSAL_COPY[refusal]}
        </p>
      ) : null}

      {/* THE OFFERED HORIZON, STATED. The recipient should never have to infer
          what they were offered from which buttons happen to exist. */}
      <section className="flex flex-col gap-1 bg-[#F5F2EB] p-4">
        <h2 className="text-sm text-[#0A0A0A]">Times held for you</h2>
        {/* Already resolved through B2's weekday contract. This layer holds no
            weekday semantics of its own and must not acquire any. */}
        <p className="text-sm text-[#6B6B6B]">{windowDescription}</p>
      </section>

      {empty ? (
        <section className="flex flex-col gap-3" aria-live="polite">
          <p className="text-sm text-[#6B6B6B]">
            Nothing is open in the times held for you right now. This can change — try again, or
            let the studio know this doesn’t work.
          </p>
          <button
            type="button"
            onClick={onRetry}
            className={`${CONTROL_MIN_TOUCH} ${FOCUS_RING} w-full border border-[#0A0A0A] px-4 text-sm text-[#0A0A0A]`}
          >
            Check again
          </button>
        </section>
      ) : (
        <section className="flex flex-col gap-5">
          <h2 className="text-sm text-[#0A0A0A]">Choose a time</h2>
          {/* GROUPED BY DAY, because an offer spanning Mondays AND Wednesdays
              renders "9:00 AM" twice otherwise and the recipient cannot tell
              which day they are booking. The heading names the day visually and
              `aria-label` repeats it on the control itself, so the distinction
              survives for a screen reader reading buttons out of context. */}
          {days.map((day) => (
            <div key={day.date} className="flex flex-col gap-2">
              <h3 className="text-sm text-[#6B6B6B]">{day.dateLabel}</h3>
              <ul className="flex flex-col gap-2">
                {day.slots.map((slot) => {
                  const selected = selectedSlotStart === slot.start;
                  return (
                    <li key={slot.start}>
                      <button
                        type="button"
                        onClick={() => onSelectSlot(slot)}
                        aria-pressed={selected}
                        aria-label={`${day.dateLabel} at ${slot.startLabel}`}
                        // FROZEN WHILE A BOOKING IS IN FLIGHT. Book and Decline
                        // were disabled but the times were not, so a recipient
                        // could pick a different slot after submitting and the
                        // screen would show B while the running request booked
                        // A. `onBook` takes no slot argument -- selection is the
                        // container's -- so the two could not be reconciled
                        // afterwards.
                        disabled={pending}
                        className={`${CONTROL_MIN_TOUCH} ${FOCUS_RING} w-full border border-[#0A0A0A] px-4 text-sm disabled:opacity-60 ${
                          selected ? "bg-[#0A0A0A] text-[#FAFAF7]" : "bg-white text-[#0A0A0A]"
                        }`}
                      >
                        {slot.startLabel}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>
      )}

      {!empty ? (
        <button
          type="button"
          onClick={onBook}
          disabled={pending || selectedSlotStart === null}
          className={`${CONTROL_MIN_TOUCH} ${FOCUS_RING} w-full bg-[#0A0A0A] px-4 text-sm text-[#FAFAF7] disabled:opacity-60`}
        >
          {pending ? "Booking…" : "Book this time"}
        </button>
      ) : null}

      {/* Deliberately separated from the primary action, and never styled as a
          peer of it: declining is unrecoverable for the recipient, so a
          mis-tap must be hard rather than merely undone. */}
      <footer className="mt-4 border-t border-[#E7E2D8] pt-4">
        <button
          type="button"
          onClick={onDecline}
          disabled={pending}
          className={`${CONTROL_MIN_TOUCH} ${FOCUS_RING} w-full px-4 text-sm text-[#6B6B6B] underline disabled:opacity-60`}
        >
          {pending ? "Working…" : "I can’t make any of these"}
        </button>
      </footer>
    </div>
  );
}

/**
 * Keyed by the RECOVERABLE subset, so a new one fails the build here.
 *
 * `invalid_token` and `not_live` are gone: they are terminal, and their entries
 * only existed because the reason type was wide enough to reach them. Copy for
 * a state this view can no longer be handed is copy that hides a type hole.
 */
const PROOF_FAILURE_COPY: Record<RecoverableProofFailure, string> = {
  wrong_challenge: "That code didn’t match. Check the email and try again.",
  challenge_expired: "That code has expired. Request a new one.",
  too_many_attempts: "Too many attempts. Request a new code to continue.",
  no_challenge: "Request a code to continue.",
  recipient_changed: "This invitation’s contact details changed. Please contact the studio.",
  invalid_input: "That code doesn’t look right.",
};

/**
 * THE GATE THE WHOLE SLICE EXISTS FOR.
 *
 * Possession of the URL shows WHAT was offered -- service, studio, horizon --
 * and nothing bookable. Times appear only after B1.5c has verified a code sent
 * to the address the studio already holds. A forwarded link therefore leaks the
 * offer's shape and no ability to act on it.
 *
 * The address is shown MASKED, from B2's own `maskedContact`. This screen never
 * receives the raw contact and must never be given it.
 */
function ProofView({
  presentation,
  windowDescription,
  stage,
  notice,
  onRequestCode,
  onSubmitCode,
  pending,
}: {
  presentation: OfferPresentation;
  windowDescription: string;
  stage: UnprovenProofStage;
  notice?: ProofNotice;
  onRequestCode: () => void;
  onSubmitCode: (code: string) => void;
  pending: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-[#6B6B6B]">{presentation.studioName}</p>
        <h1 className="text-xl text-[#0A0A0A]">{presentation.serviceName}</h1>
        <p className="text-sm text-[#6B6B6B]">{presentation.serviceDurationMinutes} minutes</p>
      </header>

      <section className="flex flex-col gap-1 bg-[#F5F2EB] p-4">
        <h2 className="text-sm text-[#0A0A0A]">Times held for you</h2>
        <p className="text-sm text-[#6B6B6B]">{windowDescription}</p>
      </section>

      {/* Why they are back here. A failed decline used to return them to
          "request a code" silently, so their tap looked like it did nothing. */}
      {notice ? (
        <p
          role="alert"
          className="rounded-md bg-[#FDF2F2] px-3 py-2 text-sm text-[#8A2A2A]"
        >
          {PROOF_NOTICE_COPY[notice]}
        </p>
      ) : null}

      {renderProofStage(stage, onRequestCode, onSubmitCode, pending)}
    </div>
  );
}

/**
 * EXHAUSTIVE OVER `ProofStage`, and that is the point.
 *
 * The previous shape was `unavailable ? … : awaitingCode ? … : <start over>`,
 * so `verifying` -- added to the union without a home here -- fell through to
 * the initial branch. A recipient who had just submitted a code saw "Email me a
 * code" again, enabled, and pressing it minted a fresh challenge that destroyed
 * the verification in flight, because `begin_` overwrites the challenge hash in
 * place.
 *
 * The bug was not the missing branch. It was that a catch-all `else` let the
 * union grow while the view stood still. A switch with a `never` exhaustiveness
 * check cannot do that: the next stage added to `ProofStage` fails `tsc` here
 * rather than silently rendering "start over".
 */
function renderProofStage(
  stage: UnprovenProofStage,
  onRequestCode: () => void,
  onSubmitCode: (code: string) => void,
  pending: boolean,
) {
  switch (stage.kind) {
    case "unavailable":
      return (
        <div className="flex flex-col gap-3" role="alert">
          <p className="text-sm text-[#6B6B6B]">
            {stage.retryable
              ? "We couldn’t send your code just now."
              : "This invitation is no longer available."}
          </p>
          {stage.retryable ? (
            <button
              type="button"
              onClick={onRequestCode}
              className={`${CONTROL_MIN_TOUCH} ${FOCUS_RING} w-full bg-[#0A0A0A] px-4 text-sm text-[#FAFAF7]`}
            >
              Try again
            </button>
          ) : null}
        </div>
      );

    case "verifying":
      // BUSY AND NON-INTERACTIVE FOR THE WHOLE PERIOD. The submitted code stays
      // on screen, read-only, so the recipient keeps their place; and there is
      // no way to request a new one, because doing so would invalidate the
      // check currently running.
      return (
        <section className="flex flex-col gap-3" aria-busy="true" aria-live="polite">
          <p className="text-sm text-[#0A0A0A]">Checking your code…</p>
          <p className="text-sm text-[#6B6B6B]">Sent to {stage.maskedContact}</p>
          {/* A 64-character hex token has no natural break opportunity, so
              without this it runs past `max-w-md` and gives the phone a
              horizontal scrollbar -- breaking the single-column rule this
              surface is built on. */}
          <output
            className={`${CONTROL_MIN_TOUCH} w-full break-all border border-[#E7E2D8] bg-[#F5F2EB] px-4 py-2 text-base text-[#6B6B6B] [overflow-wrap:anywhere]`}
          >
            {stage.submittedCode}
          </output>
        </section>
      );

    case "sent":
    case "failed": {
      const failure = stage.kind === "failed" ? PROOF_FAILURE_COPY[stage.reason] : null;
      return (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            onSubmitCode(String(data.get("code") ?? ""));
          }}
        >
          <label className="flex flex-col gap-1 text-sm text-[#0A0A0A]" htmlFor="proof-code">
            Enter the code we sent to {stage.maskedContact}
          </label>
          {/* B1.5c mints `^[a-f0-9]{64}$`, so nearly every code contains a-f.
              A numeric keypad made the credential literally unenterable on the
              surface this slice exists to serve. */}
          <input
            id="proof-code"
            name="code"
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            className={`${CONTROL_MIN_TOUCH} ${FOCUS_RING} w-full border border-[#0A0A0A] px-4 text-base`}
          />
          {failure ? (
            <p className="text-sm text-[#8A1C1C]" role="alert">
              {failure}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={pending}
            className={`${CONTROL_MIN_TOUCH} ${FOCUS_RING} w-full bg-[#0A0A0A] px-4 text-sm text-[#FAFAF7] disabled:opacity-60`}
          >
            {pending ? "Checking…" : "Confirm it’s you"}
          </button>
          <button
            type="button"
            onClick={onRequestCode}
            disabled={pending}
            className={`${CONTROL_MIN_TOUCH} ${FOCUS_RING} w-full px-4 text-sm text-[#6B6B6B] underline disabled:opacity-60`}
          >
            Send a new code
          </button>
        </form>
      );
    }

    case "required":
    case "requesting":
      return (
        <section className="flex flex-col gap-3">
          <p className="text-sm text-[#6B6B6B]">
            To see the available times, confirm it’s you. We’ll email a code to the address the
            studio has for you.
          </p>
          <button
            type="button"
            onClick={onRequestCode}
            disabled={pending || stage.kind === "requesting"}
            className={`${CONTROL_MIN_TOUCH} ${FOCUS_RING} w-full bg-[#0A0A0A] px-4 text-sm text-[#FAFAF7] disabled:opacity-60`}
          >
            {stage.kind === "requesting" || pending ? "Sending…" : "Email me a code"}
          </button>
        </section>
      );

    default:
      return assertNeverStage(stage);
  }
}

/** Compile-time exhaustiveness. A new ProofStage breaks the build here. */
function assertNeverStage(stage: never): null {
  void stage;
  return null;
}
