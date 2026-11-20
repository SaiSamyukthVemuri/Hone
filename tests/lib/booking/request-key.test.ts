import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { REQUEST_KEY_BYTES, REQUEST_KEY_PATTERN, REQUEST_KEY_REPLAY_WINDOW_HOURS, REQUEST_KEY_SQL_PATTERN, isRequestKey, mintRequestKey, parseRequestKey } from "@/lib/booking/request-key";
import { REQUEST_KEY_VECTORS } from "../../fixtures/request-key-vectors";

/** The module's code with every comment line (// and /** ... *\/) removed, so a comment may name a number the code must not repeat. */
const codeOf = () => readFileSync("lib/booking/request-key.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

describe("the canonical booking request key rule, against the shared vectors", () => {
  it("the vectors cover both outcomes (so the loop cannot pass on one side only)", () => {
    expect(REQUEST_KEY_VECTORS.filter((v) => v.valid).length).toBeGreaterThanOrEqual(4);
    expect(REQUEST_KEY_VECTORS.filter((v) => !v.valid).length).toBeGreaterThanOrEqual(15);
  });
  for (const v of REQUEST_KEY_VECTORS) {
    it(`${v.valid ? "accepts" : "rejects"}: ${v.name}`, () => {
      expect(isRequestKey(v.input)).toBe(v.valid);
      // a key is returned UNCHANGED or not at all: there is no repair path
      expect(parseRequestKey(v.input)).toBe(v.valid ? v.input : null);
    });
  }
});

describe("the pattern and its SQL spelling are one rule", () => {
  it("the SQL pattern text is exactly the pattern's source (so the database check is the same string)", () => {
    expect(REQUEST_KEY_SQL_PATTERN).toBe(REQUEST_KEY_PATTERN.source);
    expect(REQUEST_KEY_PATTERN.flags).toBe("");
  });
  it("it is anchored at both ends, 32 characters, lower-case hex only, with no flags that would loosen it", () => {
    expect(REQUEST_KEY_PATTERN.source.startsWith("^")).toBe(true);
    expect(REQUEST_KEY_PATTERN.source.endsWith("$")).toBe(true);
    expect(REQUEST_KEY_PATTERN.source).toBe("^[0-9a-f]{32}$");
  });
  it("the module never trims, lower-cases or normalises (source guard)", () => {
    const code = codeOf();
    expect(code).not.toMatch(/\.trim\(|\.toLowerCase\(|\.toUpperCase\(|\.normalize\(|\.replace\(/);
  });
});

describe("minting", () => {
  it("a minted key is canonical, 128 bits, and different every time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const k = mintRequestKey();
      expect(isRequestKey(k)).toBe(true);
      expect(k).toHaveLength(REQUEST_KEY_BYTES * 2);
      seen.add(k);
    }
    expect(REQUEST_KEY_BYTES).toBe(16);
    expect(seen.size).toBe(2000);
  });
  it("it draws from the platform's cryptographic source, never Math.random (source guard)", () => {
    const code = codeOf();
    expect(code).toContain("crypto.getRandomValues");
    expect(code).not.toContain("Math.random");
  });
  it("zero bytes are padded (a leading 0x0 byte must still be two characters)", () => {
    const original = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    const spy = (a: Uint8Array) => (a.fill(0x0a, 0, 1), a.fill(0, 1), a);
    Object.defineProperty(globalThis.crypto, "getRandomValues", { value: spy, configurable: true });
    try {
      expect(mintRequestKey()).toBe("0a" + "00".repeat(15));
    } finally {
      Object.defineProperty(globalThis.crypto, "getRandomValues", { value: original, configurable: true });
    }
  });
});

describe("the replay window is one named constant", () => {
  it("is a positive whole number of hours, proposed as 24, and appears once in the module", () => {
    expect(Number.isInteger(REQUEST_KEY_REPLAY_WINDOW_HOURS)).toBe(true);
    expect(REQUEST_KEY_REPLAY_WINDOW_HOURS).toBeGreaterThan(0);
    expect(REQUEST_KEY_REPLAY_WINDOW_HOURS).toBe(24);
    const code = codeOf();
    expect(code.match(/\b24\b/g)?.length).toBe(1);
  });
});
