"use client";

import { useState, useTransition } from "react";
import { cx, CONTROL_MIN_TOUCH, FOCUS_RING } from "@/components/ui/control-base";
import { ProfileFields } from "@/components/waitlist/profile-fields";
import {
  emptyJoinProfileDraft,
  validateJoinProfileDraft,
  type JoinProfileDraft,
  type ProfileFieldErrors,
  type WaitlistJoinProfile,
} from "@/lib/waitlist/join-profile";
import {
  JOIN_HEADING,
  JOIN_INTRO,
  JOINED_HEADING,
  NOT_A_RESERVATION,
  WAITLIST_CONTACT_PROMISE,
} from "@/lib/waitlist/join-copy";

// ===========================================================================
// WAIT-04A — THE NEW-JOIN EXPERIENCE
// ===========================================================================
//
// UNWIRED, AND ON PURPOSE. `onSubmit` is a required prop with no default and no
// server action behind it in this slice. There is no migration here and no
// column for treatment areas, availability or consent to be written to, so a
// form that posted them would either drop them silently — the exact fake
// completeness this slice forbids — or write a shape the database does not
// have. WAIT-04B binds this after the DB authority exists; until then the only
// caller is a test.
//
// THE SHIPPED FORM IS UNTOUCHED. app/book/[slug]/NewClientWaitlistForm.tsx keeps
// taking name/email/optional-phone into `join_new_client_waitlist`, exactly as
// production does today. Replacing it before its commit point can store the new
// answers would break a live studio's intake to ship a shape.
//
// WHAT IS DIFFERENT FROM #683's B4 PROTOTYPE, DELIBERATELY: every control here
// has a real handler. A presentational component with no `onClick` anywhere
// looks finished, tests green, and then costs a second pass to make clickable.
// The seam that matters is DATA — no fetch, no action, no server import — not
// interaction.
//
// COPY DISCIPLINE INHERITED FROM THE SHIPPED FORM AND EXTENDED. Nothing says
// "fully booked". Nothing exposes utilization, capacity, queue size, lead
// times or workload. Nothing promises a date, a position, priority or
// acceptance. And this slice adds one more: nothing ASKS how urgent it is.
// ===========================================================================

const CARD_BG = "#FAFAF7";
const CARD_BORDER = "#E5E2D9";
const INK = "#0A0A0A";
const MUTED = "#6B6B6B";

export type JoinSubmitResult = { ok: true } | { ok: false; error: string };

/**
 * The confirmation surface.
 *
 * Separated and prop-thin for the same structural reason the shipped form
 * separates its own: it receives ONLY the studio name, so no rendering of it
 * can vary with which database outcome occurred. A newly created entry and an
 * already-waiting duplicate must be indistinguishable here — on a public,
 * unauthenticated form, copy that told them apart would let anyone type an
 * address and learn whether that person had asked this studio for treatment.
 */
export function WaitlistJoinedPanel({ studioName }: { studioName: string }) {
  return (
    <div
      className="flex w-full max-w-full flex-col gap-4 p-6"
      style={{ backgroundColor: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
      role="status"
      aria-live="polite"
      data-testid="waitlist-joined-panel"
    >
      <h2
        className="font-[var(--font-fraunces)] text-[24px] font-bold leading-tight md:text-[28px]"
        style={{ letterSpacing: "-0.02em" }}
      >
        {JOINED_HEADING}
      </h2>
      {/* The promise is rendered VERBATIM from the copy module. An earlier
          revision lower-cased its first word to splice it after the studio
          name, which made the one sentence this feature is judged on a product
          of two string operations. The studio name gets its own line instead. */}
      <p className="text-[15px] leading-[1.6]" style={{ color: INK }}>
        {WAITLIST_CONTACT_PROMISE}
      </p>
      <p className="text-[13px] leading-[1.6]" style={{ color: MUTED }}>
        {studioName} will be in touch by email.
      </p>
      <p className="text-[13px] leading-[1.6]" style={{ color: MUTED }}>
        {NOT_A_RESERVATION}
      </p>
    </div>
  );
}

export function WaitlistJoinForm({
  studioName,
  onSubmit,
  initialDraft,
}: {
  studioName: string;
  /** Bound in WAIT-04B. Receives a VALIDATED profile — never a raw draft. */
  onSubmit: (profile: WaitlistJoinProfile) => Promise<JoinSubmitResult>;
  /** Test seam. Production opens blank. */
  initialDraft?: JoinProfileDraft;
}) {
  const [draft, setDraft] = useState<JoinProfileDraft>(
    initialDraft ?? emptyJoinProfileDraft(),
  );
  const [errors, setErrors] = useState<ProfileFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  const [submitting, startSubmitting] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    // Belt and braces against a double submit, matching the shipped form: the
    // CTA is disabled while pending AND the handler refuses a second transition.
    if (submitting) return;
    setFormError(null);

    // CLIENT VALIDATION IS A COURTESY, NOT THE AUTHORITY. It exists so someone
    // is told about a blank field without a round trip. The server revalidates
    // the same submission independently; nothing downstream may trust this.
    const validated = validateJoinProfileDraft(draft);
    if (!validated.ok) {
      setErrors(validated.errors);
      return;
    }
    setErrors({});

    startSubmitting(async () => {
      const result = await onSubmit(validated.value);
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      setJoined(true);
    });
  }

  if (joined) return <WaitlistJoinedPanel studioName={studioName} />;

  return (
    <form
      onSubmit={submit}
      noValidate
      data-testid="waitlist-join-form"
      className="flex w-full max-w-full flex-col gap-6 p-6"
      style={{ backgroundColor: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
    >
      <div className="flex flex-col gap-3">
        <h2
          className="font-[var(--font-fraunces)] text-[24px] font-bold leading-tight md:text-[28px]"
          style={{ letterSpacing: "-0.02em" }}
        >
          {JOIN_HEADING}
        </h2>
        <p className="text-[15px] leading-[1.6]" style={{ color: INK }}>
          {JOIN_INTRO}
        </p>
      </div>

      <ProfileFields
        draft={draft}
        errors={errors}
        onChange={setDraft}
        disabled={submitting}
      />

      <div className="flex flex-col gap-3">
        <button
          type="submit"
          disabled={submitting}
          data-testid="waitlist-join-submit"
          className={cx(
            CONTROL_MIN_TOUCH,
            FOCUS_RING,
            "w-full px-6 py-3 text-[13px] font-medium uppercase disabled:opacity-60 sm:w-auto sm:self-start",
          )}
          style={{ backgroundColor: INK, color: CARD_BG, letterSpacing: "0.1em" }}
        >
          {submitting ? "Joining…" : "Join waitlist"}
        </button>
        <p className="text-[13px] leading-[1.6]" style={{ color: MUTED }}>
          {WAITLIST_CONTACT_PROMISE}
        </p>
        <p className="text-[13px] leading-[1.6]" style={{ color: MUTED }}>
          {NOT_A_RESERVATION}
        </p>
        {formError && (
          <span role="alert" data-testid="waitlist-join-error" className="text-[13px] text-red-600">
            {formError}
          </span>
        )}
      </div>
    </form>
  );
}
