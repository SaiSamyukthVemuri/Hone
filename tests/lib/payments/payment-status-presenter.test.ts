import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describePaymentCountry } from "@/lib/billing/payment-jurisdiction";
import {
  bookingCardCopy,
  connectBannerCopy,
  gateConnectBannerOnCountry,
  portalCardCopyGatedOnCountry,
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

// Codex P2 4249120309. Stripe "ready" never outranks the payment country.
describe("gateConnectBannerOnCountry", () => {
  const ready = connectBannerCopy("live", "ready");
  const notReady = connectBannerCopy("live", "not_connected");

  it("a blocked country (conflict or mismatch) turns ready into Charges are blocked", () => {
    const out = gateConnectBannerOnCountry(ready, {
      tone: "blocked",
      detail: "Stripe has reported more than one country.",
    });
    expect(out).toEqual({
      tone: "warning",
      headline: "Charges are blocked",
      detail: "Stripe has reported more than one country.",
    });
  });

  it("an unverifiable country is never ready", () => {
    const out = gateConnectBannerOnCountry(ready, {
      tone: "unknown",
      detail: "Hone could not read this studio's payment country.",
    });
    expect(out.tone).not.toBe("ready");
    expect(out.headline).toBe("Payment country could not be verified");
  });

  it("unread country replaces pending-payout chargeability copy but retains the payout warning", () => {
    const pending = connectBannerCopy("live", "charges_enabled_payouts_pending");
    const out = gateConnectBannerOnCountry(pending, {
      tone: "unknown",
      detail: "Hone could not read this studio's payment country.",
    });
    expect(out.tone).toBe("warning");
    expect(out.headline).toBe("Payment country could not be verified");
    expect(out.detail).toContain("could not read this studio's payment country");
    expect(out.detail).toContain("Payouts are not ready");
    expect(out.detail).not.toMatch(/Charges may be enabled|charging clients/);
    expect(gateConnectBannerOnCountry(pending, { tone: "ok", detail: "x" })).toBe(pending);
  });

  it("ok and attention (legacy CA, still chargeable) leave the banner unchanged", () => {
    expect(gateConnectBannerOnCountry(ready, { tone: "ok", detail: "x" })).toBe(ready);
    expect(gateConnectBannerOnCountry(ready, { tone: "attention", detail: "x" })).toBe(ready);
  });

  it("negative control: it never upgrades a banner that was not ready", () => {
    expect(gateConnectBannerOnCountry(notReady, { tone: "unknown", detail: "x" })).toBe(notReady);
    expect(gateConnectBannerOnCountry(notReady, { tone: "ok", detail: "x" })).toBe(notReady);
  });

  it("portal card copy never claims 'available' for a blocked or unverifiable country (audit F3)", () => {
    const blocked = portalCardCopyGatedOnCountry("available", { tone: "blocked", detail: "X." });
    expect(blocked).toMatch(/not available/i);
    expect(blocked).not.toMatch(/is available\./i);
    expect(portalCardCopyGatedOnCountry("available", { tone: "unknown", detail: "X." })).toMatch(
      /could not be determined/i,
    );
    // ok / attention, and every non-available capability: unchanged.
    expect(portalCardCopyGatedOnCountry("available", { tone: "ok", detail: "X." })).toBe(
      portalCardCopy("available"),
    );
    expect(portalCardCopyGatedOnCountry("available", { tone: "attention", detail: "X." })).toBe(
      portalCardCopy("available"),
    );
    expect(portalCardCopyGatedOnCountry("needs_connect", { tone: "blocked", detail: "X." })).toBe(
      portalCardCopy("needs_connect"),
    );
  });

  // Codex P2 4249448355: the blocked reason survives into the portal copy.
  it("portal copy carries the country verdict's own reason, end to end", () => {
    const US = { country: "US" as const, currency: "usd" as const };
    for (const account of [
      { kind: "bound" as const, observedCountry: null }, // US account not yet confirmed
      { kind: "bound" as const, observedCountry: "CA" }, // mismatch
      { kind: "bound" as const, observedCountry: "US", conflictingCountry: "CA" }, // conflict
    ]) {
      const summary = describePaymentCountry({ jurisdiction: US, account });
      expect(summary.tone).toBe("blocked");
      const copy = portalCardCopyGatedOnCountry("available", summary);
      expect(copy).toContain(summary.detail);
    }
    // Unverifiable country: its own reason too.
    const unknown = describePaymentCountry({ jurisdiction: null, account: { kind: "none" } });
    expect(portalCardCopyGatedOnCountry("available", unknown)).toContain(unknown.detail);
  });

  it("the settings page passes its banner through the gate", () => {
    const page = readFileSync(
      path.join(process.cwd(), "app/(app)/settings/payments/page.tsx"),
      "utf8",
    );
    expect(page).toMatch(
      /gateConnectBannerOnCountry\(\s*connectBannerCopy\(runtimeMode, connect\),\s*countrySummary,\s*\)/,
    );
    expect(page).toContain("portalCardCopyGatedOnCountry(portalCard, countrySummary)");
  });
});
