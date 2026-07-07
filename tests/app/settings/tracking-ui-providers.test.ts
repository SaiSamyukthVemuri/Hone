import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// UI/copy-only: the tracking settings page must read as a provider-agnostic
// integration (Meta available now; others coming soon), and the coming-soon
// providers must be inert display cards (no token fields, no actions).
const PAGE = readFileSync(
  path.resolve(__dirname, "../../../app/(app)/settings/tracking/page.tsx"),
  "utf8",
);
const FORM = readFileSync(
  path.resolve(__dirname, "../../../app/(app)/settings/tracking/TrackingProviderForm.tsx"),
  "utf8",
);

describe("tracking settings UI — provider-agnostic framing", () => {
  it("intro says studio-owned providers + Meta available now + not Meta-only", () => {
    expect(PAGE).toMatch(/studio-owned marketing and analytics providers/);
    expect(PAGE).toMatch(/Meta is available now\./);
    expect(PAGE).toMatch(/provider-agnostic integration, not a\s+Meta-only feature/);
  });

  it("keeps the privacy / data-minimization language", () => {
    expect(PAGE).toMatch(/token encrypted/);
    expect(PAGE).toMatch(/minimal, non-clinical booking event/);
    expect(PAGE).toMatch(/only when a\s+client has agreed to marketing tracking/);
  });

  it("shows Meta under 'Available now'", () => {
    expect(PAGE).toMatch(/Available now/);
    expect(PAGE).toMatch(/Meta — Facebook &amp; Instagram \(Conversions API\)/);
  });

  it("lists the other providers as 'Coming soon'", () => {
    expect(PAGE).toMatch(/Coming soon/);
    for (const label of ["Google Ads", "Google Analytics 4", "TikTok", "Pinterest", "LinkedIn", "Microsoft Ads"]) {
      expect(PAGE).toContain(label);
    }
  });
});

describe("tracking settings UI — coming-soon providers are INERT", () => {
  // The coming-soon block is the text after the "Coming soon" heading.
  const comingSoon = PAGE.slice(PAGE.indexOf("Coming soon"));

  it("renders coming-soon providers as disabled display cards (no inputs/token fields)", () => {
    expect(comingSoon).toMatch(/aria-disabled="true"/);
    expect(comingSoon).not.toMatch(/<input/);
    expect(comingSoon).not.toMatch(/type="password"/);
    expect(comingSoon).not.toMatch(/Conversions API token/); // no token input label
  });

  it("wires NO save/clear action to coming-soon providers", () => {
    // Only the single Meta form receives the actions; the coming-soon list has none.
    expect(PAGE.match(/saveAction=\{/g)?.length ?? 0).toBe(1);
    expect(comingSoon).not.toMatch(/saveTrackingProviderConfigAction|clearTrackingTokenAction|saveAction=|clearTokenAction=/);
    expect(comingSoon).not.toMatch(/<form|onSubmit|onClick/);
  });

  it("only the Meta form (a separate component) has a token input", () => {
    // The token input lives in TrackingProviderForm (used once, for Meta).
    expect(FORM).toMatch(/type="password"/);
    expect(PAGE).not.toMatch(/type="password"/);
  });
});

describe("tracking settings UI — no tracking/sender behavior changed", () => {
  it("the page still does not touch the sender/crypto/actions logic", () => {
    expect(PAGE).not.toMatch(/dispatchBookingConversion|token-crypto|encryptTrackingProviderToken|graph\.facebook|fbq\(/);
  });
  it("remains owner-gated", () => {
    expect(PAGE).toMatch(/practitioner\.role !== "owner"/);
  });
});
