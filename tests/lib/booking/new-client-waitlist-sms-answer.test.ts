import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  NEW_CLIENT_WAITLIST_SMS_ANSWER_REQUIRED,
  NEW_CLIENT_WAITLIST_SMS_NEEDS_PHONE,
  WAITLIST_SMS_PHONE_MIN_DIGITS,
  validateWaitlistSmsAnswer,
} from "@/lib/booking/new-client-waitlist";

// ===========================================================================
// 0208 — THE SIGNUP'S SMS ANSWER, VALIDATED AGAINST ITS OWN SUBMISSION
// ===========================================================================
//
// `answer` is the PARSED radio: true, false, or null for "not answered". Not
// answered is refused, never read as No. A Yes needs a number to bind to, with
// the same floor the database command applies (0208,
// join_new_client_waitlist_with_sms_answer), so neither side accepts what the
// other refuses. A No needs nothing.

describe("validateWaitlistSmsAnswer", () => {
  it("not answered is refused, with or without a number", () => {
    for (const phone of [null, "", "+1 416 555 0100"]) {
      expect(validateWaitlistSmsAnswer({ answer: null, phone })).toEqual({
        ok: false,
        error: NEW_CLIENT_WAITLIST_SMS_ANSWER_REQUIRED,
      });
    }
  });

  it("No is accepted with no number at all: declining costs nothing else", () => {
    for (const phone of [null, "", "+1 416 555 0100"]) {
      expect(validateWaitlistSmsAnswer({ answer: false, phone })).toEqual({
        ok: true,
        smsConsent: false,
      });
    }
  });

  it("Yes needs a number with at least the database's digit floor", () => {
    expect(WAITLIST_SMS_PHONE_MIN_DIGITS).toBe(7);
    for (const phone of [null, "", "   ", "555-12", "phone", "(12) 34"]) {
      expect(validateWaitlistSmsAnswer({ answer: true, phone }), String(phone)).toEqual({
        ok: false,
        error: NEW_CLIENT_WAITLIST_SMS_NEEDS_PHONE,
      });
    }
    for (const phone of ["555 0142", "+1 (416) 555-0100", "4165550100"]) {
      expect(validateWaitlistSmsAnswer({ answer: true, phone }), phone).toEqual({
        ok: true,
        smsConsent: true,
      });
    }
  });

  it("the database applies the same floor, so the two cannot disagree", () => {
    const sql = readFileSync(
      path.resolve(
        __dirname,
        "../../../supabase/migrations/0208_waitlist_sms_consent_practitioner_and_signup_answer.sql",
      ),
      "utf8",
    );
    expect(sql).toContain(
      `length(regexp_replace(v_phone, '[^0-9]', '', 'g')) < ${WAITLIST_SMS_PHONE_MIN_DIGITS}`,
    );
  });

  it("the refusals speak about the form, never about the studio or the queue", () => {
    for (const copy of [NEW_CLIENT_WAITLIST_SMS_ANSWER_REQUIRED, NEW_CLIENT_WAITLIST_SMS_NEEDS_PHONE]) {
      expect(copy).not.toMatch(/full|capacity|queue|position|already|studio/i);
    }
  });
});
