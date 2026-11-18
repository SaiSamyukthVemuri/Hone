// The phone rules for the "None of these times work" response, as PURE functions: no I/O, no storage, no consent, no wording.
// Only the answers action's validation calls them today, and it stores nothing; a form is wired to them after the storage that holds a
// number is applied and read back. They carry no opt-in wording and no retention rule.
//
// ONE RULE, NOT A NEW COUNTRY RULE. A "valid number" is the sender's own rule (normalizePhoneForSms, through validateWaitlistPhone),
// so every number accepted here is one a text or call could reach. On top of that sits the SHAPE the stored column will hold:
//   contact_phone ~ '^\+[1-9][0-9]{7,14}$' and length(contact_phone) <= 16   (normalized E.164 only)
// which refuses a leading-zero country code that normalizePhoneForSms alone would pass.
//
// VALUE-FREE. No result, message or error here ever contains a digit of a number the person typed or that is on file, except the
// masked hint, which is the last PHONE_MASK_DIGITS digits of the on-file number and nothing else. Failures name a CLASS only.
import { normalizePhoneForSms } from "@/lib/sms/phone";
import {
  WAITLIST_PHONE_REQUIRED,
  WAITLIST_PHONE_TOO_LONG,
  validateWaitlistPhone,
} from "./signup-contact";

/** How many trailing digits the hint shows. One constant; only this line changes if the count is revised. */
export const PHONE_MASK_DIGITS = 4;

/** The stored shape (the column CHECK). */
export const CONTACT_PHONE_SHAPE = /^\+[1-9][0-9]{7,14}$/;
export const CONTACT_PHONE_MAX_LENGTH = 16;

export type ContactPhoneProblem = "required" | "invalid" | "too_long";
export type ContactPhoneCheck = { ok: true; e164: string } | { ok: false; problem: ContactPhoneProblem };

/** Value-free copy for each problem class. */
export const CONTACT_PHONE_PROBLEM_COPY: Record<ContactPhoneProblem, string> = {
  required: "Your phone number is required.",
  invalid: "Enter a valid phone number.",
  too_long: "Please shorten your phone number.",
};

/**
 * Only the characters people type around a number. Letters and an extension marker ("ext 99", "x99") are refused, because the
 * sender's digit extraction would fold an extension into the number itself.
 */
const PHONE_CHARS = /^[+\d\s().\-]+$/;

/** The normalized number if it is usable by the sender's rule AND has the stored shape; otherwise null. */
function usableE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (!PHONE_CHARS.test(trimmed)) return null;
  const e164 = normalizePhoneForSms(trimmed);
  if (e164 === null || e164.length > CONTACT_PHONE_MAX_LENGTH || !CONTACT_PHONE_SHAPE.test(e164)) return null;
  return e164;
}

/** A typed number: valid by the sender's rule, normalized, and in the stored E.164 shape. */
export function validateDeclineContactPhone(raw: unknown): ContactPhoneCheck {
  if (typeof raw !== "string") return { ok: false, problem: "required" };
  const check = validateWaitlistPhone(raw);
  if (!check.ok) {
    if (check.error === WAITLIST_PHONE_REQUIRED) return { ok: false, problem: "required" };
    if (check.error === WAITLIST_PHONE_TOO_LONG) return { ok: false, problem: "too_long" };
    return { ok: false, problem: "invalid" };
  }
  const e164 = usableE164(check.phone);
  return e164 === null ? { ok: false, problem: "invalid" } : { ok: true, e164 };
}

export type OnFileHint = { available: true; lastDigits: string } | { available: false };

/**
 * The server-built hint for the number already on the entry: only the last PHONE_MASK_DIGITS digits, from a number that is usable by
 * the same rule. Anything unusable (blank, malformed, not a number a text could reach) is "not available", so the form asks for a number
 * instead of confirming one the studio could not use. The full number is never part of the result.
 */
export function maskOnFilePhone(entryPhone: unknown): OnFileHint {
  if (typeof entryPhone !== "string") return { available: false };
  const e164 = usableE164(entryPhone);
  if (e164 === null) return { available: false };
  const digits = e164.replace(/\D/g, "");
  // Never show more than half of the digits: a 4-digit mask needs at least 8.
  if (digits.length < PHONE_MASK_DIGITS * 2) return { available: false };
  return { available: true, lastDigits: digits.slice(-PHONE_MASK_DIGITS) };
}

/** "the number ending 1234" for the form, or null when there is no usable number on file. */
export function onFileHintText(hint: OnFileHint): string | null {
  return hint.available ? `the number ending ${hint.lastDigits}` : null;
}

export type ContactChoiceInput = { useOnFile?: unknown; contactPhone?: unknown };
export type ContactChoice =
  | { ok: true; kind: "on_file" }
  | { ok: true; kind: "typed"; e164: string }
  | { ok: false; problem: ContactPhoneProblem | "choose_one" | "no_number_on_file" };

/**
 * The two shapes the later command accepts, decided here first so the form and the action agree with the stored column:
 *   - confirm the number on file (useOnFile === true, with a usable number on file) and type nothing; or
 *   - type a number (a different one, or one when none is on file) and do not confirm the one on file.
 * Both, or neither, is refused ("choose_one"); confirming when nothing usable is on file is refused ("no_number_on_file").
 * Only the literal true counts as confirming. A confirmed on-file number is never copied: the choice carries no number.
 */
export function resolveContactChoice(input: ContactChoiceInput, entryPhone: unknown): ContactChoice {
  const confirming = input.useOnFile === true;
  const typedRaw = typeof input.contactPhone === "string" ? input.contactPhone.trim() : "";
  const typing = typedRaw.length > 0;
  if (confirming && typing) return { ok: false, problem: "choose_one" };
  if (confirming) {
    return maskOnFilePhone(entryPhone).available ? { ok: true, kind: "on_file" } : { ok: false, problem: "no_number_on_file" };
  }
  if (!typing) {
    // Nothing typed and not confirmed: the person must do one of them.
    return { ok: false, problem: maskOnFilePhone(entryPhone).available ? "choose_one" : "required" };
  }
  const check = validateDeclineContactPhone(typedRaw);
  return check.ok ? { ok: true, kind: "typed", e164: check.e164 } : { ok: false, problem: check.problem };
}
