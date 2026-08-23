"use client";

import { useId, useState, useTransition } from "react";
import { submitNewClientBookingWaitlistAction } from "./waitlist-actions";

// ===========================================================================
// P0 EMERGENCY — NEW-CLIENT WAITLIST FORM
// ===========================================================================
//
// Rendered INSTEAD OF the new-client booking flow when the server says this
// studio's new-client intake is waitlisted. The visitor is never walked
// through service -> date -> slot and rejected at the end; they see this the
// moment they identify as a new client.
//
// PRESENTATION ONLY. It is reached because the server rendered
// `newClientWaitlistEnabled`, and the submit it drives re-verifies the feature
// server-side from the server-resolved studio. A stale tab, a forged post or
// modified client JavaScript cannot book around it: the public booking action
// carries its own independent gate.
//
// WAIT-02: THE SUCCESS SURFACE IS ONE SURFACE, AND IT SAYS ONE THING.
// "You're on the waitlist" renders only when the SERVER reports success — a
// durable record exists (or, for a studio still on the WAIT-01 commit point,
// the studio notification was accepted). It is never inferred from the request
// having completed.
//
// AND IT SAYS THE SAME THING EITHER WAY. A newly created entry and an
// already-waiting duplicate produce the same server value and therefore the
// same panel. That is not a simplification, it is the point: this form is
// public and unauthenticated, so copy that distinguished the two would let
// anyone type a name and address and learn whether that person had asked this
// studio for treatment. The panel below is a separate component whose props
// carry NO outcome discriminator, so the disclosure cannot come back by
// accident — there is nothing for it to branch on.
//
// COPY DISCIPLINE. Nothing here says "we are fully booked" or "no appointments
// available" — both would be false for EXISTING clients, who keep their normal
// booking path and are one click away. Nothing exposes utilization, capacity,
// queue size, lead times, conversion rates or practitioner workload. Nothing
// promises a date, a position, priority or acceptance.
//
// Uses the public booking page's existing design language rather than
// introducing a new one.
// ===========================================================================

const CARD_BG = "#FAFAF7";
const CARD_BORDER = "#E5E2D9";
const INK = "#0A0A0A";
const MUTED = "#6B6B6B";

const NOT_A_RESERVATION = "Joining the waitlist does not reserve an appointment.";

/**
 * The confirmation surface. Exported so it can be rendered and compared
 * directly in tests, and separated so the invariant is STRUCTURAL rather than
 * asserted: it receives only the studio name, so no rendering of it can vary
 * with which database outcome occurred.
 */
export function NewClientWaitlistJoinedPanel({ studioName }: { studioName: string }) {
  return (
    <div
      className="flex w-full max-w-full flex-col gap-4 p-6"
      style={{ backgroundColor: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
      role="status"
      aria-live="polite"
    >
      <h2
        className="font-[var(--font-fraunces)] text-[24px] font-bold leading-tight md:text-[28px]"
        style={{ letterSpacing: "-0.02em" }}
      >
        You&rsquo;re on the waitlist.
      </h2>
      <p className="text-[15px] leading-[1.6]" style={{ color: INK }}>
        {studioName} will contact you when consultation and treatment
        availability can be offered.
      </p>
      <p className="text-[13px] leading-[1.6]" style={{ color: MUTED }}>
        {NOT_A_RESERVATION}
      </p>
    </div>
  );
}

export function NewClientWaitlistForm({
  slug,
  studioName,
  onContinueAsExistingClient,
}: {
  slug: string;
  studioName: string;
  onContinueAsExistingClient: () => void;
}) {
  const nameId = useId();
  const emailId = useId();
  const phoneId = useId();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Set only by a successful server answer, so the confirmation panel can never
  // render without one. A boolean deliberately: there is no second success
  // state left to hold.
  const [joined, setJoined] = useState(false);
  const [submitting, startSubmitting] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    // Belt and braces against a double submit: the CTA is disabled while
    // pending AND the handler refuses to start a second transition.
    if (submitting) return;
    setError(null);
    const fd = new FormData();
    fd.set("slug", slug);
    fd.set("name", name);
    fd.set("email", email);
    fd.set("phone", phone);
    startSubmitting(async () => {
      const result = await submitNewClientBookingWaitlistAction(fd);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setJoined(true);
    });
  }

  if (joined) return <NewClientWaitlistJoinedPanel studioName={studioName} />;

  return (
    <div className="flex w-full max-w-full flex-col gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-[13px]" style={{ color: MUTED }}>
          Booking as a{" "}
          <strong className="font-medium" style={{ color: INK }}>
            new client
          </strong>
          .
        </p>
        {/* The studio has NOT stopped booking. Existing clients continue
            through their normal path, and this is their one-click way back. */}
        <button
          type="button"
          onClick={onContinueAsExistingClient}
          className="text-[13px] underline"
          style={{ color: MUTED }}
        >
          Already a client? Continue booking.
        </button>
      </div>

      <form
        onSubmit={submit}
        noValidate
        className="flex w-full max-w-full flex-col gap-5 p-6"
        style={{ backgroundColor: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
      >
        <div className="flex flex-col gap-3">
          <h2
            className="font-[var(--font-fraunces)] text-[24px] font-bold leading-tight md:text-[28px]"
            style={{ letterSpacing: "-0.02em" }}
          >
            Join the new-client waitlist
          </h2>
          <p className="text-[15px] leading-[1.6]" style={{ color: INK }}>
            {studioName} is currently booking new clients from a waitlist so we
            can make sure treatment can begin soon after your consultation.
          </p>
        </div>

        <div className="flex w-full flex-col gap-1">
          <label htmlFor={nameId} className="text-[12px] uppercase tracking-[0.1em]" style={{ color: MUTED }}>
            Name <span aria-hidden="true">*</span>
          </label>
          <input
            id={nameId}
            name="name"
            type="text"
            required
            autoComplete="name"
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full max-w-full bg-transparent py-2 text-[16px] outline-none"
            style={{ borderBottom: `1px solid ${INK}`, color: INK }}
          />
        </div>

        <div className="flex w-full flex-col gap-1">
          <label htmlFor={emailId} className="text-[12px] uppercase tracking-[0.1em]" style={{ color: MUTED }}>
            Email <span aria-hidden="true">*</span>
          </label>
          <input
            id={emailId}
            name="email"
            type="email"
            required
            inputMode="email"
            autoComplete="email"
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full max-w-full bg-transparent py-2 text-[16px] outline-none"
            style={{ borderBottom: `1px solid ${INK}`, color: INK }}
          />
        </div>

        <div className="flex w-full flex-col gap-1">
          <label htmlFor={phoneId} className="text-[12px] uppercase tracking-[0.1em]" style={{ color: MUTED }}>
            Phone (optional)
          </label>
          <input
            id={phoneId}
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            maxLength={40}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full max-w-full bg-transparent py-2 text-[16px] outline-none"
            style={{ borderBottom: `1px solid ${INK}`, color: INK }}
          />
        </div>

        <div className="flex flex-col gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="flex min-h-[44px] w-full items-center justify-center px-6 py-3 text-[13px] font-medium uppercase disabled:opacity-60 sm:w-auto sm:self-start"
            style={{ backgroundColor: INK, color: CARD_BG, letterSpacing: "0.1em" }}
          >
            {submitting ? "Joining…" : "Join waitlist"}
          </button>
          <p className="text-[13px] leading-[1.6]" style={{ color: MUTED }}>
            {NOT_A_RESERVATION}
          </p>
          {error && (
            <span role="alert" className="text-[13px] text-red-600">
              {error}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
