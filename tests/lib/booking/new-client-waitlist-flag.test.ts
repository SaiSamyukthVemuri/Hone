import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isNewClientWaitlistEnabled,
  NEW_CLIENT_WAITLIST_SLUGS_ENV,
  validateWaitlistSubmission,
  WAITLIST_NAME_MAX,
  WAITLIST_PHONE_MAX,
} from "@/lib/booking/new-client-waitlist";

// ===========================================================================
// A. THE KILL SWITCH
// ===========================================================================
// The whole P0 rests on this predicate. If it is wrong in the OFF direction a
// studio silently keeps taking new clients it cannot serve; if it is wrong in
// the ON direction an unrelated studio's public booking page is replaced by a
// waitlist. Both are production incidents, so every boundary is pinned.

const ORIGINAL = process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];

function setEnv(value: string | undefined) {
  if (value === undefined) delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
  else process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = value;
}

beforeEach(() => setEnv(undefined));
afterEach(() => setEnv(ORIGINAL));

describe("isNewClientWaitlistEnabled", () => {
  it("is OFF when the env var is unset", () => {
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(false);
  });

  it("is OFF for an empty env var", () => {
    setEnv("");
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(false);
  });

  it("is OFF for a whitespace-only env var", () => {
    setEnv("   ");
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(false);
  });

  it("is OFF for an env var of nothing but separators", () => {
    setEnv(" , ,, ");
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(false);
  });

  it("is ON for the exact configured slug", () => {
    setEnv("willow-electrolysis");
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(true);
  });

  it("is OFF for an unrelated studio while another is enabled", () => {
    setEnv("willow-electrolysis");
    expect(isNewClientWaitlistEnabled("some-other-studio")).toBe(false);
  });

  it("handles a multi-slug list, including padded entries", () => {
    setEnv(" willow-electrolysis , second-studio,third-studio ");
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(true);
    expect(isNewClientWaitlistEnabled("second-studio")).toBe(true);
    expect(isNewClientWaitlistEnabled("third-studio")).toBe(true);
    expect(isNewClientWaitlistEnabled("fourth-studio")).toBe(false);
  });

  // The one that would be catastrophic: enabling a studio must not silence a
  // DIFFERENT studio whose slug merely contains, extends or is contained by it.
  it("NEVER matches on substring, prefix or suffix", () => {
    setEnv("willow-electrolysis");
    expect(isNewClientWaitlistEnabled("willow")).toBe(false);
    expect(isNewClientWaitlistEnabled("electrolysis")).toBe(false);
    expect(isNewClientWaitlistEnabled("willow-electrolysis-archive")).toBe(false);
    expect(isNewClientWaitlistEnabled("new-willow-electrolysis")).toBe(false);
    expect(isNewClientWaitlistEnabled("illow-electrolysi")).toBe(false);
  });

  it("normalizes case and surrounding whitespace on BOTH sides", () => {
    setEnv("Willow-Electrolysis");
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(true);
    expect(isNewClientWaitlistEnabled("  WILLOW-ELECTROLYSIS  ")).toBe(true);
  });

  it("is OFF for an empty, blank or nullish slug even when the list is populated", () => {
    setEnv("willow-electrolysis,");
    expect(isNewClientWaitlistEnabled("")).toBe(false);
    expect(isNewClientWaitlistEnabled("   ")).toBe(false);
    expect(isNewClientWaitlistEnabled(null)).toBe(false);
    expect(isNewClientWaitlistEnabled(undefined)).toBe(false);
  });

  it("re-reads the env on every call, so the kill switch takes effect without a restart", () => {
    setEnv("willow-electrolysis");
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(true);
    setEnv("");
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(false);
  });
});

describe("validateWaitlistSubmission", () => {
  it("accepts a full submission and normalizes it", () => {
    const r = validateWaitlistSubmission({
      name: "  Ada Lovelace  ",
      email: "  ADA@Example.COM ",
      phone: "  +1 555 0100  ",
    });
    expect(r).toEqual({
      ok: true,
      value: { name: "Ada Lovelace", email: "ada@example.com", phone: "+1 555 0100" },
    });
  });

  it("accepts an omitted phone and reports it as null", () => {
    const r = validateWaitlistSubmission({ name: "Ada", email: "a@b.co", phone: null });
    expect(r.ok && r.value.phone).toBeNull();
  });

  it("treats a whitespace-only phone as omitted", () => {
    const r = validateWaitlistSubmission({ name: "Ada", email: "a@b.co", phone: "   " });
    expect(r.ok && r.value.phone).toBeNull();
  });

  it("refuses a blank or whitespace-only name", () => {
    expect(validateWaitlistSubmission({ name: "", email: "a@b.co", phone: null }).ok).toBe(false);
    expect(validateWaitlistSubmission({ name: "   ", email: "a@b.co", phone: null }).ok).toBe(false);
  });

  it("bounds the name, the email and the phone", () => {
    expect(
      validateWaitlistSubmission({
        name: "a".repeat(WAITLIST_NAME_MAX + 1),
        email: "a@b.co",
        phone: null,
      }).ok,
    ).toBe(false);
    expect(
      validateWaitlistSubmission({
        name: "Ada",
        email: `${"a".repeat(250)}@example.com`,
        phone: null,
      }).ok,
    ).toBe(false);
    expect(
      validateWaitlistSubmission({
        name: "Ada",
        email: "a@b.co",
        phone: "9".repeat(WAITLIST_PHONE_MAX + 1),
      }).ok,
    ).toBe(false);
    // The exact ceiling is accepted; only past it is refused.
    expect(
      validateWaitlistSubmission({
        name: "a".repeat(WAITLIST_NAME_MAX),
        email: "a@b.co",
        phone: "9".repeat(WAITLIST_PHONE_MAX),
      }).ok,
    ).toBe(true);
  });

  it("refuses malformed email addresses", () => {
    for (const email of ["", "   ", "nope", "no@domain", "a b@example.com", "@example.com", "a@"]) {
      expect(
        validateWaitlistSubmission({ name: "Ada", email, phone: null }).ok,
        `${JSON.stringify(email)} must be refused`,
      ).toBe(false);
    }
  });

  it("never leaks the submitted value back in a refusal message", () => {
    const r = validateWaitlistSubmission({
      name: "Ada",
      email: "pii_canary_92837 at example.com",
      phone: null,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).not.toContain("pii_canary_92837");
  });
});
