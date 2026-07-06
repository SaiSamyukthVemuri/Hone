import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decryptTrackingProviderToken,
  encryptTrackingProviderToken,
} from "@/lib/conversion/token-crypto";

const KEY_HEX = randomBytes(32).toString("hex"); // 64 hex chars = 32 bytes

beforeEach(() => {
  vi.stubEnv("TRACKING_TOKEN_ENCRYPTION_KEY", KEY_HEX);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("token-crypto — encrypt/decrypt roundtrip", () => {
  it("encrypts (ciphertext ≠ raw) and decrypts back to the original", () => {
    const raw = "EAAG_super_secret_meta_capi_token_1234";
    const enc = encryptTrackingProviderToken(raw);
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;
    expect(enc.encrypted).not.toContain(raw); // raw token NOT in ciphertext
    expect(enc.last4).toBe("1234");
    const dec = decryptTrackingProviderToken(enc.encrypted);
    expect(dec).toEqual({ ok: true, token: raw });
  });

  it("two encryptions of the same token differ (random IV) but both decrypt", () => {
    const raw = "token_abcd";
    const a = encryptTrackingProviderToken(raw);
    const b = encryptTrackingProviderToken(raw);
    if (!a.ok || !b.ok) throw new Error("ok");
    expect(a.encrypted).not.toBe(b.encrypted);
    expect(decryptTrackingProviderToken(a.encrypted)).toEqual({ ok: true, token: raw });
  });
});

describe("token-crypto — failure handling (safe reasons, no token leak)", () => {
  it("missing key → encryption_key_unavailable (no throw)", () => {
    vi.stubEnv("TRACKING_TOKEN_ENCRYPTION_KEY", "");
    expect(encryptTrackingProviderToken("x")).toEqual({ ok: false, reason: "encryption_key_unavailable" });
    expect(decryptTrackingProviderToken("y")).toEqual({ ok: false, reason: "encryption_key_unavailable" });
  });

  it("empty token → empty_token", () => {
    expect(encryptTrackingProviderToken("   ")).toEqual({ ok: false, reason: "empty_token" });
  });

  it("wrong key / tampered ciphertext → decrypt_failed (never the token)", () => {
    const enc = encryptTrackingProviderToken("secret_token_9999");
    if (!enc.ok) throw new Error("ok");
    // rotate to a different key
    vi.stubEnv("TRACKING_TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
    const dec = decryptTrackingProviderToken(enc.encrypted);
    expect(dec.ok).toBe(false);
    if (dec.ok) return;
    expect(dec.reason).toBe("decrypt_failed");
    expect(JSON.stringify(dec)).not.toContain("secret_token_9999");
  });

  it("malformed ciphertext → malformed_ciphertext", () => {
    expect(decryptTrackingProviderToken("not-a-valid-blob")).toEqual({ ok: false, reason: "malformed_ciphertext" });
  });

  it("a result object never carries the raw token", () => {
    const enc = encryptTrackingProviderToken("RAWTOKENVALUE");
    expect(JSON.stringify(enc)).not.toContain("RAWTOKENVALUE");
  });
});
