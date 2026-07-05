import { describe, expect, it } from "vitest";
import {
  bookingCardCopy,
  connectBannerCopy,
  deriveConnectCapability,
  deriveManualFeeCapability,
  derivePortalCardCapability,
  manualFeeCopy,
  modeBadgeForRow,
  portalCardCopy,
} from "@/lib/payments/payment-status-presenter";

// Presenter unit tests (PR A): every major state of the canonical payment
// status model, plus the copy invariants ("ready" requires charges AND
// payouts; available never says "becomes available"; live-ready copy never
// contains the banned stale strings).

const BANNED = [
  /client payments are not enabled/i,
  /future update/i,
  /when card-on-file becomes available/i,
  /test mode only/i,
  /no live charges/i,
];

describe("ConnectCapability derivation", () => {
  it("no row → not_connected; read error → unknown", () => {
    expect(deriveConnectCapability(null)).toBe("not_connected");
    expect(deriveConnectCapability(undefined)).toBe("unknown");
  });

  it("ready ONLY when status enabled AND charges AND payouts", () => {
    expect(
      deriveConnectCapability({ accountStatus: "enabled", chargesEnabled: true, payoutsEnabled: true }),
    ).toBe("ready");
    expect(
      deriveConnectCapability({ accountStatus: "enabled", chargesEnabled: true, payoutsEnabled: false }),
    ).toBe("charges_enabled_payouts_pending");
    expect(
      deriveConnectCapability({ accountStatus: "enabled", chargesEnabled: false, payoutsEnabled: false }),
    ).toBe("charges_disabled");
    expect(
      deriveConnectCapability({ accountStatus: "pending", chargesEnabled: false, payoutsEnabled: false }),
    ).toBe("onboarding_started");
    expect(
      deriveConnectCapability({ accountStatus: "rejected", chargesEnabled: false, payoutsEnabled: false }),
    ).toBe("charges_disabled");
  });
});

describe("connectBannerCopy", () => {
  it("live + ready → 'Live payments are ready.'", () => {
    const c = connectBannerCopy("live", "ready");
    expect(c.tone).toBe("ready");
    expect(c.headline).toBe("Live payments are ready.");
    expect(c.detail).toContain(
      "accept live payments through Hone after a client saves an authorized card on file",
    );
    for (const re of BANNED) expect(c.headline + " " + c.detail).not.toMatch(re);
  });

  it("test + ready → 'Test payment setup is ready.'", () => {
    const c = connectBannerCopy("test", "ready");
    expect(c.headline).toBe("Test payment setup is ready.");
    expect(c.detail).toContain("without moving real money");
  });

  it("charges enabled + payouts disabled → WARNING, never ready (both modes)", () => {
    for (const mode of ["test", "live"] as const) {
      const c = connectBannerCopy(mode, "charges_enabled_payouts_pending");
      expect(c.tone).toBe("warning");
      expect(c.detail).toContain(
        "Charges may be enabled, but payouts are not ready. Finish payout setup before charging clients.",
      );
      // Never a positive readiness claim.
      expect(c.headline + " " + c.detail).not.toMatch(/(payments|setup) (is|are) ready/i);
    }
  });

  it("unknown → never renders an all-clear", () => {
    const c = connectBannerCopy("live", "unknown");
    expect(c.tone).toBe("info");
    expect(c.headline).not.toMatch(/ready/i);
  });

  it("live + not connected → truthful setup copy without banned strings", () => {
    const c = connectBannerCopy("live", "not_connected");
    expect(c.headline).toBe("Live payments are not set up yet");
    for (const re of BANNED) expect(c.headline + " " + c.detail).not.toMatch(re);
  });
});

describe("PortalCardCapability", () => {
  const base = { hasActiveAuthorizationTemplate: true, publishableKeyOk: true };

  it("available when connect ok + template + publishable key", () => {
    expect(derivePortalCardCapability({ connect: "ready", ...base })).toBe("available");
    // Card SAVE needs onboarded charges, not payouts.
    expect(
      derivePortalCardCapability({ connect: "charges_enabled_payouts_pending", ...base }),
    ).toBe("available");
  });

  it("first blocker wins: connect, then template, then publishable key", () => {
    expect(derivePortalCardCapability({ connect: "not_connected", ...base })).toBe("needs_connect");
    expect(
      derivePortalCardCapability({ connect: "ready", ...base, hasActiveAuthorizationTemplate: false }),
    ).toBe("needs_authorization_template");
    expect(
      derivePortalCardCapability({ connect: "ready", ...base, publishableKeyOk: false }),
    ).toBe("needs_publishable_key");
    expect(derivePortalCardCapability({ connect: "unknown", ...base })).toBe("unknown");
  });

  it("available copy says AVAILABLE; blocked copy names the exact blocker", () => {
    expect(portalCardCopy("available")).toBe(
      "Portal card-on-file is available. Clients can sign the card authorization and save a card in the client portal.",
    );
    expect(portalCardCopy("available")).not.toMatch(/becomes available/i);
    expect(portalCardCopy("needs_connect")).toContain("Stripe Connect onboarding");
    expect(portalCardCopy("needs_authorization_template")).toContain("card authorization consent template");
    expect(portalCardCopy("needs_publishable_key")).toContain("publishable key");
  });
});

describe("Booking-time card collection", () => {
  it("off copy: collection off, booking still works — never implies portal unavailability", () => {
    const copy = bookingCardCopy("off");
    expect(copy).toBe(
      "Booking-time card collection is off. Clients can still book without entering a card.",
    );
    expect(copy).not.toMatch(/card-on-file/i);
  });

  it("on copy flips automatically", () => {
    expect(bookingCardCopy("on")).toBe("Booking-time card collection is on.");
  });
});

describe("Manual fee capability", () => {
  it("amounts set → configured_but_hold; never presented as automatic", () => {
    expect(
      deriveManualFeeCapability({ lateCancelFeeCents: 2500, noShowFeeCents: null }),
    ).toBe("configured_but_hold");
    expect(manualFeeCopy("configured_but_hold")).toContain("never charged automatically");
  });

  it("no amounts → not_configured; settings save charges nothing", () => {
    expect(
      deriveManualFeeCapability({ lateCancelFeeCents: null, noShowFeeCents: 0 }),
    ).toBe("not_configured");
    expect(manualFeeCopy("not_configured")).toContain("does not charge anyone");
  });
});

describe("Per-row mode badge", () => {
  it("always the ROW's stripe_livemode; null is Unknown, never silently Test", () => {
    expect(modeBadgeForRow(true)).toBe("Live");
    expect(modeBadgeForRow(false)).toBe("Test");
    expect(modeBadgeForRow(null)).toBe("Unknown");
    expect(modeBadgeForRow(undefined)).toBe("Unknown");
  });
});
