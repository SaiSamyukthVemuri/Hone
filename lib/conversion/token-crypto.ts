import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Server-only authenticated encryption for studio-owned provider tokens.
//
// Studios add their own CAPI/server token in Hone settings; it is encrypted
// with AES-256-GCM under ONE server-side master key (TRACKING_TOKEN_ENCRYPTION_KEY)
// and only the ciphertext + last4 are persisted. Raw tokens never touch the DB,
// the client bundle, or logs. A future KMS/vault can replace this module without
// changing the stored shape (still an opaque `encrypted` string).
//
// Ciphertext format: base64(iv):base64(authTag):base64(ciphertext), the GCM
// auth tag makes tampering detectable (decrypt fails safely).

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

// Accepts a 64-char hex or a base64 key that decodes to exactly 32 bytes.
function loadKey(): Buffer | null {
  const raw = process.env.TRACKING_TOKEN_ENCRYPTION_KEY;
  if (!raw) return null;
  try {
    const buf = /^[0-9a-fA-F]{64}$/.test(raw.trim())
      ? Buffer.from(raw.trim(), "hex")
      : Buffer.from(raw.trim(), "base64");
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

export type EncryptResult =
  | { ok: true; encrypted: string; last4: string }
  | { ok: false; reason: string };

export function encryptTrackingProviderToken(rawToken: string): EncryptResult {
  const key = loadKey();
  if (!key) return { ok: false, reason: "encryption_key_unavailable" };
  const token = (rawToken ?? "").trim();
  if (!token) return { ok: false, reason: "empty_token" };
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const encrypted = `${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
    // last4 is a non-sensitive tail used only for owner UI recognition.
    return { ok: true, encrypted, last4: token.slice(-4) };
  } catch {
    return { ok: false, reason: "encrypt_failed" };
  }
}

export type DecryptResult =
  | { ok: true; token: string }
  | { ok: false; reason: string };

export function decryptTrackingProviderToken(
  encrypted: string | null | undefined,
): DecryptResult {
  const key = loadKey();
  if (!key) return { ok: false, reason: "encryption_key_unavailable" };
  const blob = (encrypted ?? "").trim();
  if (!blob) return { ok: false, reason: "no_token" };
  try {
    const [ivB, tagB, dataB] = blob.split(":");
    if (!ivB || !tagB || !dataB) return { ok: false, reason: "malformed_ciphertext" };
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB, "base64"));
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataB, "base64")),
      decipher.final(),
    ]);
    return { ok: true, token: dec.toString("utf8") };
  } catch {
    // Wrong key / tampered / corrupt, never surface the raw error or token.
    return { ok: false, reason: "decrypt_failed" };
  }
}
