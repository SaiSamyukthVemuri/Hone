import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_SMS_CONSENT_DISCLOSURE,
  APPOINTMENT_SMS_CONSENT_VERSION,
  APPOINTMENT_SMS_CONSENT_VERSION_V1,
  APPOINTMENT_SMS_CONSENT_V1,
  APPOINTMENT_SMS_HELP_REPLY,
  APPOINTMENT_SMS_STOP_REPLY,
  WAITLIST_SMS_NOTICE_LINES,
  WAITLIST_SMS_AUDIENCE,
  APPOINTMENT_SMS_AUDIENCE,
  appointmentSmsConsentLabel,
} from "@/lib/sms/appointment-sms-copy";
import { GSM7_SEGMENT_UNITS, gsm7Units } from "@/lib/sms/gsm7";
import { isHelpKeyword, isStopKeyword } from "@/lib/sms/twilio";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const disclosure = APPOINTMENT_SMS_CONSENT_DISCLOSURE.join(" ");

describe("the opt-in disclosure carries every required element", () => {
  it("names Hone and the studio (server-resolved name) in the label", () => {
    expect(appointmentSmsConsentLabel("Glow Studio")).toBe(
      "Text me appointment confirmations and reminders from Hone on behalf of Glow Studio.",
    );
  });
  it("states purpose, frequency, rates, HELP, STOP and that consent is not a condition", () => {
    expect(disclosure).toContain("confirmations and reminders only");
    expect(disclosure).toContain("usually up to 3 messages per booking (a confirmation and two reminders); a rescheduled booking starts again");
    expect(disclosure).toContain("Msg & data rates may apply");
    expect(disclosure).toContain("Reply HELP for help, STOP to opt out");
    expect(disclosure).toContain("Consent isn't a condition of booking");
  });
  it("has a new version and keeps the earlier wording as v1", () => {
    expect(APPOINTMENT_SMS_CONSENT_VERSION).toBe("appointment_sms_consent_v2");
    expect(APPOINTMENT_SMS_CONSENT_VERSION_V1).toBe("appointment_sms_consent_v1");
    expect(APPOINTMENT_SMS_CONSENT_V1.label).toBe("Text me appointment confirmations and reminders.");
  });
});

describe("the waitlist notice beside the stored v2 question", () => {
  const n = WAITLIST_SMS_NOTICE_LINES.join(" ");
  it("names Hone and the studio, frequency, rates, HELP/STOP, per-studio scope and not-a-condition", () => {
    expect(n).toContain("from Hone on behalf of the studio you are joining");
    expect(n).toContain("one text when you join and one for each invitation to book");
    expect(n).toContain("Msg & data rates may apply");
    expect(n).toContain("Reply HELP for help, STOP to opt out");
    expect(n).toContain("this studio's waitlist only");
    expect(n).toContain("Consent isn't a condition of joining");
  });
  it("the form renders the shared fieldset and the stored version stays v2", () => {
    const form = read("app/book/[slug]/NewClientWaitlistForm.tsx");
    expect(form).toContain("<WaitlistSmsConsentFieldset");
    expect(form).toMatch(/useState<\s*typeof SMS_CONSENT_ANSWER_YES \| typeof SMS_CONSENT_ANSWER_NO \| null\s*>\(null\)/);
    expect(read("lib/waitlist/prospect-sms-consent.ts")).toContain('SMS_JOIN_CONSENT_TEXT_VERSION = "waitlist_sms_operational_v2"');
  });
});

describe("auto-replies", () => {
  it("HELP reply is GSM-7 and one segment", () => {
    const u = gsm7Units(APPOINTMENT_SMS_HELP_REPLY);
    expect(u).not.toBeNull();
    expect(u as number).toBeLessThanOrEqual(GSM7_SEGMENT_UNITS);
  });
  it("STOP reply is unchanged from before", () => {
    expect(APPOINTMENT_SMS_STOP_REPLY).toBe(
      "You have been opted out of Hone appointment and waitlist texts. Email reminders may still be sent.",
    );
  });
  it("HELP and INFO are help keywords; START, UNSTOP and STOP are not", () => {
    expect(isHelpKeyword("help")).toBe(true);
    expect(isHelpKeyword(" INFO ")).toBe(true);
    for (const w of ["START", "UNSTOP", "STOP", "help me", "", null, undefined]) {
      expect(isHelpKeyword(w as never)).toBe(false);
    }
    expect(isStopKeyword("HELP")).toBe(false);
  });
});

describe("one source: the form, the route and the evidence page use it", () => {
  it("the booking form renders the shared consent component with the server studio name", () => {
    const form = read("app/book/[slug]/PublicBookForm.tsx");
    expect(form).toContain("<AppointmentSmsConsent");
    expect(form).toContain("studioName={studioName}");
    expect(form).not.toContain("Text me appointment confirmations and reminders.");
    expect(form).toContain("const [smsConsent, setSmsConsent] = useState(false);");
    const usage = form.slice(form.indexOf("<AppointmentSmsConsent"), form.indexOf("/>", form.indexOf("<AppointmentSmsConsent")));
    expect(usage).not.toMatch(/required|defaultChecked|checked=\{true\}/);
  });
  it("the route sends the shared HELP and STOP replies", () => {
    const route = read("app/api/twilio/inbound-sms/route.ts");
    expect(route).toContain("APPOINTMENT_SMS_HELP_REPLY");
    expect(route).toContain("APPOINTMENT_SMS_STOP_REPLY");
  });
  it("the page builds its samples with the real template functions and renders the real component", () => {
    const page = read("app/sms-consent/page.tsx");
    for (const f of ["buildBookingConfirmationSms", "build24hReminderSms", "build2hReminderSms", "AppointmentSmsConsent"]) {
      expect(page).toContain(f);
    }
    expect(page).toContain("waitlist texts");
    expect(page).not.toMatch(/\+?1?\d{3}[-. ]?\d{3}[-. ]?\d{4}/);
  });
  it("the page is public (exact middleware match) and the policies carry the anchored SMS section", () => {
    for (const r of ["/sms-consent", "/sms-terms"]) expect(read("lib/supabase/middleware.ts")).toContain(`pathname === "${r}"`);
    for (const p of ["app/privacy/page.tsx", "app/terms/page.tsx"]) {
      const s = read(p);
      expect(s).toContain('id="appointment-text-messages"');
      expect(s).toMatch(/Reply HELP|reply <strong>HELP/);
      expect(s).toMatch(/waitlist/i);
    }
  });
});

describe("public wording stays true (STOP scope, who is texted, who operates Hone)", () => {
  const files = ["app/sms-consent/page.tsx", "app/sms-terms/page.tsx", "app/privacy/page.tsx", "app/terms/page.tsx"];
  const flat = (p: string) => read(p).replace(/&rsquo;/g, "'").replace(/\s+/g, " ").replace(/\{" "\}/g, " ");
  const STOP_SCOPE = "opts that number out of every matching client and waitlist record at that time, across studios";
  it("STOP is described as opting out the matching records at that time, never as 'every studio's texts'", () => {
    for (const f of ["app/sms-consent/page.tsx", "app/sms-terms/page.tsx", "app/terms/page.tsx", "app/privacy/page.tsx"]) {
      const t = read(f);
      expect(t, f).not.toMatch(/(?:stops?|applies to)[^.]{0,40}texts from every studio/i);
      expect(t, f).not.toMatch(/honou?red across all studios/i);
    }
    for (const f of files) expect(read(f).replace(/\s+/g, " "), f).toContain(STOP_SCOPE);
  });
  it("waitlist texts are described as sent to people who agreed, by the form or recorded by the studio", () => {
    expect(WAITLIST_SMS_AUDIENCE).toContain("either by answering Yes on the studio's waitlist form, or by telling the studio they agree");
    for (const f of ["app/privacy/page.tsx", "app/terms/page.tsx"]) {
      expect(flat(f), f).toContain("only to people who agreed");
      expect(flat(f), f).toMatch(/telling the studio they agree/);
    }
    for (const f of ["app/sms-consent/page.tsx", "app/sms-terms/page.tsx"]) expect(read(f), f).toContain("WAITLIST_SMS_AUDIENCE");
  });
  it("appointment texts are not described as 'people who ticked the box'", () => {
    expect(APPOINTMENT_SMS_AUDIENCE).toContain("including ones the studio books for them");
    for (const f of files) expect(read(f), f).not.toMatch(/people who ticked/i);
  });
  it("the operator is the corporation; no individual, no 'pending incorporation', no file number labelled as an EIN", () => {
    for (const f of [...files, "lib/sms/appointment-sms-copy.ts"]) {
      const t = read(f);
      expect(t, f).not.toMatch(/Sam Vemuri|pending\s+incorporation|an individual/i);
      expect(t, f).not.toMatch(/\bEIN\b/);
    }
    for (const f of ["app/privacy/page.tsx", "app/terms/page.tsx"]) expect(read(f), f).toContain("Hone Care, Inc.");
  });
  it("the STOP reply is GSM-7 and one segment", () => {
    const u = gsm7Units(APPOINTMENT_SMS_STOP_REPLY);
    expect(u).not.toBeNull();
    expect(u as number).toBeLessThanOrEqual(GSM7_SEGMENT_UNITS);
  });
});
