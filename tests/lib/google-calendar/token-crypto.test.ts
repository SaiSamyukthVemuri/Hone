import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentKeyVersion,
  decryptGoogleSecret,
  encryptGoogleSecret,
  isGoogleTokenCryptoConfigured,
} from "@/lib/google-calendar/token-crypto";

// Dedicated-key, versioned AES-256-GCM for Google OAuth secrets. The module
// reads env lazily inside each call, so the tests just set/clear env vars.

const KEY_A = "a".repeat(64); // 32-byte hex
const KEY_B = "b".repeat(64); // different 32-byte hex

function setEnv(key: string | undefined, version: string | undefined) {
  if (key === undefined) delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  else process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = key;
  if (version === undefined) delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_VERSION;
  else process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_VERSION = version;
}

const saved = {
  key: process.env.GOOGLE_TOKEN_ENCRYPTION_KEY,
  ver: process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_VERSION,
};

beforeEach(() => setEnv(KEY_A, "1"));
afterEach(() => setEnv(saved.key, saved.ver));

describe("google token-crypto: configuration", () => {
  it("is configured with a valid 32-byte key + positive version", () => {
    expect(isGoogleTokenCryptoConfigured()).toBe(true);
    expect(currentKeyVersion()).toBe(1);
  });

  it("is NOT configured when the key is missing", () => {
    setEnv(undefined, "1");
    expect(isGoogleTokenCryptoConfigured()).toBe(false);
  });

  it("is NOT configured when the version is missing or non-positive", () => {
    setEnv(KEY_A, undefined);
    expect(currentKeyVersion()).toBeNull();
    setEnv(KEY_A, "0");
    expect(currentKeyVersion()).toBeNull();
    setEnv(KEY_A, "-2");
    expect(currentKeyVersion()).toBeNull();
  });

  it("rejects a wrong-length key", () => {
    setEnv("abcd", "1");
    expect(isGoogleTokenCryptoConfigured()).toBe(false);
  });
});

describe("google token-crypto: round-trip + versioned format", () => {
  it("encrypts to a self-describing v1:<version>:iv:tag:ct blob and round-trips", () => {
    const r = encryptGoogleSecret("1//super-secret-refresh-token");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parts = r.ciphertext.split(":");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toBe("1"); // key version embedded
    expect(r.keyVersion).toBe(1);
    expect(r.last4).toBe("oken");

    const d = decryptGoogleSecret(r.ciphertext);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.secret).toBe("1//super-secret-refresh-token");
  });

  it("never stores the raw token in the ciphertext", () => {
    const raw = "1//plain-visible-token";
    const r = encryptGoogleSecret(raw);
    if (r.ok) expect(r.ciphertext).not.toContain(raw);
  });
});

describe("google token-crypto: fail-closed", () => {
  it("fails to encrypt with no key/version (never throws)", () => {
    setEnv(undefined, undefined);
    const r = encryptGoogleSecret("x");
    expect(r.ok).toBe(false);
  });

  it("fails to decrypt a malformed blob", () => {
    expect(decryptGoogleSecret("not-a-real-blob").ok).toBe(false);
    expect(decryptGoogleSecret("v1:1:only:three").ok).toBe(false);
    expect(decryptGoogleSecret("").ok).toBe(false);
  });

  it("fails to decrypt when the key changed under the same version (wrong key / tamper)", () => {
    const r = encryptGoogleSecret("secret");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Same version number, different key material -> auth tag check fails.
    setEnv(KEY_B, "1");
    const d = decryptGoogleSecret(r.ciphertext);
    expect(d.ok).toBe(false);
  });

  it("fails to decrypt a blob whose key version has no key available", () => {
    const r = encryptGoogleSecret("secret");
    if (!r.ok) return;
    const bumped = r.ciphertext.replace(/^v1:1:/, "v1:2:"); // no key for v2
    const d = decryptGoogleSecret(bumped);
    expect(d.ok).toBe(false);
  });
});
