import { describe, expect, it } from "vitest";
import { confirmationSmsWillPass, passesConsentGate } from "@/lib/sms/consent-gate";
import type { SmsType } from "@/lib/types/database";

// The one gate every appointment text clears before a send is attempted. Pure; no provider, nothing is sent.
// Synthetic data only. A studio switch that is off, absent or null sends nothing, and each message type reads its OWN switch.

// 0368: a consent is bound to the number it was given for. The passing fixtures carry that number, equal to the phone the client holds.
const CONSENTED = { phone: "+14165550123", sms_consent_at: "2026-10-01T12:00:00Z", sms_consent_phone: "+14165550123", sms_opted_out_at: null };
const ALL_ON = { id: "studio", send_confirmation_sms: true, send_24h_sms_reminders: true, send_2h_sms_reminders: true };
const TYPES: SmsType[] = ["confirmation", "reminder_24h", "reminder_2h"];
const SWITCH: Record<string, "send_confirmation_sms" | "send_24h_sms_reminders" | "send_2h_sms_reminders"> = {
  confirmation: "send_confirmation_sms",
  reminder_24h: "send_24h_sms_reminders",
  reminder_2h: "send_2h_sms_reminders",
};

describe("passesConsentGate", () => {
  it.each(TYPES)("%s: switch on, consented, valid phone passes and returns the normalised number", (smsType) => {
    expect(passesConsentGate({ studio: ALL_ON, client: CONSENTED, smsType })).toEqual({ ok: true, normalizedPhone: "+14165550123" });
  });

  it.each(TYPES)("%s: sends nothing when its own switch is off, absent or null (fail closed)", (smsType) => {
    const key = SWITCH[smsType];
    for (const value of [false, undefined, null]) {
      const studio = { ...ALL_ON, [key]: value } as never;
      expect(passesConsentGate({ studio, client: CONSENTED, smsType })).toEqual({ ok: false, reason: "studio_toggle_off" });
    }
  });

  it.each(TYPES)("%s: reads only its own switch, the other two being on changes nothing", (smsType) => {
    const studio = { id: "studio", send_confirmation_sms: false, send_24h_sms_reminders: false, send_2h_sms_reminders: false, [SWITCH[smsType]]: true } as never;
    expect(passesConsentGate({ studio, client: CONSENTED, smsType }).ok).toBe(true);
    for (const other of TYPES.filter((t) => t !== smsType)) {
      expect(passesConsentGate({ studio, client: CONSENTED, smsType: other })).toEqual({ ok: false, reason: "studio_toggle_off" });
    }
  });

  it.each(TYPES)("%s: a client who opted out is never texted, even with consent on file", (smsType) => {
    const client = { ...CONSENTED, sms_opted_out_at: "2026-11-01T12:00:00Z" };
    expect(passesConsentGate({ studio: ALL_ON, client, smsType })).toEqual({ ok: false, reason: "client_opted_out" });
  });

  it.each(TYPES)("%s: no recorded consent means no text", (smsType) => {
    const client = { ...CONSENTED, sms_consent_at: null };
    expect(passesConsentGate({ studio: ALL_ON, client, smsType })).toEqual({ ok: false, reason: "client_no_consent" });
  });

  it("opt-out is reported ahead of missing consent", () => {
    const client = { phone: "+14165550123", sms_consent_at: null, sms_consent_phone: null, sms_opted_out_at: "2026-11-01T12:00:00Z" };
    expect(passesConsentGate({ studio: ALL_ON, client, smsType: "confirmation" })).toEqual({ ok: false, reason: "client_opted_out" });
  });

  it("a formatted number is normalised to the same E.164 form", () => {
    const client = { ...CONSENTED, phone: "(416) 555-0123" };
    expect(passesConsentGate({ studio: ALL_ON, client, smsType: "confirmation" })).toEqual({ ok: true, normalizedPhone: "+14165550123" });
  });

  it.each(TYPES)("%s: only a real true switch sends; a string, number or object in its place sends nothing", (smsType) => {
    const key = SWITCH[smsType];
    for (const value of ["true", "false", "yes", 1, {}, []]) {
      const studio = { ...ALL_ON, [key]: value } as never;
      expect(passesConsentGate({ studio, client: CONSENTED, smsType })).toEqual({ ok: false, reason: "studio_toggle_off" });
    }
  });

  it.each([null, "", "not a number", "123"])("an unusable phone (%j) is refused, not guessed", (phone) => {
    const client = { ...CONSENTED, phone };
    expect(passesConsentGate({ studio: ALL_ON, client, smsType: "reminder_24h" })).toEqual({ ok: false, reason: "invalid_phone" });
  });
  // 0368. A bound consent covers only the number it was given for. A legacy consent (no bound number, null) is allowed, as before,
  // until the client's number first changes. The gate does NOT refuse an unbound consent; it refuses a bound consent that no longer matches.
  it.each(TYPES)("%s: a legacy consent with no bound number still passes (allowed until the number is first changed)", (smsType) => {
    const client = { ...CONSENTED, sms_consent_phone: null };
    expect(passesConsentGate({ studio: ALL_ON, client, smsType })).toEqual({ ok: true, normalizedPhone: "+14165550123" });
  });

  it.each(TYPES)("%s: a consent bound to a different number does not authorize the number held now", (smsType) => {
    const client = { ...CONSENTED, sms_consent_phone: "+14165550999" };
    expect(passesConsentGate({ studio: ALL_ON, client, smsType })).toEqual({ ok: false, reason: "consent_for_other_number" });
  });

  it("a bound number is compared after the held phone is normalised", () => {
    const client = { ...CONSENTED, phone: "(416) 555-0123" };
    expect(passesConsentGate({ studio: ALL_ON, client, smsType: "confirmation" })).toEqual({ ok: true, normalizedPhone: "+14165550123" });
  });

  it("opt-out and missing consent are reported ahead of a number mismatch", () => {
    expect(passesConsentGate({ studio: ALL_ON, client: { ...CONSENTED, sms_consent_phone: "+14165550999", sms_opted_out_at: "2026-11-01T12:00:00Z" }, smsType: "confirmation" })).toEqual({ ok: false, reason: "client_opted_out" });
    expect(passesConsentGate({ studio: ALL_ON, client: { ...CONSENTED, sms_consent_phone: "+14165550999", sms_consent_at: null }, smsType: "confirmation" })).toEqual({ ok: false, reason: "client_no_consent" });
  });
});

describe("confirmationSmsWillPass", () => {
  it("follows the confirmation switch and the client's consent, and nothing else", () => {
    expect(confirmationSmsWillPass({ id: "s", send_confirmation_sms: true }, CONSENTED)).toBe(true);
    expect(confirmationSmsWillPass({ id: "s", send_confirmation_sms: false, send_24h_sms_reminders: true }, CONSENTED)).toBe(false);
    expect(confirmationSmsWillPass({}, CONSENTED)).toBe(false);
    expect(confirmationSmsWillPass({ id: "s", send_confirmation_sms: true }, { ...CONSENTED, sms_opted_out_at: "2026-11-01T12:00:00Z" })).toBe(false);
  });
});
