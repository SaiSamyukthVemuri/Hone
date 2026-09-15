// ===========================================================================
// WAIT-04A — THE WAITLIST PROSPECT PROFILE
// ===========================================================================
//
// WHAT CHANGED AND WHY. The shipped join form (app/book/[slug]/NewClientWaitlistForm.tsx)
// asks for name, email and an OPTIONAL phone. That was right for admission
// control — the only job was to stop new bookings and capture a lead. It is not
// enough to OFFER someone a consultation: matching a prospect to a real
// appointment needs to know what they want treated and when they can come, and
// reaching them needs a number they agreed we could use.
//
// This module is the typed contract for that richer profile. It is PURE and it
// is UNWIRED. There is no migration in this slice and no column to write to, so
// nothing here is bound to a server action yet — binding is WAIT-04B, after the
// DB authority exists. Shipping the contract first is what lets the DB work be
// reviewed against a settled shape instead of inventing one under time
// pressure.
//
// ---------------------------------------------------------------------------
// THE ONE RULE THAT SHAPES EVERYTHING BELOW: DO NOT FAKE COMPLETENESS
// ---------------------------------------------------------------------------
//
// Real entries already exist, with one combined name, an email, and nothing
// else. Every convenient way to make those look complete is a lie:
//
//   * splitting "Sarah Jones" on whitespace into first + last. It is not a
//     parse, it is a guess, and it is wrong for every mononym, every double
//     -barrelled surname, every name whose family part comes first, and every
//     person who entered "Sarah J". It also silently converts "we never asked"
//     into "they told us", which is unrecoverable once stored.
//   * defaulting availability to `both`. "Any time suits me" is a strong claim
//     that produces a real offer at a real hour someone may not be able to make.
//   * treating a held phone number as reachable. See
//     `lib/waitlist/prospect-sms-consent.ts`.
//   * inferring an area from anything.
//
// So absence is modelled as absence. `assessProfileCompleteness` reads a stored
// row and returns PROFILE_INCOMPLETE with the fields that are genuinely
// missing, and no code path anywhere fills one in.
//
// ---------------------------------------------------------------------------
// WHAT INCOMPLETE COSTS, AND WHAT IT DOES NOT
// ---------------------------------------------------------------------------
//
// It does NOT cost queue position. Someone joined when they joined; asking a
// new question later is Hone changing its mind, and moving them down the queue
// for answering it would be a penalty for our own change. `joined_at` is
// therefore not a member of `ProfileCompletionPatch` AT ALL — the type has no
// limb to write it through, so no completion path can move it by accident and
// no reviewer has to check that it did not.
//
// It DOES cost eligibility for a new Invite-to-book. An invitation names a
// service, a date window and a set of weekdays; issuing one to a prospect whose
// areas and availability are unknown means guessing on their behalf and then
// asking them to accept the guess. `invitationEligibility` refuses, and names
// the missing fields so an operator can see what to ask for rather than a bare
// "not eligible".
//
// ---------------------------------------------------------------------------
// VOCABULARY THAT MUST NOT DRIFT
// ---------------------------------------------------------------------------
//
// `AvailabilityPreference` here is `weekdays | weekends | both`, which is
// exactly migration 0193's
// `new_client_waitlist_entry_preferences_preference_check`, and exactly the
// union `lib/waitlist/preferences.ts` declares on the WAIT-ADMIT-01 branch.
// That module is NOT importable here: this slice is based on production, where
// it does not exist, and importing across an unmerged branch is how two
// branches become one merge conflict.
//
// So it is RESTATED, and `tests/lib/waitlist/join-profile.test.ts` pins the
// three literals against 0193's CHECK constraint wording. WHEN WAIT-ADMIT-01
// LANDS, THIS TYPE MUST BE DELETED AND RE-EXPORTED FROM
// `lib/waitlist/preferences.ts` — one vocabulary, one file. The test names that
// obligation so it is not discovered by drift.
// ===========================================================================

import {
  isTreatmentAreaId,
  parseTreatmentAreaIds,
  type TreatmentAreaId,
} from "@/lib/waitlist/treatment-area-catalog";

// --- 1. AVAILABILITY -------------------------------------------------------

/** Structured only. There is no free-text availability limb and never will be. */
export const AVAILABILITY_PREFERENCES = ["weekdays", "weekends", "both"] as const;

export type AvailabilityPreference = (typeof AVAILABILITY_PREFERENCES)[number];

/** What a prospect reads. Plain hours, no jargon, no promise about response time. */
export const AVAILABILITY_PREFERENCE_LABEL: Readonly<
  Record<AvailabilityPreference, string>
> = {
  weekdays: "Weekdays",
  weekends: "Weekends",
  both: "Weekdays or weekends",
};

export const AVAILABILITY_PREFERENCE_HELP: Readonly<
  Record<AvailabilityPreference, string>
> = {
  weekdays: "Monday to Friday.",
  weekends: "Saturday and Sunday.",
  both: "Either suits me.",
};

export function isAvailabilityPreference(
  value: unknown,
): value is AvailabilityPreference {
  return (
    typeof value === "string" &&
    (AVAILABILITY_PREFERENCES as ReadonlyArray<string>).includes(value)
  );
}

// --- 2. BOUNDS -------------------------------------------------------------
//
// Public unauthenticated surface: every string is length-capped before it can
// reach a lookup, a limiter or a template. `WAITLIST_NAME_MAX` on the shipped
// form is 120 for ONE combined name; splitting into two fields keeps the same
// total budget rather than doubling it.

export const PROFILE_FIRST_NAME_MAX = 60;
export const PROFILE_LAST_NAME_MAX = 60;
/** RFC 5321 practical address ceiling — same value the shipped form uses. */
export const PROFILE_EMAIL_MAX = 254;
/** Same ceiling as the shipped optional phone field. */
export const PROFILE_MOBILE_MAX = 40;

/**
 * Minimum digits for a mobile to be plausibly dialable.
 *
 * NOT a validity check and NOT a normalisation. The shipped waitlist path
 * deliberately stores a phone as a plain contact string — no E.164 coercion, no
 * dedupe, no match against `clients` — because V1 claims no identity, and this
 * slice does not change that ruling. What making the field REQUIRED does change
 * is that "" and "n/a" can no longer pass as an answer, so the bar is: enough
 * digits that this is an attempt at a phone number. Seven is the shortest
 * subscriber number in general use.
 */
export const PROFILE_MOBILE_MIN_DIGITS = 7;

/** Same conservative shape the rest of the project uses for public email input. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DIGITS_RE = /\d/g;

function digitCount(value: string): number {
  return (value.match(DIGITS_RE) ?? []).length;
}

// --- 3. THE PROFILE --------------------------------------------------------

/**
 * A COMPLETE prospect profile.
 *
 * Every limb is non-optional and non-nullable. That is the point: this type is
 * only constructible by passing validation, so holding one IS the proof the
 * profile is complete. Anything partial is `StoredWaitlistProfile` below, which
 * is a different type — the two cannot be confused at a call site.
 */
export type WaitlistJoinProfile = {
  firstName: string;
  lastName: string;
  /** Trimmed + lowercased. The only representation this feature stores or sends. */
  email: string;
  /** Verbatim contact string, trimmed. Never coerced to E.164. */
  mobile: string;
  /** At least one, catalog-ordered, duplicate-free. */
  treatmentAreaIds: ReadonlyArray<TreatmentAreaId>;
  availabilityPreference: AvailabilityPreference;
  /**
   * Explicit, unticked by default. NOT part of completeness — see
   * `REQUIRED_PROFILE_FIELDS`. A prospect who declines is fully joined and is
   * contacted by email.
   */
  smsOperationalConsent: boolean;
};

export type ProfileField =
  | "firstName"
  | "lastName"
  | "email"
  | "mobile"
  | "treatmentAreaIds"
  | "availabilityPreference";

/**
 * The fields completion requires.
 *
 * `smsOperationalConsent` is DELIBERATELY ABSENT. A consent that must be given
 * before the person can proceed is not a consent, it is a toll; and an
 * incomplete-profile gate built on it would block invitations for someone whose
 * only "omission" was declining to be texted. Every other field is required
 * because an invitation cannot be composed without it.
 */
export const REQUIRED_PROFILE_FIELDS: ReadonlyArray<ProfileField> = [
  "firstName",
  "lastName",
  "email",
  "mobile",
  "treatmentAreaIds",
  "availabilityPreference",
];

// --- 4. VALIDATION ---------------------------------------------------------

export type ProfileFieldErrors = Partial<Record<ProfileField, string>>;

export type ProfileValidation =
  | { ok: true; value: WaitlistJoinProfile }
  | { ok: false; errors: ProfileFieldErrors };

/** Untrusted input, exactly as a form or a FormData read hands it over. */
export type RawJoinProfileInput = {
  firstName: unknown;
  lastName: unknown;
  email: unknown;
  mobile: unknown;
  treatmentAreaIds: unknown;
  availabilityPreference: unknown;
  smsOperationalConsent: unknown;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validate a submitted profile.
 *
 * REPORTS EVERY FAILING FIELD, not the first one. A form that reveals one
 * problem per round trip makes a six-field submission a six-attempt task, and
 * the fields here are independent so there is no ordering reason to stop early.
 *
 * The treatment-area limb delegates ENTIRELY to `parseTreatmentAreaIds`, which
 * is the only thing in the codebase that can turn a string into a
 * `TreatmentAreaId`. There is no second, more permissive path here and no
 * free-text fallback for it to fall into: an unrecognised area refuses the
 * submission rather than being dropped from it.
 */
export function validateWaitlistJoinProfile(
  raw: RawJoinProfileInput,
): ProfileValidation {
  const errors: ProfileFieldErrors = {};

  const firstName = asString(raw.firstName);
  if (firstName.length === 0) {
    errors.firstName = "Enter your first name.";
  } else if (firstName.length > PROFILE_FIRST_NAME_MAX) {
    errors.firstName = "Please shorten your first name.";
  }

  const lastName = asString(raw.lastName);
  if (lastName.length === 0) {
    errors.lastName = "Enter your last name.";
  } else if (lastName.length > PROFILE_LAST_NAME_MAX) {
    errors.lastName = "Please shorten your last name.";
  }

  const email = asString(raw.email).toLowerCase();
  if (email.length === 0 || email.length > PROFILE_EMAIL_MAX || !EMAIL_RE.test(email)) {
    errors.email = "Enter a valid email address.";
  }

  const mobile = asString(raw.mobile);
  if (mobile.length === 0) {
    errors.mobile = "Enter a mobile number.";
  } else if (mobile.length > PROFILE_MOBILE_MAX) {
    errors.mobile = "Please shorten your mobile number.";
  } else if (digitCount(mobile) < PROFILE_MOBILE_MIN_DIGITS) {
    errors.mobile = "Enter a mobile number we can reach you on.";
  }

  const areas = parseTreatmentAreaIds(raw.treatmentAreaIds);
  if (!areas.ok) {
    errors.treatmentAreaIds =
      areas.code === "empty_selection" || areas.code === "not_an_array"
        ? "Choose at least one area."
        : // An unknown id cannot come from the picker, which renders the catalog
          // and nothing else. Reaching here means a forged or stale submission,
          // and the copy says what to do rather than what went wrong.
          "Choose your areas from the list.";
  }

  const availabilityPreference = raw.availabilityPreference;
  if (!isAvailabilityPreference(availabilityPreference)) {
    errors.availabilityPreference = "Choose when you're generally available.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      firstName,
      lastName,
      email,
      mobile,
      // Non-null assertions are avoided: both were proven above, and narrowing
      // is re-established by the guards rather than asserted away.
      treatmentAreaIds: areas.ok ? areas.value : [],
      availabilityPreference: isAvailabilityPreference(availabilityPreference)
        ? availabilityPreference
        : "both",
      smsOperationalConsent: raw.smsOperationalConsent === true,
    },
  };
}

// --- 5. COMPLETENESS OVER A STORED ROW -------------------------------------

/**
 * A profile as it may actually exist today.
 *
 * Every WAIT-04A field is optional and nullable, because for a legacy entry
 * every one of them genuinely is absent. `legacyName` is the single combined
 * name those rows carry; it is READ and DISPLAYED and never parsed into
 * `firstName`/`lastName`.
 */
export type StoredWaitlistProfile = {
  legacyName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  /**
   * The number on file. Its PRESENCE says someone typed it; it says nothing
   * about whether it reaches them. See `mobileVerifiedAt`.
   */
  mobile?: string | null;
  /**
   * When the number was proven to reach this person, or `null`.
   *
   * SEPARATE FROM THE NUMBER ITSELF, because "we hold a string" and "texts sent
   * there arrive with the right person" are different facts and only the second
   * one may authorise a send. A single `mobile` column would collapse them and
   * a bearer-supplied candidate would be indistinguishable from a proven
   * destination the moment it was written.
   *
   * WAIT-04A never sets this — there is no verification mechanism in this slice
   * and inventing a value would be the exact fake-completeness this module
   * refuses. It is `null` for every existing entry, which is the truth.
   */
  mobileVerifiedAt?: string | null;
  treatmentAreaIds?: ReadonlyArray<string> | null;
  availabilityPreference?: string | null;
};

/**
 * Is there a number on file AT ALL?
 *
 * PRESENCE, NOT VALIDITY — and the distinction is load-bearing, because this
 * function is the gate that decides whether a bearer completion may write a
 * mobile. An earlier revision asked the VALIDITY question here (length bound
 * plus a digit-count floor, the same checks completeness uses), and the effect
 * was a bypass of the immutability rule it exists to enforce:
 *
 *     stored "n/a"  -> not valid -> read as ABSENT -> patch takes the
 *     candidate arm -> a bearer link overwrites a number the studio already had.
 *
 * Those are ordinary legacy values — an imported "n/a" or "ask", a landline
 * typed short, an over-long paste — not exotic ones. So the question this asks
 * is the narrow one its name promises: is the column non-empty. A junk value is
 * still a value somebody entered, and replacing it is the studio's decision, not
 * a link-holder's.
 *
 * WHAT VALIDITY STILL GOVERNS, ELSEWHERE: `assessProfileCompleteness` keeps the
 * strict checks, so an entry holding "n/a" is INCOMPLETE and is not invitable.
 * The two questions have different answers on the same row, on purpose — the
 * prospect is told to contact the studio, which is the same route a wrong email
 * takes.
 */
export function storedMobilePresent(stored: StoredWaitlistProfile): boolean {
  return typeof stored.mobile === "string" && stored.mobile.trim().length > 0;
}

/**
 * What we actually know about reaching this person by phone.
 *
 *   absent    - no number at all. A completion may collect a candidate.
 *   candidate - a number someone typed. NOT an authenticated destination.
 *   verified  - proven to reach them. The only standing that may authorise SMS.
 *
 * THE MIDDLE STATE IS THE POINT. Without it a candidate and a verified number
 * are the same column, and "we have their mobile" quietly becomes "we may text
 * their mobile" — which is how a bearer link redirects a studio's texts.
 */
export type MobileStanding = "absent" | "candidate" | "verified";

export function mobileStanding(stored: StoredWaitlistProfile): MobileStanding {
  if (!storedMobilePresent(stored)) return "absent";
  const verifiedAt = stored.mobileVerifiedAt;
  return typeof verifiedAt === "string" && verifiedAt.trim().length > 0
    ? "verified"
    : "candidate";
}

/** True only for a number proven to reach this person. */
export function mobileIsVerified(stored: StoredWaitlistProfile): boolean {
  return mobileStanding(stored) === "verified";
}

export const PROFILE_COMPLETE = "PROFILE_COMPLETE" as const;
export const PROFILE_INCOMPLETE = "PROFILE_INCOMPLETE" as const;

export type ProfileCompleteness =
  | { status: typeof PROFILE_COMPLETE }
  | { status: typeof PROFILE_INCOMPLETE; missing: ReadonlyArray<ProfileField> };

function presentString(value: string | null | undefined, max: number): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

/**
 * Which required fields does this stored row actually have?
 *
 * FIELD PRESENCE ONLY, evaluated field by field. A stored area list is complete
 * when it is non-empty AND every member is a catalog id — a row holding a
 * retired or hand-written area is INCOMPLETE, not "complete with an odd value",
 * because an invitation composed from it would be composed from something the
 * studio does not offer.
 *
 * `legacyName` is not consulted. It cannot satisfy `firstName` or `lastName`:
 * that is the whole point of keeping it in its own field.
 */
export function assessProfileCompleteness(
  stored: StoredWaitlistProfile,
): ProfileCompleteness {
  const missing: ProfileField[] = [];

  if (!presentString(stored.firstName, PROFILE_FIRST_NAME_MAX)) missing.push("firstName");
  if (!presentString(stored.lastName, PROFILE_LAST_NAME_MAX)) missing.push("lastName");
  if (!presentString(stored.email, PROFILE_EMAIL_MAX)) missing.push("email");
  if (
    !presentString(stored.mobile, PROFILE_MOBILE_MAX) ||
    digitCount(stored.mobile ?? "") < PROFILE_MOBILE_MIN_DIGITS
  ) {
    missing.push("mobile");
  }

  const areas = stored.treatmentAreaIds;
  if (!Array.isArray(areas) || areas.length === 0 || !areas.every(isTreatmentAreaId)) {
    missing.push("treatmentAreaIds");
  }

  if (!isAvailabilityPreference(stored.availabilityPreference)) {
    missing.push("availabilityPreference");
  }

  return missing.length === 0
    ? { status: PROFILE_COMPLETE }
    : { status: PROFILE_INCOMPLETE, missing };
}

export function isProfileComplete(stored: StoredWaitlistProfile): boolean {
  return assessProfileCompleteness(stored).status === PROFILE_COMPLETE;
}

/** How a prospect refers to themselves, from whatever the row actually holds. */
export function displayName(stored: StoredWaitlistProfile): string {
  const first = (stored.firstName ?? "").trim();
  const last = (stored.lastName ?? "").trim();
  if (first.length > 0 && last.length > 0) return `${first} ${last}`;
  // NOT a fallback that fabricates structure: the combined legacy name is
  // rendered exactly as it was given, unsplit.
  const legacy = (stored.legacyName ?? "").trim();
  if (legacy.length > 0) return legacy;
  return first.length > 0 ? first : last;
}

// --- 6. INVITE-TO-BOOK ELIGIBILITY -----------------------------------------

export type InvitationEligibility =
  | { eligible: true }
  | { eligible: false; reason: "profile_incomplete"; missing: ReadonlyArray<ProfileField> }
  | { eligible: false; reason: "mobile_unverified"; standing: MobileStanding };

/**
 * May this prospect be sent a NEW Invite-to-book?
 *
 * The gate is profile completeness and nothing else. It says nothing about
 * queue position, admission rounds, studio policy or whether an invitation is
 * already live — those are the admission authority's questions, and answering
 * them here would put a second, weaker copy of them on a surface that cannot
 * see the database.
 *
 * ONE DIRECTION ONLY. An incomplete profile blocks a NEW invitation. It does
 * not revoke a live one, does not expire anything, does not move the entry, and
 * does not touch `joined_at`.
 */
export function invitationEligibility(
  stored: StoredWaitlistProfile,
  /**
   * Does the invitation being considered need to reach them BY SMS?
   *
   * Defaults to false, because the shipped invitation is an email and most
   * callers are asking the older question. When true the bar rises: a number
   * someone typed is not a channel, so an unverified mobile FAILS CLOSED rather
   * than being tried and hoped for.
   */
  options: { requiresSms?: boolean } = {},
): InvitationEligibility {
  const completeness = assessProfileCompleteness(stored);
  if (completeness.status !== PROFILE_COMPLETE) {
    return {
      eligible: false,
      reason: "profile_incomplete",
      missing: completeness.missing,
    };
  }
  // ORDER MATTERS: completeness first, so "you never told us your areas" is
  // never reported as a phone problem. A complete profile with a candidate
  // number is a real, invitable prospect — by email.
  if (options.requiresSms === true && !mobileIsVerified(stored)) {
    return {
      eligible: false,
      reason: "mobile_unverified",
      standing: mobileStanding(stored),
    };
  }
  return { eligible: true };
}

// --- 7. COMPLETION PATCH ---------------------------------------------------

/**
 * What a completed profile writes.
 *
 * THERE IS NO `joinedAt` LIMB, AND THAT IS THE GUARANTEE. The requirement is
 * that completing a profile never moves someone's place in the queue; the
 * cheapest way to keep a promise like that is to make it unexpressible. A
 * future server binding that wanted to move `joined_at` could not do it through
 * this type, and a reviewer does not have to check that it did not.
 *
 * Nor is there an `entryId`: the patch is the FIELDS, and which entry they
 * belong to is the caller's authorisation problem, decided server-side from a
 * capability. Carrying an id in the payload would invite a client to name the
 * row it wants to write.
 *
 * AND THERE IS NO `email`, WHICH IS THE THIRD OMISSION AND THE SAME ARGUMENT.
 * The completion surface renders the address as TEXT with no form control, so a
 * person cannot change it — but a TYPE that still carried an email would let a
 * forged post present one, and a server binding reading the patch field-by-field
 * would have no reason to distrust it. The stored address is where every future
 * invitation goes, so a payload that can carry one is a redirect waiting for a
 * leaked link.
 *
 * The server already knows the address: it resolves the entry from the
 * capability, and the entry holds the email. Nothing is lost by omitting it, and
 * what is gained is that the dangerous write is unexpressible rather than merely
 * unreachable. Changing an address stays a support conversation with the studio.
 *
 * AND MOBILE IS A DESTINATION TOO — the finding this shape closes.
 * `email` was removed because it is where the INVITATION goes. `mobile` is where
 * the SMS goes, and a bearer link that could replace it would point the studio's
 * texts at whoever holds the link — worse when paired with a consent tick in the
 * same submission, which would arrive looking like agreement for the new number.
 *
 * It cannot simply be dropped the way `email` was, because the asymmetry is
 * real: every legacy entry already HAS an email, and none has a mobile. Removing
 * the field would break the one thing this surface exists to do.
 *
 * So the patch is a UNION on what the entry already holds:
 *
 *   mobile ON FILE  -> the patch carries NO mobile value at all. Replacement is
 *                      unexpressible, not merely refused.
 *   mobile ABSENT   -> the patch may carry a CANDIDATE, which is a number
 *                      someone typed and nothing more. It is not an
 *                      authenticated destination and this type never calls it
 *                      one; see `MobileStanding` and `prospectMayReceiveSms`.
 *
 * The server still checks the entry itself before applying either arm — a forged
 * post can always claim the wrong one — but the common, dangerous case is now
 * impossible to even say.
 *
 * Every field a prospect may legitimately change is here; the four that decide
 * WHO, WHERE and WHEN — `entryId`, `email`, `joinedAt`, and a stored `mobile` —
 * are absent or non-replaceable.
 */
type CompletionCore = {
  firstName: string;
  lastName: string;
  treatmentAreaIds: ReadonlyArray<TreatmentAreaId>;
  availabilityPreference: AvailabilityPreference;
};

export type ProfileCompletionPatch =
  | (CompletionCore & {
      /** The entry already holds a mobile. There is no field to change it with. */
      mobileDisposition: "unchanged";
    })
  | (CompletionCore & {
      /** The entry held none. This is a typed number, NOT a verified destination. */
      mobileDisposition: "candidate_supplied";
      mobileCandidate: string;
    });

/**
 * Project a validated profile into the patch.
 *
 * DELIBERATELY LOSSY, AND NOW IN TWO WAYS. The profile carries an email because
 * validation needs one (the completion draft seeds it from storage) and the
 * patch drops it. It carries a mobile for the same reason, and the patch drops
 * that too WHENEVER THE ENTRY ALREADY HAS ONE — which is what makes a
 * replacement unexpressible rather than merely unwritten.
 *
 * `stored` is required for exactly that decision. Passing the entry's own state
 * is what lets this pick an arm; a projection that could not see it would have
 * to trust the submission about which case it was in.
 */
export function completionPatchFromProfile(
  profile: WaitlistJoinProfile,
  stored: StoredWaitlistProfile,
): ProfileCompletionPatch {
  const core: CompletionCore = {
    firstName: profile.firstName,
    lastName: profile.lastName,
    treatmentAreaIds: profile.treatmentAreaIds,
    availabilityPreference: profile.availabilityPreference,
  };
  if (storedMobilePresent(stored)) return { ...core, mobileDisposition: "unchanged" };
  return {
    ...core,
    mobileDisposition: "candidate_supplied",
    mobileCandidate: profile.mobile,
  };
}

// --- 8. WHAT A WAIT-TIME ESTIMATOR WILL EVENTUALLY CONSUME ------------------

/**
 * The typed facts an estimator would need. NOT computed here, and NOT rendered.
 *
 * Emitting the shape now is what keeps the estimator from later inventing its
 * own vocabulary or, worse, reaching for a free-text urgency field. It is
 * SERVER-SIDE data: `joinedAt` and `aheadInQueue` exist so an operator-facing
 * or internal estimate can be computed, and rendering either to a prospect
 * would be the queue-number promise this product does not make.
 *
 * `aheadInQueue` is nullable because it is frequently unknowable — an entry
 * whose queue is being reordered, or one read outside a ranked query, has no
 * defensible count, and a `0` default would read as "you're next".
 */
export type WaitTimeEstimatorInput = {
  joinedAt: string;
  availabilityPreference: AvailabilityPreference;
  treatmentAreaIds: ReadonlyArray<TreatmentAreaId>;
  aheadInQueue: number | null;
};

/**
 * Build the estimator input, or refuse.
 *
 * Returns `null` for an incomplete profile rather than a partially-populated
 * object: an estimate computed from a guessed availability is worse than no
 * estimate, because it will be quoted back to someone.
 */
export function waitTimeEstimatorInput(
  stored: StoredWaitlistProfile,
  context: { joinedAt: string; aheadInQueue: number | null },
): WaitTimeEstimatorInput | null {
  const areas = stored.treatmentAreaIds;
  if (
    !isAvailabilityPreference(stored.availabilityPreference) ||
    !Array.isArray(areas) ||
    areas.length === 0 ||
    !areas.every(isTreatmentAreaId)
  ) {
    return null;
  }
  return {
    joinedAt: context.joinedAt,
    availabilityPreference: stored.availabilityPreference,
    treatmentAreaIds: areas,
    aheadInQueue: context.aheadInQueue,
  };
}

// --- 9. THE FORM'S OWN STATE ------------------------------------------------

/**
 * What the form holds while it is being filled in.
 *
 * DELIBERATELY DISTINCT FROM `WaitlistJoinProfile`. A half-typed email is a
 * string, an unanswered availability question is `null`, and neither is a
 * profile. Keeping the in-progress shape in its own type means the complete one
 * stays unconstructible except through validation, so no component can hold
 * something that merely looks finished.
 *
 * Text fields are strings rather than `string | null` because an input's value
 * is always a string; `""` is "not answered yet" and is exactly what the
 * required-field checks read.
 */
export type JoinProfileDraft = {
  firstName: string;
  lastName: string;
  email: string;
  mobile: string;
  treatmentAreaIds: ReadonlyArray<TreatmentAreaId>;
  /** `null` until answered. There is no default — see the fake-completeness rule. */
  availabilityPreference: AvailabilityPreference | null;
  smsOperationalConsent: boolean;
};

/** A blank draft. Availability is unanswered and consent is unticked. */
export function emptyJoinProfileDraft(): JoinProfileDraft {
  return {
    firstName: "",
    lastName: "",
    email: "",
    mobile: "",
    treatmentAreaIds: [],
    availabilityPreference: null,
    smsOperationalConsent: false,
  };
}

/**
 * Seed a completion draft from what a legacy row already holds.
 *
 * CARRIES ONLY WHAT IS GENUINELY THERE. A stored value that would not pass
 * completeness is not pre-filled — an area id the catalog no longer offers, or
 * a preference outside the vocabulary, is dropped rather than shown as the
 * person's own answer for them to accept by inertia.
 *
 * `legacyName` IS NOT SPLIT. Both name fields start empty, so a prospect types
 * their own first and last name rather than confirming our guess at them.
 */
export function completionDraftFromStored(
  stored: StoredWaitlistProfile,
): JoinProfileDraft {
  const areas = stored.treatmentAreaIds;
  const usableAreas: ReadonlyArray<TreatmentAreaId> =
    Array.isArray(areas) && areas.every(isTreatmentAreaId)
      ? (areas as ReadonlyArray<TreatmentAreaId>)
      : [];
  return {
    firstName: (stored.firstName ?? "").trim(),
    lastName: (stored.lastName ?? "").trim(),
    email: (stored.email ?? "").trim(),
    mobile: (stored.mobile ?? "").trim(),
    treatmentAreaIds: usableAreas,
    availabilityPreference: isAvailabilityPreference(stored.availabilityPreference)
      ? stored.availabilityPreference
      : null,
    // NEVER seeded from storage. Consent is an act, not a stored preference to
    // be re-presented as already given; a prospect completing their profile
    // agrees again or does not.
    smsOperationalConsent: false,
  };
}

/** Validate a draft. The one bridge from form state to the complete profile. */
export function validateJoinProfileDraft(
  draft: JoinProfileDraft,
): ProfileValidation {
  return validateWaitlistJoinProfile({
    firstName: draft.firstName,
    lastName: draft.lastName,
    email: draft.email,
    mobile: draft.mobile,
    treatmentAreaIds: draft.treatmentAreaIds,
    availabilityPreference: draft.availabilityPreference,
    smsOperationalConsent: draft.smsOperationalConsent,
  });
}

// --- 10. WHERE THIS PROFILE CAN EXIST AT ALL --------------------------------
//
// THE DURABLE CLARIFICATION. Consent — and every other WAIT-04A answer — lives
// on the waitlist ENTRY. There are two commit points behind one gate
// (app/book/[slug]/waitlist-actions.ts), chosen per studio by a server-only
// allowlist:
//
//   WAIT-02, DURABLE     `join_new_client_waitlist` writes one row. An entry
//                        exists. Fields have somewhere to live.
//   WAIT-01, NOTIFICATION  the studio is emailed and NOTHING is written. There
//                        is no entry, and there is no row on our side at all.
//
// Verified against the shipped action, not assumed: its durable branch makes
// exactly one `.rpc("join_new_client_waitlist", ...)` call, and its
// notification branch makes no database write of any kind.
//
// SO THIS PROFILE IS NOT COLLECTABLE ON THE NOTIFICATION PATH. Asking someone
// for their treatment areas, their availability and their permission to text
// them, and then storing none of it, is the same defect as splitting a legacy
// name: it converts "we never asked" into "they told us" while the answer goes
// nowhere. The SMS consent is the sharpest case — its label promises "Reply
// STOP at any time to opt out" against a record that will not exist.
//
// HOW THE CHOICE IS MADE WITHOUT LEAKING A SERVER FACT. The existing form
// states the rule this must not break: it "deliberately does not learn which
// path applies — that would put a server-only activation fact into the browser
// bundle for a caption." So the commit point is NEVER a prop on a client
// component and never gates a control inside one. The SERVER picks which form
// to render, exactly as it already picks between the booking flow and the
// waitlist form. A studio on WAIT-01 keeps the shipped name/email/optional-phone
// form, byte for byte.

/** Which commit point a studio is on. A READING of the existing allowlist. */
export type WaitlistCommitPoint = "durable_record" | "studio_notification";

/**
 * Derive the commit point from the shipped allowlist check.
 *
 * NOT A SECOND FLAG SYSTEM — the module that owns the question is explicit that
 * none should be added, and this adds none. It takes the boolean
 * `isNewClientWaitlistDurableEnabled(studio.slug)` already returns and gives it
 * a name, so call sites read as a fact about the studio rather than as an
 * anonymous boolean threaded through three layers.
 */
export function commitPointFromDurableFlag(durable: boolean): WaitlistCommitPoint {
  return durable ? "durable_record" : "studio_notification";
}

/**
 * May the WAIT-04A join experience be offered to this studio's visitors?
 *
 * SERVER-SIDE ONLY. The answer decides which component the server renders; it is
 * never handed to a client component, because the commit point is a server-only
 * activation fact.
 */
export function profileJoinIsSupported(commitPoint: WaitlistCommitPoint): boolean {
  return commitPoint === "durable_record";
}

// --- 11. CANDIDATE IS NOT A DESTINATION -------------------------------------
//
// THREE DISTINCT CONCEPTS, and the whole point is that a binder cannot collapse
// them by accident:
//
//   1. mobileCandidate         a syntactically valid number the prospect
//                              submitted. May arrive from the INITIAL PUBLIC
//                              JOIN or from a later completion. Not authority
//                              to send anything.
//   2. mobileVerified          possession proven by a future verification flow.
//                              THE operational SMS destination.
//   3. smsOperationalConsent   permission to receive operational SMS.
//                              Independent of verification.
//
// Sending requires verified AND consented AND not suppressed. Any two of the
// three is not enough, and the pair people reach for — candidate plus consent —
// is the one that reads most like permission and grants least.
//
// WHY THE JOIN FORM IS NOT AN EXCEPTION. The public join form proves no
// possession of the number typed into it. Treating a join-supplied mobile as
// verified would not remove the wrong-recipient defect, it would relocate it:
// anyone could enrol a victim's name and email against a phone they control.
// So a join-supplied number is a candidate exactly like a completion-supplied
// one, and this module has no path that produces a verified mobile at all.

/**
 * A number someone typed, carried as a value that CANNOT claim verification.
 *
 * `verifiedAt` is typed as the literal `null`, not `string | null`. That is the
 * enforcement: a `MobileCandidate` is unconstructible with an instant in it, so
 * a binding holding one cannot promote it to a destination by filling a field.
 * Promotion has to go through a verification flow that produces a different
 * value, which is a change a reviewer sees.
 */
export type MobileCandidate = {
  readonly value: string;
  readonly verifiedAt: null;
};

/** Wrap a submitted number as what it actually is. */
export function mobileCandidateFrom(value: string): MobileCandidate {
  return { value: value.trim(), verifiedAt: null };
}

/**
 * The candidate a public join produces.
 *
 * Exists so the join path states its own standing rather than handing a bare
 * string to a binder that must remember what it means. `WaitlistJoinProfile`
 * keeps `mobile` as a plain string because that is what a form field holds;
 * this is the projection that names it.
 */
export function joinMobileCandidate(profile: WaitlistJoinProfile): MobileCandidate {
  return mobileCandidateFrom(profile.mobile);
}

/**
 * The one shape that may ever receive operational SMS.
 *
 * Stated as a single predicate so the three-way rule lives in ONE place and a
 * caller cannot satisfy two limbs and assume the third. It mirrors
 * `prospectMayReceiveSms` exactly — that function decides over a stored SMS
 * record, this one over a profile — and the truth table test walks all eight
 * combinations to prove only one is sendable.
 */
export function mobileIsSendable(input: {
  standing: MobileStanding;
  smsOperationalConsent: boolean;
  suppressed: boolean;
}): boolean {
  if (input.suppressed) return false;
  if (input.standing !== "verified") return false;
  return input.smsOperationalConsent;
}
