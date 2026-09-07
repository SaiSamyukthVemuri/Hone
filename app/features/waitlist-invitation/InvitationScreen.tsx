"use client";

import type {
  InvitationViewState,
  OfferedDay,
  OfferedSlot,
  OfferPresentation,
  ProofStage,
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
  return (
    <main className="mx-auto w-full max-w-md px-4 py-8">
      {state.kind === "loading" ? <LoadingView /> : null}
      {state.kind === "error" ? <ErrorView retryable={state.retryable} onRetry={onRetry} /> : null}
      {state.kind === "declined" ? <DeclinedView /> : null}
      {state.kind === "closed" ? <ClosedView reason={state.reason} presentation={state.presentation} /> : null}
      {state.kind === "booked" ? (
        <BookedView
          presentation={state.presentation}
          startLabel={state.startLabel}
          dateLabel={state.dateLabel}
        />
      ) : null}
      {state.kind === "proof" ? (
        <ProofView
          presentation={state.presentation}
          windowDescription={state.windowDescription}
          stage={state.stage}
          onRequestCode={onRequestCode}
          onSubmitCode={onSubmitCode}
          pending={pending}
        />
      ) : null}
      {state.kind === "offer" ? (
        <OfferView
          presentation={state.presentation}
          days={state.days}
          windowDescription={state.windowDescription}
          empty={state.empty}
          selectedSlotStart={selectedSlotStart}
          onSelectSlot={onSelectSlot}
          onBook={onBook}
          onDecline={onDecline}
          onRetry={onRetry}
          pending={pending}
        />
      ) : null}
    </main>
  );
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

const CLOSED_COPY: Record<string, { title: string; body: string }> = {
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
  reason: string;
  presentation: OfferPresentation | null;
}) {
  const copy = CLOSED_COPY[reason] ?? CLOSED_COPY.expired;
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
  empty,
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
  empty: boolean;
  selectedSlotStart: string | null;
  onSelectSlot: (slot: OfferedSlot) => void;
  onBook: () => void;
  onDecline: () => void;
  onRetry: () => void;
  pending: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-[#6B6B6B]">{presentation.studioName}</p>
        <h1 className="text-xl text-[#0A0A0A]">{presentation.serviceName}</h1>
        <p className="text-sm text-[#6B6B6B]">{presentation.serviceDurationMinutes} minutes</p>
      </header>

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
                        className={`${CONTROL_MIN_TOUCH} ${FOCUS_RING} w-full border border-[#0A0A0A] px-4 text-sm ${
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

const PROOF_FAILURE_COPY: Record<string, string> = {
  wrong_challenge: "That code didn’t match. Check the email and try again.",
  challenge_expired: "That code has expired. Request a new one.",
  too_many_attempts: "Too many attempts. Request a new code to continue.",
  no_challenge: "Request a code to continue.",
  recipient_changed: "This invitation’s contact details changed. Please contact the studio.",
  invalid_token: "This link is no longer valid.",
  not_live: "This invitation is no longer available.",
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
  onRequestCode,
  onSubmitCode,
  pending,
}: {
  presentation: OfferPresentation;
  windowDescription: string;
  stage: ProofStage;
  onRequestCode: () => void;
  onSubmitCode: (code: string) => void;
  pending: boolean;
}) {
  const awaitingCode = stage.kind === "sent" || stage.kind === "failed";
  const failure = stage.kind === "failed" ? PROOF_FAILURE_COPY[stage.reason] : null;

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

      {stage.kind === "unavailable" ? (
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
      ) : awaitingCode ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            onSubmitCode(String(data.get("code") ?? ""));
          }}
        >
          <label className="flex flex-col gap-1 text-sm text-[#0A0A0A]" htmlFor="proof-code">
            Enter the code we sent to {"maskedContact" in stage ? stage.maskedContact : ""}
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
      ) : (
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
      )}
    </div>
  );
}
