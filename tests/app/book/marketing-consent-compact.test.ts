import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseMarketingConsent } from "@/lib/booking/marketing-consent";

// Marketing/analytics consent compact-UI fix. UI-only: shrink the visible
// footprint of the OPTIONAL consent so it stops overshadowing the booking task,
// while preserving the unchecked default, the submitted value, the privacy
// meaning, and all tracking/consent-capture logic.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const FORM = read("app/book/[slug]/PublicBookForm.tsx");
const ACTION = read("app/book/[slug]/actions.ts");
const HELPER = read("lib/booking/marketing-consent.ts");

describe("default + booking-not-blocked (unchanged)", () => {
  it("checkbox defaults UNCHECKED (controlled by useState(false); never prechecked)", () => {
    expect(FORM).toMatch(/const \[marketingConsent, setMarketingConsent\] = useState\(false\)/);
    expect(FORM).toMatch(/checked=\{marketingConsent\}/);
    expect(FORM).not.toMatch(/marketingConsent[\s\S]{0,80}defaultChecked/);
    // never hard-coded as checked / prechecked
    expect(FORM).not.toMatch(/type="checkbox"[\s\S]{0,140}checked=\{true\}/);
  });
  it("consent is optional — the marketing checkbox is not `required`, so declining still books", () => {
    expect(FORM).not.toMatch(/checked=\{marketingConsent\}[\s\S]{0,120}required/);
    expect(FORM).not.toMatch(/required[\s\S]{0,120}checked=\{marketingConsent\}/);
  });
  it("parseMarketingConsent: only explicit 'true' is consent — both false and true paths book", () => {
    expect(parseMarketingConsent("true")).toBe(true); // consent given → booking proceeds
    expect(parseMarketingConsent("false")).toBe(false); // declined → booking proceeds
    expect(parseMarketingConsent(null)).toBe(false); // absent → declined
  });
  it("the consent value is always submitted (true or false)", () => {
    expect(FORM).toMatch(/fd\.set\(MARKETING_CONSENT_FIELD, marketingConsent \? "true" : "false"\)/);
  });
});

describe("compact UI: short visible label + collapsed, secondary detail", () => {
  it("visible label is the compact optional copy", () => {
    expect(FORM).toMatch(/Optional: help this studio measure ad performance\./);
  });
  it("detailed explanation is present but collapsed (no `open`) behind 'What does this mean?'", () => {
    expect(FORM).toMatch(/<details[\s\S]*?<summary[^>]*>[\s\S]*?What does this mean\?/);
    expect(FORM).not.toMatch(/<details[^>]*\bopen\b/);
    expect(FORM).toMatch(/text-\[12px\]/); // rendered smaller/secondary
  });
  it("privacy / legal meaning preserved in the detail", () => {
    expect(FORM).toMatch(/privacy-safe marketing and analytics tools/);
    expect(FORM).toMatch(/does not send clinical or treatment details/);
    expect(FORM).toMatch(/You can book even if you leave this unchecked\./);
  });
});

describe("tracking send + consent capture logic UNCHANGED", () => {
  it("the marketing-consent helper is intact (field, parser, row builder)", () => {
    expect(HELPER).toMatch(/marketing_analytics_consent/);
    expect(HELPER).toMatch(/export function parseMarketingConsent/);
    expect(HELPER).toMatch(/export function buildBookingMarketingConsentRow/);
  });
  it("the booking action still parses + records consent the same way (no send from the form)", () => {
    expect(ACTION).toMatch(/parseMarketingConsent\(/);
    expect(ACTION).toMatch(/buildBookingMarketingConsentRow\(/);
    expect(ACTION).toMatch(/booking_tracking_consents/);
  });
  it("no payment/email/SMS introduced by the consent-block change", () => {
    // Scope to the compacted marketing block only (the form legitimately has
    // separate SMS + payment consent blocks elsewhere, untouched here).
    const start = FORM.indexOf("Optional: help this studio");
    const end = FORM.indexOf("leave this unchecked", start) + 40;
    const block = FORM.slice(start, end);
    expect(block.length).toBeGreaterThan(100);
    expect(block).not.toMatch(/stripe|sendEmail|twilio|sms/i);
  });
});
