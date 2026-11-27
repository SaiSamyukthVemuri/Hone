import { describe, expect, it } from "vitest";
import { isCanonicalRetryKey } from "@/lib/machines/retry-key";

describe("isCanonicalRetryKey", () => {
  it("accepts what the app mints (a UUID) and the plain keys the tests use", () => {
    expect(isCanonicalRetryKey("3f2b8c1e-5a4d-4c6b-9e1f-0a7d2c4b6e80")).toBe(true);
    expect(isCanonicalRetryKey("save-key-0001")).toBe(true);
  });
  it("refuses whitespace of any kind, leading, trailing or inside, and any non-ASCII character", () => {
    const k = "save-key-0001";
    for (const w of ["\t", "\n", "\r", "\v", "\f", " ", "\u00a0", "\u2003", "\u3000", "\u200b", "\ufeff", "\u0085", "\u2028"]) {
      expect(isCanonicalRetryKey(w + k), JSON.stringify(w + k)).toBe(false);
      expect(isCanonicalRetryKey(k + w), JSON.stringify(k + w)).toBe(false);
      expect(isCanonicalRetryKey("save" + w + "key-0001")).toBe(false);
    }
    expect(isCanonicalRetryKey("save-key-\u00e9001")).toBe(false);
  });
  it("refuses a short, an over-long, an empty and a non-string key", () => {
    expect(isCanonicalRetryKey("abc")).toBe(false);
    expect(isCanonicalRetryKey("a".repeat(129))).toBe(false);
    expect(isCanonicalRetryKey("")).toBe(false);
    expect(isCanonicalRetryKey(null)).toBe(false);
    expect(isCanonicalRetryKey(12345678)).toBe(false);
  });
});
