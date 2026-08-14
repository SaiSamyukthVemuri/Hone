import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Nav-only change: expose the (owner-gated) Marketing & analytics tracking page
// in the Settings navigation. Source pins (the nav list is built server-side in
// the layout; the page's own owner-gate is tested in tracking-settings.test.ts).

const LAYOUT = readFileSync(
  path.resolve(__dirname, "../../../app/(app)/settings/layout.tsx"),
  "utf8",
);

describe("settings nav: Marketing & analytics link", () => {
  it("adds a Marketing & analytics item pointing at /settings/tracking", () => {
    expect(LAYOUT).toMatch(
      /\{\s*href:\s*"\/settings\/tracking",\s*label:\s*"Marketing & analytics"\s*\}/,
    );
  });

  it("is OWNER-ONLY (inside the isOwner block, after the owner links)", () => {
    const ownerIdx = LAYOUT.indexOf("isOwner");
    const trackingIdx = LAYOUT.indexOf("/settings/tracking");
    const closeOwnerIdx = LAYOUT.indexOf("]\n      : []"); // end of owner-only array
    expect(ownerIdx).toBeGreaterThan(-1);
    expect(trackingIdx).toBeGreaterThan(ownerIdx); // after the isOwner gate
    expect(trackingIdx).toBeLessThan(closeOwnerIdx); // before the non-owner fallback
  });

  it("keeps the existing owner settings links (no regressions)", () => {
    for (const [href, label] of [
      ["/settings/consent", "Consent forms"],
      ["/settings/payments", "Payments"],
      ["/settings/data", "Data"],
      ["/settings/team", "Team"],
    ] as const) {
      expect(LAYOUT).toContain(`href: "${href}", label: "${label}"`);
    }
  });

  it("is nav-only: the layout does not touch tracking sender / crypto / actions", () => {
    expect(LAYOUT).not.toMatch(/dispatchBookingConversion|token-crypto|encrypt|decrypt|saveTrackingProvider/);
  });
});
