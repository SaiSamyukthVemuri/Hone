// ===========================================================================
// SMS-04 — THE PHONE NUMBER IS REQUIRED ON EVERY NEW PUBLIC WAITLIST SIGNUP
// ===========================================================================
//
// Name, email AND phone number are mandatory for a new public signup, whatever
// the person answers to the separate text question. A No still joins, with the
// same entry, the same emails and the same place in the queue; it only means
// no texts.
//
// ONE RULE, TWO PLACES. The public form checks this before it submits and the
// server action checks it again before any database call (lib/booking/
// new-client-waitlist.ts imports it), so they cannot disagree. The database
// command the action calls since 0210 refuses a missing or unusable number as
// well.
//
// THE EXISTING PHONE LAW, NOT A NEW ONE. "A usable number" is
// normalizePhoneForSms -- the sender's own rule, imported from the pure,
// browser-safe lib/sms/phone -- so every number accepted here is one an
// invitation or acknowledgement text could actually be sent to. No OTP: a
// number is never verified, and verification is not a gate (D4(2)).
//
// NEW SIGNUPS ONLY. Nothing here reads or changes an existing entry. People
// already on a waitlist with no phone stay valid exactly as they are, and the
// owner's own "Add someone to the waitlist" keeps its optional phone.
//
// PURE AND CLIENT-SAFE: no server-only import, no I/O.
// ===========================================================================

import { normalizePhoneForSms } from "@/lib/sms/phone";

/** Field ceiling, unchanged from the original optional field. */
export const WAITLIST_PHONE_MAX = 40;

/** The approved label (rendered with the same required marker as Name and Email). */
export const WAITLIST_PHONE_LABEL = "Phone number";

/** The approved help text under the field. */
export const WAITLIST_PHONE_HELP =
  "A phone number is required so we can contact you. Please check that this is your own number.";

/** Blank or whitespace only. */
export const WAITLIST_PHONE_REQUIRED = "Your phone number is required.";

/** Present, but not a number the sender could text. */
export const WAITLIST_PHONE_INVALID = "Enter a valid phone number.";

export const WAITLIST_PHONE_TOO_LONG = "Please shorten your phone number.";

/**
 * The visitor's own answer is required too: Yes or No, neither preselected.
 * Refused when absent rather than read as No. Safe to show verbatim -- it is
 * about the visitor's own form, decided before any lookup.
 */
export const NEW_CLIENT_WAITLIST_SMS_ANSWER_REQUIRED =
  "Please choose Yes or No for text messages.";

export type WaitlistPhoneCheck =
  | { ok: true; phone: string }
  | { ok: false; error: string };

/**
 * The trimmed number as typed (stored as typed; normalised only at send), or
 * the reason it is refused: blank or whitespace-only, too long, or not a
 * number normalizePhoneForSms accepts.
 */
export function validateWaitlistPhone(raw: string | null | undefined): WaitlistPhoneCheck {
  const phone = (raw ?? "").trim();
  if (phone.length === 0) return { ok: false, error: WAITLIST_PHONE_REQUIRED };
  if (phone.length > WAITLIST_PHONE_MAX) return { ok: false, error: WAITLIST_PHONE_TOO_LONG };
  if (normalizePhoneForSms(phone) === null) return { ok: false, error: WAITLIST_PHONE_INVALID };
  return { ok: true, phone };
}
