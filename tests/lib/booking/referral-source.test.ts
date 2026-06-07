import { describe, expect, it } from "vitest";
import {
  REFERRAL_SOURCE_OPTIONS,
  parseReferralSource,
  referralSourceLabel,
} from "@/lib/booking/referral-source";

// PR #163. Booking attribution. Chloe asked for a "How did you hear
// about us?" question on the public booking flow. The option list +
// parse/label helpers in lib/booking/referral-source.ts are the
// single source of truth for the form, the action, the practitioner
// notification email, and the calendar appointment detail page.
// Tests pin the contract so a future option add/remove/relabel
// reaches every surface together.

describe("REFERRAL_SOURCE_OPTIONS", () => {
  it("carries the seven v1 options in the documented order", () => {
    expect(REFERRAL_SOURCE_OPTIONS.map((o) => o.value)).toEqual([
      "google",
      "instagram",
      "friend_or_referral",
      "existing_client",
      "studio_website",
      "other",
      "prefer_not_to_say",
    ]);
  });

  it("uses the practitioner-facing display labels", () => {
    const byValue = new Map(
      REFERRAL_SOURCE_OPTIONS.map((o) => [o.value, o.label] as const),
    );
    expect(byValue.get("google")).toBe("Google");
    expect(byValue.get("instagram")).toBe("Instagram");
    expect(byValue.get("friend_or_referral")).toBe("Friend or referral");
    expect(byValue.get("existing_client")).toBe("Existing client");
    expect(byValue.get("studio_website")).toBe("Studio website");
    expect(byValue.get("other")).toBe("Other");
    expect(byValue.get("prefer_not_to_say")).toBe("Prefer not to say");
  });
});

describe("parseReferralSource", () => {
  it("returns null for null / undefined / empty string", () => {
    expect(parseReferralSource(null)).toBeNull();
    expect(parseReferralSource(undefined)).toBeNull();
    expect(parseReferralSource("")).toBeNull();
    expect(parseReferralSource("   ")).toBeNull();
  });

  it("returns each canonical value unchanged", () => {
    for (const opt of REFERRAL_SOURCE_OPTIONS) {
      expect(parseReferralSource(opt.value)).toBe(opt.value);
    }
  });

  it("trims surrounding whitespace before matching", () => {
    expect(parseReferralSource("  instagram  ")).toBe("instagram");
  });

  it("throws on a non-empty unknown value (rejects free-text)", () => {
    expect(() => parseReferralSource("facebook")).toThrow(/Invalid referral source/);
    expect(() => parseReferralSource("<script>alert(1)</script>")).toThrow(
      /Invalid referral source/,
    );
  });

  it("throws on a non-string non-null value", () => {
    expect(() => parseReferralSource(42 as unknown)).toThrow(
      /Invalid referral source/,
    );
    expect(() => parseReferralSource({ value: "google" } as unknown)).toThrow(
      /Invalid referral source/,
    );
  });
});

describe("referralSourceLabel", () => {
  it("returns null for null / undefined / empty string", () => {
    expect(referralSourceLabel(null)).toBeNull();
    expect(referralSourceLabel(undefined)).toBeNull();
    expect(referralSourceLabel("")).toBeNull();
  });

  it("maps each canonical value to its display label", () => {
    expect(referralSourceLabel("google")).toBe("Google");
    expect(referralSourceLabel("instagram")).toBe("Instagram");
    expect(referralSourceLabel("friend_or_referral")).toBe("Friend or referral");
    expect(referralSourceLabel("existing_client")).toBe("Existing client");
    expect(referralSourceLabel("studio_website")).toBe("Studio website");
    expect(referralSourceLabel("other")).toBe("Other");
    expect(referralSourceLabel("prefer_not_to_say")).toBe("Prefer not to say");
  });

  it("falls through to the raw value for an unknown stored value", () => {
    // A future PR might remove an option; existing stored rows
    // should still render readably rather than disappearing.
    expect(referralSourceLabel("legacy_value")).toBe("legacy_value");
  });
});
