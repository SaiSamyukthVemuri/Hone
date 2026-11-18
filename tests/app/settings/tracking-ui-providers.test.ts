import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Provider selector: where the token input and sender code may NOT appear
// (source pins; vitest env is "node", no DOM).
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const PAGE = read("app/(app)/settings/integrations/marketing/page.tsx");
const SELECTOR = read("app/(app)/settings/tracking/TrackingProviderSelector.tsx");
const FORM = read("app/(app)/settings/tracking/TrackingProviderForm.tsx");

describe("tracking page — delegates to the selector", () => {
  it("renders the selector; the page itself has no token input / no sender code", () => {
    expect(PAGE).toMatch(/<TrackingProviderSelector/);
    expect(PAGE).not.toMatch(/type="password"/);
    expect(PAGE).not.toMatch(/dispatchBookingConversion|token-crypto|graph\.facebook|fbq\(/);
  });
});

describe("selector — coming-soon panels are INERT (no fields/forms/actions)", () => {
  const comingSoon = SELECTOR.slice(
    SELECTOR.indexOf("function ComingSoonPanel"),
    SELECTOR.indexOf("export function TrackingProviderSelector"),
  );
  it("has NO token input, NO form, NO save/clear action", () => {
    expect(comingSoon).toMatch(/Coming soon/); // non-vacuity: the slice found the panel
    expect(comingSoon).not.toMatch(/<TrackingProviderForm/);
    expect(comingSoon).not.toMatch(/<input/);
    expect(comingSoon).not.toMatch(/type="password"/);
    expect(comingSoon).not.toMatch(/<form|onSubmit/);
    expect(comingSoon).not.toMatch(/saveAction|clearTokenAction|saveTrackingProviderConfigAction/);
  });
  it("token input still lives ONLY in the shared Meta form component", () => {
    expect(FORM).toMatch(/type="password"/);
    expect(SELECTOR).not.toMatch(/type="password"/);
  });
});

describe("selector — no sender code", () => {
  it("no sender/dispatch/crypto in the selector", () => {
    expect(SELECTOR).not.toMatch(/dispatchBookingConversion|token-crypto|encryptTrackingProviderToken|graph\.facebook|fbq\(|gtag\(/);
  });
});
