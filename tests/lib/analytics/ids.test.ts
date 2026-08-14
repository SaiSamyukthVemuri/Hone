import { describe, expect, it, vi } from "vitest";
import {
  isAnalyticsUuid,
  resolveDistinctId,
  validateRole,
} from "@/lib/analytics/ids";

// The opaque analytics identifier boundary (Correction 2). Proves it rejects
// emails, phones, tokens, token paths, free text, names and malformed IDs,
// fail closed, never throwing, never surfacing the rejected value. Synthetic
// data only.

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

const REJECTED_IDS: Array<[string, string]> = [
  ["email", "jane.doe@example.com"],
  ["phone", "+1 415 555 2671"],
  ["bearer token", "Bearer eyJhbGciOi.payload.sig"],
  ["supabase token", "sb-abcref-auth-token"],
  ["token path", "/manage/tok_SYNTH_secret"],
  ["free text", "Synthia Testcase"],
  ["name", "Jane Doe"],
  ["malformed uuid", "1111-1111"],
  ["uuid with suffix", `${VALID_UUID}x`],
  ["empty", ""],
];

describe("resolveDistinctId fails closed on non-UUID actors", () => {
  for (const [label, bad] of REJECTED_IDS) {
    it(`rejects ${label} (user) -> null, no throw`, () => {
      expect(() => resolveDistinctId({ kind: "user", id: bad })).not.toThrow();
      expect(resolveDistinctId({ kind: "user", id: bad })).toBeNull();
    });
    it(`rejects ${label} (studio) -> null`, () => {
      expect(resolveDistinctId({ kind: "studio", id: bad })).toBeNull();
    });
  }

  it("does not log the rejected value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    resolveDistinctId({ kind: "user", id: "jane.doe@example.com" });
    const all = [...warn.mock.calls, ...err.mock.calls, ...log.mock.calls]
      .flat()
      .map(String)
      .join("\n");
    expect(all).not.toContain("jane.doe@example.com");
    warn.mockRestore();
    err.mockRestore();
    log.mockRestore();
  });
});

describe("resolveDistinctId accepts UUID actors", () => {
  it("returns the bare UUID for a user", () => {
    expect(resolveDistinctId({ kind: "user", id: VALID_UUID })).toBe(VALID_UUID);
  });
  it("prefixes studio ids", () => {
    expect(resolveDistinctId({ kind: "studio", id: VALID_UUID })).toBe(
      `studio:${VALID_UUID}`,
    );
  });
  it("accepts upper-case UUIDs", () => {
    expect(resolveDistinctId({ kind: "user", id: VALID_UUID.toUpperCase() })).not.toBeNull();
  });
});

describe("isAnalyticsUuid", () => {
  it("is true only for UUIDs", () => {
    expect(isAnalyticsUuid(VALID_UUID)).toBe(true);
    expect(isAnalyticsUuid("jane@example.com")).toBe(false);
    expect(isAnalyticsUuid(123)).toBe(false);
    expect(isAnalyticsUuid(null)).toBe(false);
  });
});

describe("validateRole", () => {
  it("accepts only the coarse role enum", () => {
    expect(validateRole("owner")).toBe("owner");
    expect(validateRole("practitioner")).toBe("practitioner");
    expect(validateRole("admin")).toBeNull();
    expect(validateRole("super_owner")).toBeNull();
    expect(validateRole(undefined)).toBeNull();
    expect(validateRole(42)).toBeNull();
  });
});
