import { describe, expect, it } from "vitest";
import { selectHoneSuppressionTargets } from "@/lib/sms/suppression";

/** A number already proven to reach the person, so tests below isolate consent. */
const VERIFIED = "2026-09-01T00:00:00.000Z";
import {
  commitPointFromDurableFlag,
  profileJoinIsSupported,
} from "@/lib/waitlist/join-profile";
import {
  NO_SMS_CONSENT,
  NO_SMS_STATE,
  SMS_CONSENT_SOURCES,
  SMS_OPT_OUT_SOURCES,
  prospectSuppressionCandidate,
  SMS_OPERATIONAL_CONSENT_LABEL,
  SMS_OPERATIONAL_CONSENT_TEXT_VERSION,
  buildProspectSmsConsentRecord,
  isSmsConsentSource,
  parseSmsOperationalConsent,
  prospectMayReceiveSms,
  PRACTITIONER_CONSENT_FIELDS,
  PRACTITIONER_SMS_CONSENT_SCOPE,
  PRACTITIONER_SMS_CONSENT_SCOPES,
  SMS_CONSENT_ANSWER_FIELD,
  parsePractitionerSmsConsentInput,
  parseSmsConsentAnswer,
} from "@/lib/waitlist/prospect-sms-consent";

// WAIT-04A makes mobile REQUIRED, which is exactly the change that makes
// "we have a number" and "we may text it" easy to conflate. This file is the
// proof that they stay separate.

describe("possession is not consent", () => {
  it("the send decision does not take a phone number at all", () => {
    // Structural: a phone is not an argument, so it cannot be part of the
    // decision. Consent alone authorises.
    expect(prospectMayReceiveSms({ sms_consent_at: null, sms_opted_out_at: null, mobile_verified_at: VERIFIED })).toBe(
      false,
    );
    expect(
      prospectMayReceiveSms({
        sms_consent_at: "2026-09-08T10:00:00.000Z",
        sms_opted_out_at: null,
        mobile_verified_at: VERIFIED,
      }),
    ).toBe(true);
  });

  it("opt-out DOMINATES consent", () => {
    // Same law as lib/sms/suppression.ts honeSuppressionAllowsSend: a STOP came
    // later and means more than whatever a consent column says.
    expect(
      prospectMayReceiveSms({
        sms_consent_at: "2026-09-08T10:00:00.000Z",
        sms_opted_out_at: "2026-09-09T10:00:00.000Z",
        mobile_verified_at: VERIFIED,
      }),
    ).toBe(false);
    // Even an opt-out that PRE-dates the consent still blocks: this function
    // reads state, and re-consenting is an act that must clear the opt-out
    // explicitly rather than be inferred from two timestamps.
    expect(
      prospectMayReceiveSms({
        sms_consent_at: "2026-09-09T10:00:00.000Z",
        sms_opted_out_at: "2026-09-08T10:00:00.000Z",
        mobile_verified_at: VERIFIED,
      }),
    ).toBe(false);
  });
});

describe("the checkbox is opt-in, and narrowly parsed", () => {
  it("only the two strings a ticked box submits are consent", () => {
    expect(parseSmsOperationalConsent("true")).toBe(true);
    expect(parseSmsOperationalConsent("on")).toBe(true);
  });

  it("NEGATIVE CONTROL — every other value is a decline", () => {
    for (const value of [
      null,
      undefined,
      "",
      " ",
      "false", // Boolean("false") is TRUE — the specific bug this forecloses
      "off",
      "0",
      "1",
      "yes",
      "TRUE",
      "On",
    ]) {
      expect(parseSmsOperationalConsent(value)).toBe(false);
    }
  });
});

describe("what a decline stores", () => {
  it("writes nulls, never a timestamped false", () => {
    const declined = buildProspectSmsConsentRecord({
      consented: false,
      source: "public_form",
      consentedAt: "2026-09-08T10:00:00.000Z",
      commitPoint: "durable_record",
    });
    expect(declined).toEqual(NO_SMS_CONSENT);
    // The instant is NOT carried over into the column that authorises sending:
    // a reader checking for presence would read it as agreement.
    expect(declined.sms_consent_at).toBeNull();
    expect(prospectMayReceiveSms({ ...declined, sms_opted_out_at: null, mobile_verified_at: VERIFIED })).toBe(false);
  });

  it("all three limbs are null together", () => {
    const declined = buildProspectSmsConsentRecord({
      consented: false,
      source: "practitioner",
      consentedAt: "2026-09-08T10:00:00.000Z",
      commitPoint: "durable_record",
    });
    expect(declined.sms_consent_source).toBeNull();
    expect(declined.sms_consent_text_version).toBeNull();
  });
});

describe("what an agreement stores", () => {
  it("records the instant, the source and the WORDING agreed to", () => {
    const agreed = buildProspectSmsConsentRecord({
      consented: true,
      source: "public_form",
      consentedAt: "2026-09-08T10:00:00.000Z",
      commitPoint: "durable_record",
    });
    expect(agreed).toEqual({
      sms_consent_at: "2026-09-08T10:00:00.000Z",
      sms_consent_source: "public_form",
      sms_consent_text_version: SMS_OPERATIONAL_CONSENT_TEXT_VERSION,
    });
  });

  it("uses the caller's instant — this module reads no clock", () => {
    const a = buildProspectSmsConsentRecord({
      consented: true,
      source: "public_form",
      consentedAt: "2020-01-01T00:00:00.000Z",
      commitPoint: "durable_record",
    });
    // A module-captured or browser-supplied time would be evidence of nothing.
    expect(a.sms_consent_at).toBe("2020-01-01T00:00:00.000Z");
  });

  it("mirrors 0193's source vocabulary", () => {
    expect([...SMS_CONSENT_SOURCES]).toEqual([
      "public_form",
      "practitioner",
      "prospect_link",
    ]);
    for (const source of SMS_CONSENT_SOURCES) expect(isSmsConsentSource(source)).toBe(true);
    for (const bad of ["public_booking", "import", "", null, 1]) {
      expect(isSmsConsentSource(bad)).toBe(false);
    }
  });
});

describe("the wording the person agrees to", () => {
  it("names one purpose and the way out", () => {
    expect(SMS_OPERATIONAL_CONSENT_LABEL).toContain("this waitlist");
    expect(SMS_OPERATIONAL_CONSENT_LABEL).toContain("STOP");
  });

  it("promises nothing about marketing", () => {
    expect(SMS_OPERATIONAL_CONSENT_LABEL.toLowerCase()).not.toMatch(
      /marketing|offers|news|promotion/,
    );
  });

  it("the version names the wording, so re-wording is a new version", () => {
    expect(SMS_OPERATIONAL_CONSENT_TEXT_VERSION).toBe("waitlist_sms_operational_v1");
  });
});

describe("the label promises STOP, so the model must be able to honour it", () => {
  // waitlist-label-promise-rule: a control's label may only promise what its
  // command delivers. SMS_OPERATIONAL_CONSENT_LABEL says "Reply STOP at any
  // time to opt out", so an opt-out must be REPRESENTABLE on the entry — and
  // it must reach the one phone-wide selector that already exists, rather than
  // a second rule that can drift from it.

  it("the stored state carries opt-out and verification, not just consent", () => {
    // The gap this closes: prospectMayReceiveSms reads `sms_opted_out_at` AND
    // `mobile_verified_at`, so a record type missing either describes a shape
    // the decision cannot be made from.
    expect(Object.keys(NO_SMS_STATE).sort()).toEqual(
      [
        "sms_consent_at",
        "sms_consent_source",
        "sms_consent_text_version",
        "sms_opted_out_at",
        "sms_opt_out_source",
        "mobile_verified_at",
      ].sort(),
    );
  });

  it("a new entry starts unconsented, un-opted-out AND unverified", () => {
    expect(NO_SMS_STATE.sms_consent_at).toBeNull();
    expect(NO_SMS_STATE.sms_opted_out_at).toBeNull();
    expect(NO_SMS_STATE.mobile_verified_at).toBeNull();
    expect(prospectMayReceiveSms(NO_SMS_STATE)).toBe(false);
  });

  it("mirrors clients' opt-out vocabulary, so conversion is a copy not a mapping", () => {
    expect([...SMS_OPT_OUT_SOURCES]).toEqual(["twilio_stop", "practitioner"]);
  });

  it("an entry feeds the EXISTING phone-wide selector, unchanged", () => {
    const entry = {
      id: "entry-1",
      studio_id: "studio-1",
      mobile: "647-555-1234",
      sms_opted_out_at: null,
    };
    const selection = selectHoneSuppressionTargets({
      candidates: [prospectSuppressionCandidate(entry)],
      // Canonicalisation is the selector's job and it already does it: a stored
      // "647-555-1234" and an inbound "+16475551234" are the same person.
      fromPhone: "+16475551234",
    });
    expect(selection.targets).toEqual([{ id: "entry-1", studio_id: "studio-1" }]);
  });

  it("an already opted-out entry is counted, not re-stamped", () => {
    const selection = selectHoneSuppressionTargets({
      candidates: [
        prospectSuppressionCandidate({
          id: "entry-1",
          studio_id: "studio-1",
          mobile: "6475551234",
          sms_opted_out_at: "2026-09-08T10:00:00.000Z",
        }),
      ],
      fromPhone: "6475551234",
    });
    expect(selection.targets).toEqual([]);
    expect(selection.alreadyOptedOutCount).toBe(1);
  });

  it("NON-VACUITY — a different number selects nothing", () => {
    const selection = selectHoneSuppressionTargets({
      candidates: [
        prospectSuppressionCandidate({
          id: "entry-1",
          studio_id: "studio-1",
          mobile: "6475551234",
          sms_opted_out_at: null,
        }),
      ],
      fromPhone: "6475559999",
    });
    expect(selection.targets).toEqual([]);
  });

  it("a prospect with no mobile can never be selected", () => {
    const selection = selectHoneSuppressionTargets({
      candidates: [
        prospectSuppressionCandidate({
          id: "entry-1",
          studio_id: "studio-1",
          mobile: null,
          sms_opted_out_at: null,
        }),
      ],
      fromPhone: "6475551234",
    });
    expect(selection.targets).toEqual([]);
  });
});

describe("THE DURABLE CLARIFICATION — consent needs an entry to live on", () => {
  // Consent lives on the waitlist entry. An entry only exists on the WAIT-02
  // durable path; the WAIT-01 notification path emails the studio and writes
  // nothing at all. So a consent record built for a submission that produces no
  // row has nowhere to go.

  it("refuses to build a consent record on the notification path", () => {
    const onNotificationPath = buildProspectSmsConsentRecord({
      consented: true, // they DID tick the box...
      source: "public_form",
      consentedAt: "2026-09-08T10:00:00.000Z",
      commitPoint: "studio_notification", // ...but nothing will be stored
    });
    expect(onNotificationPath).toEqual(NO_SMS_CONSENT);
    expect(prospectMayReceiveSms({ ...onNotificationPath, sms_opted_out_at: null, mobile_verified_at: VERIFIED })).toBe(
      false,
    );
  });

  it("NON-VACUITY — the identical input on the durable path DOES record", () => {
    const onDurablePath = buildProspectSmsConsentRecord({
      consented: true,
      source: "public_form",
      consentedAt: "2026-09-08T10:00:00.000Z",
      commitPoint: "durable_record",
    });
    expect(onDurablePath.sms_consent_at).toBe("2026-09-08T10:00:00.000Z");
    expect(prospectMayReceiveSms({ ...onDurablePath, sms_opted_out_at: null, mobile_verified_at: VERIFIED })).toBe(true);
  });

  it("the join experience is only offered where a record exists", () => {
    expect(profileJoinIsSupported("durable_record")).toBe(true);
    expect(profileJoinIsSupported("studio_notification")).toBe(false);
  });

  it("the commit point is a READING of the shipped flag, not a new one", () => {
    // isNewClientWaitlistDurableEnabled(studio.slug) already answers this; the
    // helper only gives its boolean a name. No second flag system.
    expect(commitPointFromDurableFlag(true)).toBe("durable_record");
    expect(commitPointFromDurableFlag(false)).toBe("studio_notification");
  });

  it("refusing to store is FAIL-CLOSED, not a silent partial record", () => {
    // All five limbs null together: no half-written evidence of an agreement
    // that was never stored.
    const refused = buildProspectSmsConsentRecord({
      consented: true,
      source: "prospect_link",
      consentedAt: "2026-09-08T10:00:00.000Z",
      commitPoint: "studio_notification",
    });
    expect(refused.sms_consent_at).toBeNull();
    expect(refused.sms_consent_source).toBeNull();
    expect(refused.sms_consent_text_version).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 0208 — THE SIGNUP ANSWER, AND THE OWNER'S RECORD
// ---------------------------------------------------------------------------

describe("0208 — the signup answer is explicit, and only two values are answers", () => {
  it("reads exactly `yes` and `no`", () => {
    expect(SMS_CONSENT_ANSWER_FIELD).toBe("sms_consent_answer");
    expect(parseSmsConsentAnswer("yes")).toBe(true);
    expect(parseSmsConsentAnswer("no")).toBe(false);
  });

  it("everything else is NOT ANSWERED, never a silent No", () => {
    // `null` is what the server refuses. Reading any of these as false would
    // join someone on an answer they did not give, and as true would text them.
    for (const value of [null, undefined, "", " yes", "YES", "No", "on", "true", "1", "false"]) {
      expect(parseSmsConsentAnswer(value), String(value)).toBeNull();
    }
    expect(parseSmsConsentAnswer(new File(["yes"], "yes.txt"))).toBeNull();
  });
});

describe("0208 — an owner's record of consent given outside Hone", () => {
  const TODAY = "2026-10-09";
  const valid = {
    attest: "yes",
    evidence: "  Owner confirmation 2026-10-09: agreed in person at intake  ",
    dateKnown: "unknown",
    givenOn: null,
  };
  const parse = (over: Partial<Record<keyof typeof valid, FormDataEntryValue | null>>) =>
    parsePractitionerSmsConsentInput({ ...valid, ...over }, TODAY);

  it("ONE scope, the purpose the public sentence names", () => {
    expect(PRACTITIONER_SMS_CONSENT_SCOPES).toEqual(["waitlist_operational"]);
    expect(PRACTITIONER_SMS_CONSENT_SCOPE).toBe("waitlist_operational");
    expect(PRACTITIONER_CONSENT_FIELDS).toEqual({
      attest: "sms_consent_attest",
      evidence: "sms_consent_evidence_ref",
      dateKnown: "sms_consent_date_known",
      givenOn: "sms_consent_given_on",
    });
  });

  it("an unknown day is recorded as unknown: no date, never today's", () => {
    expect(parse({})).toEqual({
      ok: true,
      value: {
        scope: "waitlist_operational",
        evidenceRef: "Owner confirmation 2026-10-09: agreed in person at intake",
        consentDateKnown: false,
        consentGivenOn: null,
      },
    });
    // A stray day beside "unknown" is not quietly adopted.
    const stray = parse({ givenOn: "2026-03-01" });
    expect(stray.ok && stray.value.consentGivenOn).toBeNull();
  });

  it("a known day is preserved exactly, including today", () => {
    for (const day of ["2026-03-01", "2000-01-01", TODAY]) {
      const result = parse({ dateKnown: "known", givenOn: day });
      expect(result).toEqual({
        ok: true,
        value: expect.objectContaining({ consentDateKnown: true, consentGivenOn: day }),
      });
    }
  });

  it("the attestation must be ticked: nothing else counts", () => {
    for (const attest of [null, "", "on", "true", "YES"]) {
      const result = parse({ attest });
      expect(result.ok, String(attest)).toBe(false);
    }
    const missing = parse({ attest: null });
    expect(!missing.ok && missing.message).toMatch(/^Confirm the person agreed to texts about this waitlist/);
  });

  it("evidence is 3 to 200 characters on one line, after trimming", () => {
    for (const evidence of [null, "", "  ", "ab", " ab ", "x".repeat(201), "line one\nline two", "tab\there"]) {
      const result = parse({ evidence });
      expect(result.ok, JSON.stringify(evidence)).toBe(false);
      expect(!result.ok && result.message).toMatch(/evidence/);
    }
    expect(parse({ evidence: "abc" }).ok).toBe(true);
    expect(parse({ evidence: "x".repeat(200) }).ok).toBe(true);
  });

  it("the day question must be answered: no default either way", () => {
    for (const dateKnown of [null, "", "yes", "Known", "on"]) {
      const result = parse({ dateKnown });
      expect(result).toEqual({ ok: false, message: "Say whether you know the day they agreed." });
    }
  });

  it("a known day must be a real calendar day, not before 2000, not after the studio's today", () => {
    for (const givenOn of [null, "", "2026-02-30", "2026-13-01", "26-03-01", "2026/03/01", "yesterday"]) {
      expect(parse({ dateKnown: "known", givenOn })).toEqual({
        ok: false,
        message: "Enter the day they agreed, or choose that it is not known.",
      });
    }
    expect(parse({ dateKnown: "known", givenOn: "1999-12-31" })).toEqual({
      ok: false,
      message: "Enter a real day they agreed, from 2000 onward.",
    });
    expect(parse({ dateKnown: "known", givenOn: "2026-10-10" })).toEqual({
      ok: false,
      message: "The day they agreed can't be in the future.",
    });
  });

  it("the record never carries a wording version: the owner did not show one", () => {
    // 0208's shape: a practitioner record has no text_version. The parser has
    // no field that could carry one, so a form cannot smuggle one in.
    const result = parse({});
    expect(result.ok && Object.keys(result.value).sort()).toEqual(
      ["consentDateKnown", "consentGivenOn", "evidenceRef", "scope"],
    );
  });
});
