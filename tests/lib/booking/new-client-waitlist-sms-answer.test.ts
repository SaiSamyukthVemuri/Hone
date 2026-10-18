import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  NEW_CLIENT_WAITLIST_SMS_ANSWER_REQUIRED,
  NEW_CLIENT_WAITLIST_SMS_NEEDS_PHONE,
  WAITLIST_SMS_PHONE_MIN_DIGITS,
  validateWaitlistSmsAnswer,
} from "@/lib/booking/new-client-waitlist";
import { normalizePhoneForSms } from "@/lib/sms/twilio";

// ===========================================================================
// 0208 — THE SIGNUP'S SMS ANSWER, VALIDATED AGAINST ITS OWN SUBMISSION
// ===========================================================================
//
// `answer` is the PARSED radio: true, false, or null for "not answered". Not
// answered is refused, never read as No. A Yes needs a number the SENDER can
// text: the invitation sender's own law, `normalizePhoneForSms` (Codex P2
// 4234615500). Consent on a number it refuses would settle every invitation
// `invalid_phone`. A No needs nothing, and joins exactly like a Yes.
//
// The database command (0208, join_new_client_waitlist_with_sms_answer) keeps
// its 7-digit floor as a backstop. The sender's law is stricter, so the
// database can never refuse a Yes this validator accepted.

const digits = (phone: string) => phone.replace(/\D/g, "");

describe("validateWaitlistSmsAnswer", () => {
  it("not answered is refused, with or without a number", () => {
    for (const phone of [null, "", "+1 416 555 0100"]) {
      expect(validateWaitlistSmsAnswer({ answer: null, phone })).toEqual({
        ok: false,
        error: NEW_CLIENT_WAITLIST_SMS_ANSWER_REQUIRED,
      });
    }
  });

  it("No is accepted with any number, or none: declining costs nothing else", () => {
    for (const phone of [null, "", "+1 416 555 0100", "555 0142", "phone"]) {
      expect(validateWaitlistSmsAnswer({ answer: false, phone }), String(phone)).toEqual({
        ok: true,
        smsConsent: false,
      });
    }
  });

  it("Yes is refused for a number the sender would refuse", () => {
    for (const phone of [
      null,
      "",
      "   ",
      "555-12",
      "phone",
      "(12) 34",
      "555 0142", // seven digits: the old floor accepted it
      "604 555 01", // nine digits
      "44 7700 900123", // twelve digits with no +
      "2 604 555 0199", // eleven digits not starting with 1
    ]) {
      expect(normalizePhoneForSms(phone), `precondition: the sender refuses ${phone}`).toBeNull();
      expect(validateWaitlistSmsAnswer({ answer: true, phone }), String(phone)).toEqual({
        ok: false,
        error: NEW_CLIENT_WAITLIST_SMS_NEEDS_PHONE,
      });
    }
  });

  it("Yes is accepted for a number the sender can text", () => {
    for (const phone of ["+1 (416) 555-0100", "4165550100", "1 604 555 0199", "604-555-0199", "+44 7700 900123"]) {
      expect(normalizePhoneForSms(phone), `precondition: the sender accepts ${phone}`).not.toBeNull();
      expect(validateWaitlistSmsAnswer({ answer: true, phone }), phone).toEqual({
        ok: true,
        smsConsent: true,
      });
    }
  });

  it("the database's floor stays a backstop that every accepted Yes clears", () => {
    const sql = readFileSync(
      path.resolve(
        __dirname,
        "../../../supabase/migrations/0208_waitlist_sms_consent_practitioner_and_signup_answer.sql",
      ),
      "utf8",
    );
    expect(WAITLIST_SMS_PHONE_MIN_DIGITS).toBe(7);
    expect(sql).toContain(
      `length(regexp_replace(v_phone, '[^0-9]', '', 'g')) < ${WAITLIST_SMS_PHONE_MIN_DIGITS}`,
    );
    // Every number the sender's law accepts has at least the database's floor
    // of digits, so the database never refuses a Yes the form accepted.
    for (let length = 1; length <= 16; length += 1) {
      for (const prefix of ["", "+", "1", "+1"]) {
        const phone = `${prefix}${"2".repeat(length)}`;
        if (normalizePhoneForSms(phone) !== null) {
          expect(digits(phone).length, phone).toBeGreaterThanOrEqual(WAITLIST_SMS_PHONE_MIN_DIGITS);
        }
      }
    }
  });

  it("the refusals speak about the form, never about the studio or the queue", () => {
    for (const copy of [NEW_CLIENT_WAITLIST_SMS_ANSWER_REQUIRED, NEW_CLIENT_WAITLIST_SMS_NEEDS_PHONE]) {
      expect(copy).not.toMatch(/full|capacity|queue|position|already|studio/i);
    }
  });
});
