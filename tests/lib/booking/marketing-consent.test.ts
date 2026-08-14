import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MARKETING_CONSENT_FIELD,
  MARKETING_CONSENT_TEXT_VERSION,
  buildBookingMarketingConsentRow,
  parseMarketingConsent,
} from "@/lib/booking/marketing-consent";

describe("parseMarketingConsent (opt-in; default false)", () => {
  it("true only for an explicit checked value", () => {
    expect(parseMarketingConsent("true")).toBe(true);
    expect(parseMarketingConsent("on")).toBe(true);
  });
  it("false for unchecked / absent / anything else", () => {
    expect(parseMarketingConsent("false")).toBe(false);
    expect(parseMarketingConsent(null)).toBe(false);
    expect(parseMarketingConsent(undefined)).toBe(false);
    expect(parseMarketingConsent("")).toBe(false);
  });
});

describe("buildBookingMarketingConsentRow", () => {
  it("checked → consent true; version + source fixed; no PII/clinical fields", () => {
    const row = buildBookingMarketingConsentRow({
      studioId: "s1",
      appointmentId: "a1",
      clientId: "c1",
      consent: true,
    });
    expect(row).toEqual({
      studio_id: "s1",
      appointment_id: "a1",
      client_id: "c1",
      marketing_analytics_consent: true,
      consent_text_version: MARKETING_CONSENT_TEXT_VERSION,
      consent_source: "public_booking",
    });
    expect(MARKETING_CONSENT_TEXT_VERSION).toBe("marketing_analytics_v1");
    // No contact/clinical keys leak into the row.
    const keys = Object.keys(row).join(",");
    for (const forbidden of ["email", "phone", "name", "notes", "intake", "area", "photo", "contraindication"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("unchecked → consent false; missing client → null client_id", () => {
    const row = buildBookingMarketingConsentRow({ studioId: "s1", appointmentId: "a1", consent: false });
    expect(row.marketing_analytics_consent).toBe(false);
    expect(row.client_id).toBeNull();
    expect(row.consent_source).toBe("public_booking");
  });
});

// ---------------------------------------------------------------------------
// Source pins (vitest env is "node", no jsdom/RTL, so the rendered form + the
// full server action cannot be behaviorally executed here). These pin the
// wiring, NOT rendered UI.
// ---------------------------------------------------------------------------
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const FORM = read("app/book/[slug]/PublicBookForm.tsx");
const ACTION = read("app/book/[slug]/actions.ts");

describe("booking form: optional consent checkbox (source)", () => {
  it("has a marketing consent checkbox bound to marketingConsent state", () => {
    expect(FORM).toMatch(/checked=\{marketingConsent\}/);
    expect(FORM).toMatch(/onChange=\{\(e\) => setMarketingConsent\(e\.target\.checked\)\}/);
  });
  it("is NOT prechecked (defaults false, no defaultChecked)", () => {
    expect(FORM).toMatch(/useState\(false\);\s*\n\s*\/\/ Optional marketing/);
    expect(FORM).not.toMatch(/marketingConsent[\s\S]{0,80}defaultChecked/);
  });
  it("compact UI: short visible label, full privacy detail in a collapsed <details>", () => {
    // Compact, non-conversion-hostile visible label.
    expect(FORM).toMatch(/Optional: help this studio measure ad performance\./);
    // Detailed explanation moved into a collapsed (no `open`) expandable.
    expect(FORM).toMatch(/<details/);
    expect(FORM).not.toMatch(/<details[^>]*\bopen\b/);
    expect(FORM).toMatch(/What does this mean\?/);
    // Privacy/legal meaning preserved: privacy-safe tools, no clinical/treatment
    // data, and booking still works when left unchecked.
    expect(FORM).toMatch(/privacy-safe marketing and analytics tools/);
    expect(FORM).toMatch(/does not send clinical or treatment details/);
    expect(FORM).toMatch(/You can book even if you leave this unchecked\./);
  });
  it("submits the consent field in FormData", () => {
    expect(FORM).toMatch(/fd\.set\(MARKETING_CONSENT_FIELD, marketingConsent \? "true" : "false"\)/);
  });
});

describe("booking action: non-blocking consent capture (source)", () => {
  it("parses consent + inserts one booking_tracking_consents row AFTER the appointment is created", () => {
    expect(ACTION).toMatch(/const marketingConsent = parseMarketingConsent\(/);
    // Migration 0170: the appointment is no longer INSERTed here, it is created
    // by the create_public_appointment command, so that call is the anchor. The
    // invariant is unchanged: consent capture happens only after the booking has
    // committed.
    const insertIdx = ACTION.indexOf('"create_public_appointment"');
    const consentIdx = ACTION.indexOf('.from("booking_tracking_consents")');
    expect(insertIdx).toBeGreaterThan(-1);
    expect(consentIdx).toBeGreaterThan(insertIdx); // consent after booking commit
    expect(ACTION).toMatch(/buildBookingMarketingConsentRow\(\{/);
  });
  it("is fire-and-forget + swallows failure so a booking never fails on consent", () => {
    expect(ACTION).toMatch(/void \(async \(\) => \{[\s\S]*booking_tracking_consents/);
    expect(ACTION).toMatch(/Consent capture must never break a confirmed booking\./);
    // Failure logs a safe, PII-free signal (code + studioId only).
    expect(ACTION).toMatch(/public_booking_marketing_consent_insert_failed/);
  });
});

describe("conversion dispatch is wired but gated (no browser pixel; inert by default)", () => {
  it("the booking action calls the gated dispatcher fire-and-forget (no browser pixel)", () => {
    expect(ACTION).toMatch(/void dispatchBookingConversion\(\{/);
    // The dispatcher is gated on consent inside itself; the action passes the
    // captured consent value.
    expect(ACTION).toMatch(/consentGranted: marketingConsent/);
    // No browser pixel/tag is added to the booking flow.
    expect(ACTION).not.toMatch(/graph\.facebook|fbq\(|gtag\(|ttq\./);
  });
  it("the dispatcher only sends after consent + an enabled provider config", () => {
    const D = read("lib/conversion/dispatch.ts");
    expect(D).toMatch(/if \(!params\.consentGranted\) return;/);
    expect(D).toMatch(/\.eq\("enabled", true\)/);
    expect(D).toMatch(/if \(!rows \|\| rows\.length === 0\) return;/);
  });
});
