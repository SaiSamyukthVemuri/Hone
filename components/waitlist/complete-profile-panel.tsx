"use client";

import { useState, useTransition } from "react";
import { cx, CONTROL_MIN_TOUCH, FOCUS_RING } from "@/components/ui/control-base";
import { ProfileFields } from "@/components/waitlist/profile-fields";
import {
  completionDraftFromStored,
  completionPatchFromProfile,
  storedMobilePresent,
  validateJoinProfileDraft,
  type JoinProfileDraft,
  type ProfileCompletionPatch,
  type ProfileFieldErrors,
  type StoredWaitlistProfile,
} from "@/lib/waitlist/join-profile";
import {
  COMPLETE_DONE_HEADING,
  COMPLETE_HEADING,
  COMPLETE_INTRO,
  COMPLETE_POSITION_UNCHANGED,
  COMPLETE_SUBMIT,
  WAITLIST_CONTACT_PROMISE,
} from "@/lib/waitlist/join-copy";

// ===========================================================================
// WAIT-04A — "COMPLETE YOUR WAITLIST DETAILS"
// ===========================================================================
//
// WHO REACHES THIS. Someone who joined before WAIT-04A existed, following a
// link the studio sent them. They are NOT logged in and never will be — a
// waitlist prospect has no account, which is the whole reason this surface is
// capability-reachable rather than session-authenticated.
//
// ---------------------------------------------------------------------------
// THE SECURITY SHAPE, DESIGNED HERE AND ENFORCED SERVER-SIDE LATER
// ---------------------------------------------------------------------------
//
// 1. THE CALLER NEVER NAMES THE ROW. `ProfileCompletionPatch` carries no
//    `entryId`, and this component has no prop for one. Which entry is being
//    completed is derived SERVER-SIDE from the capability, so a submission
//    cannot ask to write somebody else's row. This is the same ruling
//    WAIT-03B's recipient surface applies to booking.
//
// 2. THE EMAIL CANNOT BE CHANGED. `emailLocked` renders it as text with no form
//    control at all. The address on the entry is where every future invitation
//    goes, so an editable field on a page reachable by possession of a link
//    would let whoever holds that link redirect the studio's next offer. Every
//    legacy entry already has an email — it is the one field they all have — so
//    locking it costs nothing and closes a redirect.
//
// 2b. NEITHER CAN A MOBILE THAT IS ALREADY ON FILE. Same threat, sharper: the
//    mobile is where SMS goes, and a replacement paired with a consent tick in
//    the same submission would arrive looking like agreement for the NEW number.
//    Unlike the email this cannot simply be dropped — no legacy entry has a
//    mobile, and supplying one is why this page exists — so the rule is
//    conditional on what the entry holds: a number on file is rendered as text
//    with no control, and only an ABSENT one gets a field.
//
//    What that field collects is a CANDIDATE. It is a number someone typed, it
//    is not an authenticated destination, and `prospectMayReceiveSms` refuses to
//    send to it until it is verified. The surface says so rather than implying a
//    text will follow.
//
// 3. CONSENT IS ASKED AGAIN, NEVER RE-PRESENTED AS GIVEN.
//    `completionDraftFromStored` never seeds `smsOperationalConsent` from
//    storage. A pre-ticked box is not agreement.
//
// 4. THE TOKEN IS NOT RENDERED. It is a prop the submit handler closes over; it
//    appears in no markup, no hidden input, no link and no data attribute, so
//    it cannot leak through a screenshot, a copied DOM or a referrer.
//
// 5. NO EXISTENCE ORACLE. Failure copy is supplied by the caller and this
//    component branches on nothing about WHY. An invalid token, a revoked
//    grant, an expired one and an already-completed entry must all render the
//    same refusal, or the page tells an anonymous holder which it was.
//
// ---------------------------------------------------------------------------
// AND THE PROMISE THAT MATTERS MOST TO THE PERSON READING IT
// ---------------------------------------------------------------------------
//
// Answering does not move them in the queue. `ProfileCompletionPatch` has no
// `joinedAt` limb, so no completion path can move it even by accident — the
// sentence is structurally true, not merely intended. It is stated twice: once
// in the intro, once beside the button, because it is the question someone is
// actually asking when a business emails them a form.
//
// UNWIRED. `onSubmit` is required and has no server action behind it in this
// slice; the capability grant it will bind to (`new_client_waitlist_preference_grants`,
// issue/redeem/revoke) is WAIT-ADMIT-01's migration 0193, which is not in
// production. WAIT-04B binds it.
// ===========================================================================

const CARD_BG = "#FAFAF7";
const CARD_BORDER = "#E5E2D9";
const INK = "#0A0A0A";
const MUTED = "#6B6B6B";

export type CompletionSubmitResult = { ok: true } | { ok: false; error: string };

export function CompleteProfilePanel({
  stored,
  onSubmit,
  initialDraft,
}: {
  /** What the entry already holds. Read for pre-fill only; never trusted as complete. */
  stored: StoredWaitlistProfile;
  /**
   * Bound in WAIT-04B. Receives the PATCH plus consent as a separate argument,
   * because consent is not a profile field — it is an act with its own record
   * (`buildProspectSmsConsentRecord`), and merging the two would let a profile
   * write imply an agreement.
   */
  onSubmit: (
    patch: ProfileCompletionPatch,
    smsOperationalConsent: boolean,
  ) => Promise<CompletionSubmitResult>;
  /** Test seam. Production seeds from `stored`. */
  initialDraft?: JoinProfileDraft;
}) {
  const [draft, setDraft] = useState<JoinProfileDraft>(
    initialDraft ?? completionDraftFromStored(stored),
  );
  // Read from the ENTRY, never from the draft: the draft is browser state and a
  // caller could hand one carrying a mobile for an entry that has none.
  const mobileOnFile = storedMobilePresent(stored);
  const [errors, setErrors] = useState<ProfileFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, startSubmitting] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setFormError(null);

    const validated = validateJoinProfileDraft(draft);
    if (!validated.ok) {
      setErrors(validated.errors);
      return;
    }
    setErrors({});

    startSubmitting(async () => {
      const result = await onSubmit(
        // `stored` decides which arm of the patch union this is, so a submission
        // cannot claim to be supplying a first number for an entry that has one.
        completionPatchFromProfile(validated.value, stored),
        validated.value.smsOperationalConsent,
      );
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      setDone(true);
    });
  }

  if (done) {
    return (
      <div
        className="flex w-full max-w-full flex-col gap-4 p-6"
        style={{ backgroundColor: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
        role="status"
        aria-live="polite"
        data-testid="waitlist-completion-done"
      >
        <h2
          className="font-[var(--font-fraunces)] text-[24px] font-bold leading-tight md:text-[28px]"
          style={{ letterSpacing: "-0.02em" }}
        >
          {COMPLETE_DONE_HEADING}
        </h2>
        <p className="text-[15px] leading-[1.6]" style={{ color: INK }}>
          {WAITLIST_CONTACT_PROMISE}
        </p>
        <p className="text-[13px] leading-[1.6]" style={{ color: MUTED }}>
          {COMPLETE_POSITION_UNCHANGED}
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      data-testid="waitlist-completion-form"
      className="flex w-full max-w-full flex-col gap-6 p-6"
      style={{ backgroundColor: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
    >
      <div className="flex flex-col gap-3">
        <h2
          className="font-[var(--font-fraunces)] text-[24px] font-bold leading-tight md:text-[28px]"
          style={{ letterSpacing: "-0.02em" }}
        >
          {COMPLETE_HEADING}
        </h2>
        <p className="text-[15px] leading-[1.6]" style={{ color: INK }}>
          {COMPLETE_INTRO}
        </p>
      </div>

      <ProfileFields
        draft={draft}
        errors={errors}
        onChange={setDraft}
        disabled={submitting}
        emailLocked
        // Conditional, unlike the email: locked when the entry holds a number,
        // open when it does not, because a legacy entry has none and supplying
        // one is the point of this visit.
        mobileLocked={mobileOnFile}
        showMobileCandidateNote={!mobileOnFile}
      />

      <div className="flex flex-col gap-3">
        <button
          type="submit"
          disabled={submitting}
          data-testid="waitlist-completion-submit"
          className={cx(
            CONTROL_MIN_TOUCH,
            FOCUS_RING,
            "w-full px-6 py-3 text-[13px] font-medium uppercase disabled:opacity-60 sm:w-auto sm:self-start",
          )}
          style={{ backgroundColor: INK, color: CARD_BG, letterSpacing: "0.1em" }}
        >
          {submitting ? "Saving…" : COMPLETE_SUBMIT}
        </button>
        <p className="text-[13px] leading-[1.6]" style={{ color: MUTED }}>
          {COMPLETE_POSITION_UNCHANGED}
        </p>
        {formError && (
          <span
            role="alert"
            data-testid="waitlist-completion-error"
            className="text-[13px] text-red-600"
          >
            {formError}
          </span>
        )}
      </div>
    </form>
  );
}
