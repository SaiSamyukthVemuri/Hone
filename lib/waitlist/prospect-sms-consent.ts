// ===========================================================================
// WAIT-04A — OPERATIONAL SMS CONSENT FOR A WAITLIST PROSPECT
// ===========================================================================
//
// THE RULE THIS FILE EXISTS TO ENFORCE: HOLDING SOMEONE'S MOBILE NUMBER IS NOT
// PERMISSION TO TEXT IT.
//
// WAIT-04A makes mobile a REQUIRED join field, which is exactly the change that
// makes this file necessary. Before it, a waitlist prospect usually had no
// phone at all, so no one could act on the ambiguity. Now every prospect has
// one, and the only thing standing between "we have a number" and "we texted
// them" is a recorded, timestamped, sourced act of agreement.
//
// THE SHAPE IS NOT NEW, AND THAT IS DELIBERATE. `clients` already carries
// exactly this model — `sms_consent_at`, `sms_consent_source`,
// `sms_opted_out_at`, `sms_opt_out_source` — and `lib/sms/suppression.ts`
// already states the law over it:
//
//     honeSuppressionAllowsSend: if (opted_out) return false;
//                                return Boolean(consent_at);
//
// Consent is an INSTANT, not a boolean, because "when" is the auditable part; a
// bare `true` cannot be evidence of anything. Opt-out DOMINATES consent, and is
// phone-wide rather than studio-scoped (HONE_SUPPRESSION_SCOPE), because a
// person who says STOP is talking about their phone, not about one tenant's
// number. A prospect record gets the same shape so that the day a prospect
// becomes a client the two can be reconciled instead of translated.
//
// WHAT "OPERATIONAL" MEANS AND WHY IT IS THE ONLY THING ASKED FOR.
// One purpose, stated in the label the person reads: messages about THIS
// waitlist and the appointment offered from it. Not marketing, not campaigns,
// not "news and offers". A single-purpose consent can be honestly described in
// one sentence, which is what makes agreeing to it meaningful. Marketing
// consent is a SEPARATE, later, differently-worded question
// (`lib/booking/marketing-consent.ts` is the existing precedent) and this
// module deliberately provides no limb it could be smuggled into.
//
// DECLINING IS NOT A REFUSAL TO JOIN. A prospect who says no still joins, still
// holds their queue position, and is contacted by email. That is why the field
// is not part of profile completeness: consent that gates the only action on
// the page is not consent. See `lib/waitlist/join-profile.ts`.
//
// WHERE THE RECORD LIVES: ON THE WAITLIST ENTRY. Ruled 2026-09-08. Mobile is
// required at join, so the agreement is collected at join and belongs beside the
// person it is about — not deferred to a `clients` row that does not exist. The
// public waitlist action is explicit that it writes exactly one table and makes
// "no client, no appointment" writes, so there is no other row to put it on.
//
// ---------------------------------------------------------------------------
// THE OBLIGATION THAT RULING CREATES, AND WHICH WAIT-04B MUST DISCHARGE
// ---------------------------------------------------------------------------
//
// SMS_OPERATIONAL_CONSENT_LABEL promises "Reply STOP at any time to opt out".
// A control's label may only promise what its command delivers, and TODAY
// NOTHING DELIVERS THIS FOR A PROSPECT: app/api/twilio/inbound-sms/route.ts
// selects and stamps `.from("clients")` and nothing else, so an inbound STOP
// from someone who is only on a waitlist matches zero rows and suppresses
// nothing. Consent on the entry with no opt-out on the entry is a promise the
// system cannot keep.
//
// So the stored shape below carries the OPT-OUT limbs as well as the consent
// ones — all five columns, mirroring `clients` — and `prospectSuppressionCandidate`
// projects an entry into the EXACT `SuppressionCandidate` shape
// `selectHoneSuppressionTargets` already consumes. WAIT-04B therefore widens the
// existing phone-wide selector's candidate set to include waitlist entries
// rather than writing a second suppression rule that can drift from the first.
//
// That selector is deliberately studio-blind and sender-blind (see its own
// comment): STOP is phone-wide, because a person who says STOP is talking about
// their phone, not about one tenant's number. A prospect and a client sharing a
// number must both be stamped by one inbound message.
//
// UNTIL THAT LANDS, NOTHING MAY SEND. `prospectMayReceiveSms` is the only
// authorisation in this module and it already reads `sms_opted_out_at`; a
// binding that cannot write that column has not finished, and shipping a send
// path before it would make the label false.
//
// NO PROVIDER, NO DATABASE, NO SERVER-ONLY. Pure vocabulary and pure functions,
// so the form and a future server binding share one definition of what was
// agreed to. The one import from `lib/sms` is TYPE-ONLY, so this module stays
// client-safe and gains no runtime coupling.
// ===========================================================================

import type { SuppressionCandidate } from "@/lib/sms/suppression";
import type { WaitlistCommitPoint } from "@/lib/waitlist/join-profile";

/** Form field name. Named for what it grants, never "sms" or "phone" alone. */
export const SMS_OPERATIONAL_CONSENT_FIELD = "sms_operational_consent";

/**
 * Version of the WORDING agreed to.
 *
 * Consent is to a specific sentence. Re-wording what the box says produces a
 * new version, so a stored record always names the text the person actually
 * saw. Never re-point an existing version at different copy.
 */
export const SMS_OPERATIONAL_CONSENT_TEXT_VERSION = "waitlist_sms_operational_v1";

/**
 * The sentence beside the checkbox. Exported so the record, the tests and the
 * UI cannot state three different promises.
 *
 * Says WHO, WHAT FOR, and HOW TO STOP. Nothing about marketing, nothing about
 * frequency we cannot honour, and no suggestion that ticking it improves a
 * queue position.
 */
export const SMS_OPERATIONAL_CONSENT_LABEL =
  "Text me about this waitlist and any appointment offered from it. Reply STOP at any time to opt out.";

/**
 * What the person is told when they leave it unticked. Rendered as ordinary
 * help text, not as a warning: declining is a supported, complete outcome.
 */
export const SMS_OPERATIONAL_CONSENT_DECLINED_NOTE =
  "We'll email you instead. Your place on the waitlist is the same either way.";

/** Where an agreement was collected. Mirrors 0193's preference `source` vocabulary. */
export const SMS_CONSENT_SOURCES = [
  "public_form",
  "practitioner",
  "prospect_link",
] as const;

export type SmsConsentSource = (typeof SMS_CONSENT_SOURCES)[number];

export function isSmsConsentSource(value: unknown): value is SmsConsentSource {
  return (
    typeof value === "string" &&
    (SMS_CONSENT_SOURCES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * A checkbox reading.
 *
 * OPT-IN BY CONSTRUCTION: absent, null, "", "false", "off" and every unexpected
 * value are all `false`. Only the two strings a browser actually submits for a
 * ticked box are `true`. There is no default-on path and no coercion that could
 * invent one — `Boolean(value)` on a FormData entry would read the string
 * "false" as consent, which is the specific bug this narrow allowlist forecloses.
 */
export function parseSmsOperationalConsent(
  value: FormDataEntryValue | null | undefined,
): boolean {
  return value === "true" || value === "on";
}

/**
 * What is stored when someone agrees.
 *
 * `consentedAt` is an ISO instant supplied by the CALLER, which on the server
 * means the database's clock. There is no `new Date()` in this module: a
 * browser-supplied or module-captured time would be evidence of nothing.
 */
export type ProspectSmsConsentRecord = {
  /** The instant of agreement. `null` is "never agreed", never "declined at". */
  sms_consent_at: string | null;
  sms_consent_source: SmsConsentSource | null;
  sms_consent_text_version: string | null;
};

/** The record for someone who has not agreed. All three limbs null together. */
export const NO_SMS_CONSENT: ProspectSmsConsentRecord = {
  sms_consent_at: null,
  sms_consent_source: null,
  sms_consent_text_version: null,
};

/** Who ended it. Same vocabulary `clients.sms_opt_out_source` already uses. */
export const SMS_OPT_OUT_SOURCES = ["twilio_stop", "practitioner"] as const;

export type SmsOptOutSource = (typeof SMS_OPT_OUT_SOURCES)[number];

/**
 * The FULL stored shape on a waitlist entry: consent AND opt-out.
 *
 * WHY BOTH LIMBS LIVE IN ONE TYPE. `prospectMayReceiveSms` reads
 * `sms_opted_out_at`, so a stored record that carried only the consent columns
 * would be missing a field the authorisation decision depends on — the shape
 * would look complete while the decision could never be made correctly from it.
 * An earlier revision of this module had exactly that gap.
 *
 * Five columns, mirroring `clients`, so a prospect who later becomes a client
 * is a COPY rather than a translation, and no reconciliation step has to invent
 * a mapping between two consent models.
 */
export type ProspectSmsState = ProspectSmsConsentRecord & {
  sms_opted_out_at: string | null;
  sms_opt_out_source: SmsOptOutSource | null;
  /**
   * When the number was proven to reach this person, or `null`.
   *
   * THE THIRD INDEPENDENT FACT, and the one this file was missing. Consent
   * answers "may we", opt-out answers "have they since said no", and this
   * answers "does the number even reach them". All three are required for a
   * send and none substitutes for another.
   *
   * WAIT-04A never sets it. There is no verification mechanism in this slice.
   */
  mobile_verified_at: string | null;
};

/** Never agreed, never opted out, nothing verified. A new entry starts here. */
export const NO_SMS_STATE: ProspectSmsState = {
  ...NO_SMS_CONSENT,
  sms_opted_out_at: null,
  sms_opt_out_source: null,
  mobile_verified_at: null,
};

/**
 * Project a waitlist entry into the shape the EXISTING phone-wide STOP selector
 * already consumes.
 *
 * The return type is `SuppressionCandidate` from `lib/sms/suppression.ts`
 * itself, not a copy of its fields, so this cannot drift from what
 * `selectHoneSuppressionTargets` expects — a change there is a compile error
 * here. WAIT-04B feeds entries alongside clients through that one selector; it
 * must not write a second suppression rule, because two rules for one STOP is
 * how a person gets suppressed in one place and texted from the other.
 *
 * `studio_id` travels because the selector's result names rows to stamp, NOT
 * because studio scopes the decision — it explicitly does not.
 */
export function prospectSuppressionCandidate(entry: {
  id: string;
  studio_id: string;
  mobile: string | null;
  sms_opted_out_at: string | null;
}): SuppressionCandidate {
  return {
    id: entry.id,
    studio_id: entry.studio_id,
    // The selector's own field is `phone`; a waitlist entry calls it `mobile`.
    // Renamed here, at the boundary, rather than by naming the column `phone`
    // on a form whose label says "Mobile".
    phone: entry.mobile,
    sms_opted_out_at: entry.sms_opted_out_at,
  };
}

/**
 * Build the consent record.
 *
 * A DECLINE WRITES NULLS, NOT A TIMESTAMPED `false`. There is exactly one way
 * to represent "may we text this person": a non-null `sms_consent_at`. A
 * declined record that carried a "when they declined" instant in the same
 * column would be indistinguishable from agreement to any reader checking the
 * column for presence — which is precisely what `honeSuppressionAllowsSend`
 * does. Recording WHEN someone declined is a separate audit concern and does
 * not belong in the field that authorises sending.
 */
export function buildProspectSmsConsentRecord(input: {
  consented: boolean;
  source: SmsConsentSource;
  consentedAt: string;
  /**
   * THE DURABLE BACKSTOP. Consent lives on the waitlist entry, and an entry
   * only exists on the WAIT-02 durable path — the WAIT-01 notification path
   * emails the studio and writes nothing at all. A consent record built for a
   * submission that produces no row has nowhere to go, so this refuses to build
   * one rather than hand back columns nobody will store.
   *
   * The real protection is that the WAIT-04A join experience is not offered on
   * that path (`profileJoinIsSupported`); this is the second line, here because
   * the failure it prevents is silent. A caller that reached this function on
   * the notification path has a bug, and the safe answer to "may we text them"
   * when the evidence cannot be stored is no.
   */
  commitPoint: WaitlistCommitPoint;
}): ProspectSmsConsentRecord {
  if (!input.consented) return { ...NO_SMS_CONSENT };
  if (input.commitPoint !== "durable_record") return { ...NO_SMS_CONSENT };
  return {
    sms_consent_at: input.consentedAt,
    sms_consent_source: input.source,
    sms_consent_text_version: SMS_OPERATIONAL_CONSENT_TEXT_VERSION,
  };
}

/**
 * May this prospect be texted?
 *
 * The same law as `honeSuppressionAllowsSend` for clients, restated over a
 * prospect record so the answer cannot differ between the two. Opt-out
 * dominates: a person who replied STOP is not textable no matter what a consent
 * column says, because the STOP came later and means more.
 *
 * A PHONE NUMBER IS NOT AN ARGUMENT TO THIS FUNCTION. It cannot be: possession
 * is not part of the decision, so it is not part of the signature.
 */
export function prospectMayReceiveSms(record: {
  sms_consent_at: string | null;
  sms_opted_out_at: string | null;
  /**
   * REQUIRED, and required for a reason. Making it optional would let every
   * existing call site keep compiling while silently authorising sends to
   * unverified numbers — the precise failure this parameter exists to stop.
   */
  mobile_verified_at: string | null;
}): boolean {
  // 1. A person who said STOP is not textable, whatever else is true.
  if (record.sms_opted_out_at) return false;
  // 2. A NUMBER SOMEONE TYPED IS NOT A CHANNEL. A bearer completion link can
  //    supply a candidate; verification is what makes it a destination. Without
  //    this line, a candidate paired with a consent tick in the same submission
  //    would authorise texts to whoever holds the link.
  if (!record.mobile_verified_at) return false;
  // 3. And only then does consent decide.
  return Boolean(record.sms_consent_at);
}
