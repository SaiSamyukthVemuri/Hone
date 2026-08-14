import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Server-only authenticated encryption for Google OAuth secrets (refresh token +
// PKCE verifier). Google Calendar: Phase A.
//
// This mirrors lib/conversion/token-crypto.ts (AES-256-GCM, server-only,
// fail-closed) but with two deliberate differences the design requires:
//
//   1. A DEDICATED key (GOOGLE_TOKEN_ENCRYPTION_KEY), NOT the tracking key, so
//      the blast radius and rotation of Google credentials are independent of
//      marketing/CAPI tokens.
//   2. A VERSIONED, self-describing ciphertext format so a future key rotation
//      can dual-decrypt / re-wrap without ambiguity:
//
//        v1:<keyVersion>:<base64(iv)>:<base64(tag)>:<base64(ciphertext)>
//
//      * `v1`        , scheme id (AES-256-GCM, 12-byte IV, 16-byte tag).
//      * <keyVersion>, the GOOGLE_TOKEN_ENCRYPTION_KEY_VERSION that encrypted
//                       this row (also persisted alongside as encryption_key_
//                       version). Used to pick the right key on decrypt/rotate.
//
// FAIL-CLOSED everywhere: a missing/malformed key or a wrong-key/tampered blob
// returns { ok:false, reason }, never throws, never logs, never leaks the token
// or the raw crypto error. `import "server-only"` guarantees this never reaches
// a client bundle; the key is read from process.env only inside this module.

const SCHEME = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

// Accepts a 64-char hex or a base64 key that decodes to exactly 32 bytes.
function decodeKeyMaterial(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const buf = /^[0-9a-fA-F]{64}$/.test(trimmed)
      ? Buffer.from(trimmed, "hex")
      : Buffer.from(trimmed, "base64");
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

// The configured key version (positive integer). Returns null if unset/invalid,
// so callers fail closed rather than silently stamping a bogus version.
export function currentKeyVersion(): number | null {
  const raw = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_VERSION;
  if (!raw) return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Resolve the encryption key for a given version. Phase A has a single active
// key; the version argument exists so a future rotation can map version -> key
// (e.g. GOOGLE_TOKEN_ENCRYPTION_KEY + GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS)
// without changing the stored format or callers.
function keyForVersion(version: number): Buffer | null {
  const active = currentKeyVersion();
  if (active !== null && version === active) {
    return decodeKeyMaterial(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY);
  }
  // No previous-key slot in Phase A. A row whose version does not match the
  // active key fails closed (decrypt_failed) -> the connection is marked
  // reconnect_required and the practitioner re-consents. Documented rotation
  // cost. A future migration can add a previous-key env slot here.
  return null;
}

// Whether the module is usable at all (key present + well-formed + version set).
// Used by server actions / the env gate to fail closed BEFORE starting a flow.
export function isGoogleTokenCryptoConfigured(): boolean {
  return (
    currentKeyVersion() !== null &&
    decodeKeyMaterial(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY) !== null
  );
}

export type GoogleEncryptResult =
  | { ok: true; ciphertext: string; keyVersion: number; last4: string }
  | { ok: false; reason: string };

export function encryptGoogleSecret(raw: string): GoogleEncryptResult {
  const version = currentKeyVersion();
  if (version === null) return { ok: false, reason: "encryption_key_version_unavailable" };
  const key = keyForVersion(version);
  if (!key) return { ok: false, reason: "encryption_key_unavailable" };
  const value = (raw ?? "").trim();
  if (!value) return { ok: false, reason: "empty_secret" };
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const ciphertext = [
      SCHEME,
      String(version),
      iv.toString("base64"),
      tag.toString("base64"),
      enc.toString("base64"),
    ].join(":");
    return { ok: true, ciphertext, keyVersion: version, last4: value.slice(-4) };
  } catch {
    return { ok: false, reason: "encrypt_failed" };
  }
}

export type GoogleDecryptResult =
  | { ok: true; secret: string }
  | { ok: false; reason: string };

export function decryptGoogleSecret(
  blob: string | null | undefined,
): GoogleDecryptResult {
  const value = (blob ?? "").trim();
  if (!value) return { ok: false, reason: "no_ciphertext" };
  const parts = value.split(":");
  if (parts.length !== 5 || parts[0] !== SCHEME) {
    return { ok: false, reason: "malformed_ciphertext" };
  }
  const version = Number(parts[1]);
  if (!Number.isInteger(version) || version <= 0) {
    return { ok: false, reason: "malformed_key_version" };
  }
  const key = keyForVersion(version);
  if (!key) return { ok: false, reason: "encryption_key_unavailable" };
  try {
    const iv = Buffer.from(parts[2], "base64");
    const tag = Buffer.from(parts[3], "base64");
    const data = Buffer.from(parts[4], "base64");
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return { ok: true, secret: dec.toString("utf8") };
  } catch {
    // Wrong key / tampered / corrupt, never surface the raw error or secret.
    return { ok: false, reason: "decrypt_failed" };
  }
}
