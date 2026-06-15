import { describe, expect, it } from "vitest";
import {
  isValidTimeZone,
  normalizeEmail,
  parseNewStudioInput,
} from "@/lib/studios/new-studio";

// PR #254: pure validation for the internal New Studio Wizard. Unit-tested
// directly (no Supabase) so the slug/email/timezone/normalization rules cannot
// silently regress. The operator gate + DB writes are covered by
// tests/app/admin/new-studio-wizard.test.ts and tests/db/new-studio-wizard.db.test.ts.

const VALID = {
  name: "Laura's Electrolysis",
  slug: "lauraelectrolysis",
  ownerDisplayName: "Laura Smith",
  ownerEmail: "laura@example.com",
  timezone: "America/Toronto",
};

describe("parseNewStudioInput — happy path + normalization", () => {
  it("accepts a complete valid input and returns normalized values", () => {
    const r = parseNewStudioInput(VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe("Laura's Electrolysis");
    expect(r.value.slug).toBe("lauraelectrolysis");
    expect(r.value.ownerEmail).toBe("laura@example.com");
    expect(r.value.timezone).toBe("America/Toronto");
    expect(r.value.bookingDescription).toBeNull();
    expect(r.value.address).toBeNull();
  });

  it("normalizes the owner email (trim + lowercase)", () => {
    const r = parseNewStudioInput({ ...VALID, ownerEmail: "  Laura@Example.COM " });
    expect(r.ok && r.value.ownerEmail).toBe("laura@example.com");
  });

  it("lowercases an uppercase slug before validating", () => {
    const r = parseNewStudioInput({ ...VALID, slug: "LauraStudio" });
    expect(r.ok && r.value.slug).toBe("laurastudio");
  });

  it("defaults the timezone to America/Toronto when blank", () => {
    const r = parseNewStudioInput({ ...VALID, timezone: "   " });
    expect(r.ok && r.value.timezone).toBe("America/Toronto");
  });

  it("keeps optional booking description and address when provided", () => {
    const r = parseNewStudioInput({
      ...VALID,
      bookingDescription: " Downtown studio ",
      address: " 1 King St ",
    });
    expect(r.ok && r.value.bookingDescription).toBe("Downtown studio");
    expect(r.ok && r.value.address).toBe("1 King St");
  });
});

describe("parseNewStudioInput — required fields", () => {
  it("rejects a missing studio name", () => {
    const r = parseNewStudioInput({ ...VALID, name: "  " });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/name is required/i);
  });

  it("rejects a missing owner display name", () => {
    const r = parseNewStudioInput({ ...VALID, ownerDisplayName: "" });
    expect(!r.ok && r.error).toMatch(/display name is required/i);
  });

  it("rejects a missing owner email", () => {
    const r = parseNewStudioInput({ ...VALID, ownerEmail: "" });
    expect(!r.ok && r.error).toMatch(/email is required/i);
  });

  it("rejects a missing slug", () => {
    const r = parseNewStudioInput({ ...VALID, slug: "" });
    expect(!r.ok && r.error).toMatch(/slug is required/i);
  });
});

describe("parseNewStudioInput — format validation", () => {
  it("rejects an invalid email address", () => {
    const r = parseNewStudioInput({ ...VALID, ownerEmail: "not-an-email" });
    expect(!r.ok && r.error).toMatch(/valid email/i);
  });

  it.each([
    ["a space", "la ura"],
    ["a leading hyphen", "-laura"],
    ["a trailing hyphen", "laura-"],
    ["an underscore", "laura_studio"],
    ["over 64 chars", "a".repeat(65)],
  ])("rejects a slug with %s", (_label, slug) => {
    const r = parseNewStudioInput({ ...VALID, slug });
    expect(r.ok).toBe(false);
  });

  it("rejects a reserved slug", () => {
    const r = parseNewStudioInput({ ...VALID, slug: "admin" });
    expect(!r.ok && r.error).toMatch(/reserved/i);
  });

  it("rejects an invalid IANA timezone", () => {
    const r = parseNewStudioInput({ ...VALID, timezone: "Mars/Phobos" });
    expect(!r.ok && r.error).toMatch(/not a valid IANA/i);
  });

  it("accepts a non-default valid IANA timezone", () => {
    const r = parseNewStudioInput({ ...VALID, timezone: "Europe/London" });
    expect(r.ok && r.value.timezone).toBe("Europe/London");
  });
});

describe("isValidTimeZone / normalizeEmail helpers", () => {
  it("validates real IANA zones and rejects junk", () => {
    expect(isValidTimeZone("America/Toronto")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("normalizes emails to trimmed lowercase", () => {
    expect(normalizeEmail("  OWNER@Studio.CA ")).toBe("owner@studio.ca");
  });
});
