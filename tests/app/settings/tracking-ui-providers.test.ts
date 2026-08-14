import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Provider selector + onboarding UI (source pins; vitest env is "node", no DOM).
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const PAGE = read("app/(app)/settings/tracking/page.tsx");
const SELECTOR = read("app/(app)/settings/tracking/TrackingProviderSelector.tsx");
const FORM = read("app/(app)/settings/tracking/TrackingProviderForm.tsx");

describe("tracking page: provider-agnostic intro + delegates to the selector", () => {
  it("intro says studio-owned providers, Meta available now, not Meta-only", () => {
    expect(PAGE).toMatch(/studio-owned marketing and analytics providers/);
    expect(PAGE).toMatch(/Meta is available now\./);
    expect(PAGE).toMatch(/provider-agnostic integration, not a Meta-only\s+feature/);
    expect(PAGE).toMatch(/Choose a provider below to see its setup instructions\./);
  });
  it("keeps privacy/data-minimization language + owner gate", () => {
    expect(PAGE).toMatch(/token encrypted/);
    expect(PAGE).toMatch(/minimal, non-clinical booking event/);
    expect(PAGE).toMatch(/practitioner\.role !== "owner"/);
  });
  it("renders the selector; the page itself has no token input / no sender code", () => {
    expect(PAGE).toMatch(/<TrackingProviderSelector/);
    expect(PAGE).not.toMatch(/type="password"/);
    expect(PAGE).not.toMatch(/dispatchBookingConversion|token-crypto|graph\.facebook|fbq\(/);
  });
});

describe("selector: renders every provider; Meta editable, others read-only", () => {
  it("maps the whole registry into the provider <select>", () => {
    expect(SELECTOR).toMatch(/PROVIDER_REGISTRY\.map\(\(p\) =>/);
    expect(SELECTOR).toMatch(/<option key=\{p\.provider\}/);
    expect(SELECTOR).toMatch(/p\.status === "coming_soon" \? " \(Coming soon\)" : ""/);
  });
  it("shows the editable Meta panel only for the available + editable provider", () => {
    expect(SELECTOR).toMatch(/entry\.status === "available" && entry\.editable \?/);
    expect(SELECTOR).toMatch(/<MetaPanel/);
    expect(SELECTOR).toMatch(/<ComingSoonPanel/);
  });
  it("the Meta panel has 'How to get your Meta details' + the editable token form", () => {
    expect(SELECTOR).toMatch(/How to get your Meta details/);
    // MetaPanel renders the token form; ComingSoonPanel does not.
    const metaPanel = SELECTOR.slice(SELECTOR.indexOf("function MetaPanel"), SELECTOR.indexOf("function ComingSoonPanel"));
    expect(metaPanel).toMatch(/<TrackingProviderForm/);
    expect(metaPanel).toMatch(/provider="meta"/);
  });
});

describe("selector: coming-soon panels are INERT (no fields/forms/actions)", () => {
  const comingSoon = SELECTOR.slice(
    SELECTOR.indexOf("function ComingSoonPanel"),
    SELECTOR.indexOf("export function TrackingProviderSelector"),
  );
  it("has NO token input, NO form, NO save/clear action", () => {
    expect(comingSoon).not.toMatch(/<TrackingProviderForm/);
    expect(comingSoon).not.toMatch(/<input/);
    expect(comingSoon).not.toMatch(/type="password"/);
    expect(comingSoon).not.toMatch(/<form|onSubmit/);
    expect(comingSoon).not.toMatch(/saveAction|clearTokenAction|saveTrackingProviderConfigAction/);
  });
  it("shows Coming soon status, future requirements, and the not-enabled note", () => {
    expect(comingSoon).toMatch(/Coming soon/);
    expect(comingSoon).toMatch(/Future requirements/);
    expect(comingSoon).toMatch(/sender is not enabled yet/);
  });
  it("token input still lives ONLY in the shared Meta form component", () => {
    expect(FORM).toMatch(/type="password"/);
    expect(SELECTOR).not.toMatch(/type="password"/);
  });
});

describe("selector: help links / video are safe", () => {
  it("renders official help links + a video fallback, no inline youtube", () => {
    expect(SELECTOR).toMatch(/entry\.helpLinks\.map/);
    expect(SELECTOR).toMatch(/VIDEO_COMING_SOON_FALLBACK/);
    expect(SELECTOR).not.toMatch(/youtube\.com|youtu\.be/i);
  });
  it("no sender/dispatch/crypto in the selector", () => {
    expect(SELECTOR).not.toMatch(/dispatchBookingConversion|token-crypto|encryptTrackingProviderToken|graph\.facebook|fbq\(|gtag\(/);
  });
});
