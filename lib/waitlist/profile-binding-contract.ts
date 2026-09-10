// ===========================================================================
// WAIT-04B — THE SERVER BINDING THIS SLICE IS WAITING FOR
// ===========================================================================
//
// TYPES AND RULINGS ONLY. No implementation, no Supabase client, no `server-only`
// import, no RPC name, no SQL. `tests/lib/waitlist/profile-binding-contract.test.ts`
// proves this file writes nothing, so it cannot quietly become the binding it
// describes.
//
// It exists so the DB work is reviewed against a settled shape instead of
// inventing one under time pressure, and so the two surfaces WAIT-04A already
// ships (`WaitlistJoinForm`, `CompleteProfilePanel`) have exactly one thing to
// be wired to.
//
// ---------------------------------------------------------------------------
// PRECONDITION: THE DURABLE COMMIT POINT
// ---------------------------------------------------------------------------
//
// Everything below assumes an ENTRY ROW EXISTS. On the WAIT-01 notification
// path none does — the studio is emailed and nothing is written — so neither
// command may be offered there. `profileJoinIsSupported` is that gate and it is
// a SERVER decision: the commit point never becomes a prop on a client
// component. See lib/waitlist/join-profile.ts §10.
//
// ---------------------------------------------------------------------------
// WHAT THE PAYLOADS DELIBERATELY CANNOT SAY
// ---------------------------------------------------------------------------
//
// `ProfileCompletionPatch` omits `entryId`, `email` and `joinedAt`. Those three
// decide WHO is being written, WHERE the studio's next invitation is sent, and
// WHERE the person sits in the queue — none of which a public caller may
// influence. The omissions are structural rather than validated, so a binding
// cannot read a field that is not there and a reviewer does not have to check
// that it did not.
//
// The server therefore resolves all three ITSELF: the entry from the
// capability, the email from that entry, and `joined_at` by not touching it.
// ===========================================================================

import type {
  AvailabilityPreference,
  ProfileCompletionPatch,
  WaitlistJoinProfile,
  WaitlistCommitPoint,
} from "@/lib/waitlist/join-profile";
import type { MobileCandidate, MobileStanding } from "@/lib/waitlist/join-profile";
import type { SmsConsentSource } from "@/lib/waitlist/prospect-sms-consent";
import type { TreatmentAreaId } from "@/lib/waitlist/treatment-area-catalog";

// --- 1. WHAT A BOUND ADAPTER CAN DO ----------------------------------------

export type ProfileAdapterCapabilities = {
  /**
   * The entry row can store first/last name, mobile, areas and availability.
   * FALSE until WAIT-04B's columns exist — and while it is false the join
   * surface must not be offered, because the answers would be discarded.
   */
  storesProfileFields: boolean;
  /**
   * The entry row can store the six SMS columns AND an inbound STOP reaches
   * it. BOTH halves, deliberately: consent whose opt-out cannot be honoured is
   * a promise the label makes and the system breaks, so a binding that can
   * write `sms_consent_at` but not `sms_opted_out_at` must report FALSE here.
   */
  recordsSmsConsent: boolean;
  /**
   * A mobile can be PROVEN to reach the person, and `mobile_verified_at` is
   * written only by that proof.
   *
   * FALSE IN WAIT-04A AND IN WAIT-04B UNTIL A VERIFICATION MECHANISM EXISTS.
   * While it is false, `mobile_verified_at` is null for every entry and
   * `prospectMayReceiveSms` therefore refuses every send — which is the correct
   * standing behaviour, not a gap to work around.
   *
   * THE RULE THIS FLAG EXISTS TO MAKE UNMISSABLE: a binding may STORE a
   * candidate and may STORE a consent, and doing both still does not make a
   * destination. Writing `mobile_verified_at` from anything other than a
   * completed verification — from the candidate's own arrival, from a consent
   * tick, from an operator's assertion — reintroduces the redirect this whole
   * shape closes.
   */
  verifiesMobile: boolean;
  /** A capability grant can be issued and redeemed for the completion surface. */
  supportsCompletionCapability: boolean;
};

/** No adapter bound yet. WAIT-04A ships in exactly this state. */
export const NO_PROFILE_ADAPTER = null;

export type BoundProfileAdapter = WaitlistProfileAdapter | typeof NO_PROFILE_ADAPTER;

// --- 2. JOINING WITH A FULL PROFILE ----------------------------------------

export type JoinWithProfileInput = {
  /**
   * LOOKUP POINTER ONLY, exactly as the shipped action treats it. The studio id,
   * the commit point and whether the feature is on are all re-derived
   * server-side from the row this resolves to. A forged slug may only choose
   * WHICH studio is resolved; it can never become the identity used downstream.
   */
  studioSlug: string;
  /** Already validated. A raw draft may not reach a binding. */
  profile: WaitlistJoinProfile;
  /**
   * The mobile's standing, stated rather than inferred from the profile string.
   *
   * Its `verifiedAt` is the literal `null`, so a binder cannot receive a
   * join-supplied number that claims to be a destination.
   */
  mobileCandidate: MobileCandidate;
  /**
   * Where the agreement was collected. NOT read from the browser: the surface
   * that ran the collection knows which it was.
   */
  consentSource: SmsConsentSource;
};

/**
 * ONE SUCCESS SHAPE, AND THAT IS NOT A SIMPLIFICATION.
 *
 * The join surface is public and unauthenticated. The shipped action already
 * collapses `created` and `already_waiting` into an identical `{ ok: true }`
 * because distinguishing them is a MEMBERSHIP ORACLE: one request per address
 * tells an anonymous prober whether that named person asked this studio for
 * treatment, which for an electrolysis studio is exactly the sensitive fact.
 *
 * WAIT-04B must not widen this. A richer success value — "profile stored",
 * "consent recorded", an entry id — reintroduces the same disclosure, and the
 * per-IP and per-email limiters do not stop a single targeted probe.
 */
export type JoinOutcome = { ok: true } | { ok: false; error: string };

// --- 3. COMPLETING A LEGACY PROFILE ----------------------------------------

export type CompleteProfileInput = {
  /**
   * OPAQUE CAPABILITY. The only thing that names the entry.
   *
   * Never rendered, never logged, never put in an idempotency key, a rate-limit
   * key or an error string, and nothing derived from it either. The server hashes
   * it and looks the entry up; the caller never learns whether a given token
   * matched.
   */
  capabilityToken: string;
  /** No entryId, no email, no joinedAt — see the header. */
  patch: ProfileCompletionPatch;
  /**
   * Travels BESIDE the patch, never inside it. Consent is an act with its own
   * record; merging it into a profile write would let a field update imply an
   * agreement.
   */
  smsOperationalConsent: boolean;
  consentSource: SmsConsentSource;
};

/**
 * Refusals a completion may report.
 *
 * DELIBERATELY COARSE, and the surface renders ONE message for all of them. An
 * invalid token, a revoked grant, an expired grant and an already-completed
 * entry must be indistinguishable, or the page tells an anonymous holder which
 * it was — and "this token was valid but already used" is itself a disclosure
 * about a named person.
 *
 * The distinction is not lost, only moved: the server logs which occurred, in
 * the PII-free structured form the waitlist paths already use.
 */
export const COMPLETION_REFUSALS = [
  /** Token unusable for ANY reason. One code by design. */
  "not_authorized",
  /** The submission itself was malformed. Never reveals which field. */
  "invalid_submission",
  /** This studio is not on the durable commit point, so there is no row. */
  "unsupported_commit_point",
  /** Transient. The only refusal that invites a retry. */
  "unavailable",
] as const;

export type CompletionRefusal = (typeof COMPLETION_REFUSALS)[number];

export type CompletionOutcome =
  | { ok: true }
  | { ok: false; code: CompletionRefusal };

// --- 4. THE ADAPTER --------------------------------------------------------

export interface WaitlistProfileAdapter {
  readonly capabilities: ProfileAdapterCapabilities;

  /**
   * A new prospect joins with a full profile.
   *
   * REPLACES NOTHING. `join_new_client_waitlist` and its four-argument shape
   * stay exactly as they are for studios on the WAIT-01 path; this is the
   * durable path's richer entry point, and WAIT-04B decides whether that is a
   * widened command or a second one.
   *
   * `sms_consent_at` is stamped from the DATABASE clock inside the same
   * statement. There is no `consentedAt` parameter here on purpose: a
   * browser-supplied or server-process time is evidence of nothing, and the
   * agreement and its timestamp must commit together or not at all.
   *
   * THE MOBILE ARRIVES AS A CANDIDATE AND IS STORED AS ONE. The public join
   * form proves no possession of the number typed into it, so
   * `mobile_verified_at` MUST be written null here — exactly as it must be for a
   * completion-supplied candidate. Treating a join-supplied number as verified
   * would relocate the wrong-recipient defect to the join form rather than
   * remove it: anyone can enrol a victim's name and email against a phone they
   * control. `joinMobileCandidate` names the value's standing, and
   * `MobileCandidate.verifiedAt` is typed as the literal `null` so the promotion
   * cannot be expressed by filling a field.
   */
  joinWithProfile(input: JoinWithProfileInput): Promise<JoinOutcome>;

  /**
   * A legacy prospect completes the fields that did not exist when they joined.
   *
   * MUST NOT TOUCH `joined_at`. The patch has no limb for it, and the command
   * must not write one either — answering a question Hone added later cannot
   * cost someone their place. This is the single most important invariant in
   * the whole slice and it deserves its own DB test.
   *
   * Idempotent: submitting the same patch twice is one outcome, not a duplicate
   * and not an error. A person who taps twice on a slow connection has done
   * nothing wrong.
   */
  completeProfile(input: CompleteProfileInput): Promise<CompletionOutcome>;
}

// --- 5. WHAT WAIT-04B OWES, ENUMERATED -------------------------------------

/**
 * The checklist, in this file so it is reviewed with the shape rather than
 * remembered. Each line is a thing WAIT-04A cannot do and deliberately did not
 * fake.
 *
 *  1. COLUMNS on the entry: first_name, last_name, mobile, treatment_area_ids,
 *     availability_preference — plus the five SMS columns (consent_at,
 *     consent_source, consent_text_version, opted_out_at, opt_out_source).
 *     Existing rows get NULL, which reads as PROFILE_INCOMPLETE, which is the
 *     honest answer.
 *
 *  2. AVAILABILITY AUTHORITY. 0193's `new_client_waitlist_entry_preferences`
 *     is the real home for a stated preference. When WAIT-ADMIT-01 lands,
 *     delete this slice's `AvailabilityPreference` and re-export from
 *     lib/waitlist/preferences.ts — one vocabulary, one file.
 *
 *  3. COMPLETION CAPABILITY. 0193's `new_client_waitlist_preference_grants`
 *     (hashed token, TTL, redeemed/revoked) is what `capabilityToken` above
 *     resolves through. Do not mint a second grant type.
 *
 *  4. THE STOP PATH. app/api/twilio/inbound-sms/route.ts stamps `.from("clients")`
 *     and nothing else, so an inbound STOP from someone who is only on a
 *     waitlist suppresses nothing. Widen the EXISTING phone-wide selector's
 *     candidate set using `prospectSuppressionCandidate`; do not write a second
 *     suppression rule. UNTIL THIS LANDS, `recordsSmsConsent` is false and
 *     nothing may send.
 *
  5. TREATMENT AREAS are stored as catalog IDS, never labels. A label may be
 *     re-worded; an id may not be re-pointed.
 *
 *  5b. MOBILE VERIFICATION BEFORE ANY SMS DESTINATION. The completion patch is
 *     a union: an entry that HOLDS a mobile produces an `"unchanged"` patch with
 *     no mobile value in it at all, so replacement is unexpressible. An entry
 *     with none may produce `"candidate_supplied"`.
 *
 *     THE BINDING MUST DO THREE THINGS AND NOT A FOURTH.
 *       * Re-check the ENTRY before applying either arm. A forged post can
 *         always claim the wrong one; the type narrows the honest client, the
 *         server decides.
 *       * Refuse a `"candidate_supplied"` patch outright when the entry already
 *         holds a mobile. That is an attempted replacement, and it is the
 *         finding this section closes.
 *       * Write a candidate to `mobile` and LEAVE `mobile_verified_at` NULL.
 *       * And NOT write `mobile_verified_at` in the same statement, from the
 *         same submission, or on the strength of a consent tick. Nothing a
 *         bearer link supplies may verify itself.
 *
 *  5c. THE PRIVACY POLICY AND THE LIVE COLLECTION BECOME TRUE TOGETHER.
 *     The WAIT-04 join surface carries its own collection notice and links to
 *     `/privacy`, exactly as the shipped form does — that is #687's half, and it
 *     is done. What is NOT done, deliberately, is updating the live policy page.
 *
 *     WHY THE ORDER MATTERS IN BOTH DIRECTIONS. The component is dormant, so
 *     production collects none of these categories yet; a policy describing them
 *     today would claim a practice that does not exist. The moment WAIT-04B wires
 *     the surface, the reverse becomes true and the policy is understating what
 *     is collected. Neither state is acceptable for longer than one deploy, so
 *     the policy edit belongs in the SAME change that activates collection.
 *
 *     WHAT MUST BE DESCRIBED when it lands: treatment areas, availability
 *     preference, the mobile number, and the SMS-consent record (its instant,
 *     source and text version). `app/privacy/page.tsx` §6 already carries the
 *     waitlist distinction the shipped form relies on and is where this extends.
 *
 *  6. RE-VALIDATE SERVER-SIDE. The client validation is a courtesy that saves a
 *     round trip. `validateWaitlistJoinProfile` runs again on the server, and
 *     the database re-checks independently, exactly as the shipped join path
 *     already layers its bounded validation under an authoritative command.
 */
export const WAIT_04B_PREREQUISITES = [
  "profile_columns",
  "availability_authority_0193",
  "completion_capability_0193",
  "inbound_stop_reaches_entries",
  "areas_stored_as_ids",
  "mobile_verified_before_sms_destination",
  "privacy_policy_describes_activated_collection",
  "server_side_revalidation",
] as const;

export type Wait04bPrerequisite = (typeof WAIT_04B_PREREQUISITES)[number];

/**
 * Re-exported so a binding imports its vocabulary from one place rather than
 * reaching into three modules and risking a near-miss type.
 */
export type {
  AvailabilityPreference,
  MobileCandidate,
  MobileStanding,
  ProfileCompletionPatch,
  SmsConsentSource,
  TreatmentAreaId,
  WaitlistCommitPoint,
  WaitlistJoinProfile,
};
