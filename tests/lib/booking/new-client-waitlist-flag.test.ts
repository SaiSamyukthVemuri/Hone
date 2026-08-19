import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isNewClientWaitlistEnabled,
  NEW_CLIENT_WAITLIST_SLUGS_ENV,
  validateWaitlistSubmission,
  WAITLIST_NAME_MAX,
  WAITLIST_PHONE_MAX,
} from "@/lib/booking/new-client-waitlist";

// ===========================================================================
// THE KILL SWITCH
// ===========================================================================
// The whole release rests on this predicate. Wrong in the OFF direction and a
// studio silently keeps taking new clients it cannot serve; wrong in the ON
// direction and an unrelated studio's public booking page is replaced by a
// waitlist. Both are production incidents, so every boundary is pinned.

const ORIGINAL = process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
function setEnv(value: string | undefined) {
  if (value === undefined) delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
  else process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = value;
}
beforeEach(() => setEnv(undefined));
afterEach(() => setEnv(ORIGINAL));

describe("isNewClientWaitlistEnabled", () => {
  it("is OFF when unset", () => {
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(false);
  });

  it("is OFF for empty, whitespace-only, and separator-only values", () => {
    for (const v of ["", "   ", " , ,, "]) {
      setEnv(v);
      expect(isNewClientWaitlistEnabled("willow-electrolysis"), v).toBe(false);
    }
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

  // The catastrophic one: enabling a studio must not silence a DIFFERENT
  // studio whose slug contains, extends, or is contained by it.
  it("NEVER matches on substring, prefix or suffix", () => {
    setEnv("willow-electrolysis");
    for (const slug of [
      "willow",
      "electrolysis",
      "willow-electrolysis-archive",
      "new-willow-electrolysis",
      "illow-electrolysi",
    ]) {
      expect(isNewClientWaitlistEnabled(slug), slug).toBe(false);
    }
  });

  it("normalizes case and whitespace on BOTH sides", () => {
    setEnv("Willow-Electrolysis");
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(true);
    expect(isNewClientWaitlistEnabled("  WILLOW-ELECTROLYSIS  ")).toBe(true);
  });

  it("is OFF for an empty, blank or nullish slug even with a populated list", () => {
    setEnv("willow-electrolysis,");
    expect(isNewClientWaitlistEnabled("")).toBe(false);
    expect(isNewClientWaitlistEnabled("   ")).toBe(false);
    expect(isNewClientWaitlistEnabled(null)).toBe(false);
    expect(isNewClientWaitlistEnabled(undefined)).toBe(false);
  });

  it("re-reads the env every call, so the kill switch needs no restart", () => {
    setEnv("willow-electrolysis");
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(true);
    setEnv("");
    expect(isNewClientWaitlistEnabled("willow-electrolysis")).toBe(false);
  });
});

describe("validateWaitlistSubmission", () => {
  it("accepts a full submission and normalizes it", () => {
    expect(
      validateWaitlistSubmission({
        name: "  Ada Lovelace  ",
        email: "  ADA@Example.COM ",
        phone: "  +1 555 0100  ",
      }),
    ).toEqual({
      ok: true,
      value: { name: "Ada Lovelace", email: "ada@example.com", phone: "+1 555 0100" },
    });
  });

  it("treats an omitted or whitespace-only phone as null", () => {
    for (const phone of [null, "   "]) {
      const r = validateWaitlistSubmission({ name: "Ada", email: "a@b.co", phone });
      expect(r.ok && r.value.phone).toBeNull();
    }
  });

  it("refuses a blank or whitespace-only name", () => {
    expect(validateWaitlistSubmission({ name: "", email: "a@b.co", phone: null }).ok).toBe(false);
    expect(validateWaitlistSubmission({ name: "  ", email: "a@b.co", phone: null }).ok).toBe(false);
  });

  it("bounds name, email and phone, accepting the exact ceiling", () => {
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
        JSON.stringify(email),
      ).toBe(false);
    }
  });

  it("never echoes the submitted value back in a refusal message", () => {
    const r = validateWaitlistSubmission({
      name: "Ada",
      email: "pii_canary_92837 at example.com",
      phone: null,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).not.toContain("pii_canary_92837");
  });
});
