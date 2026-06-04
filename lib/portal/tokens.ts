import { createHash, randomBytes, timingSafeEqual } from "crypto";

// Token utilities for the client portal magic-link + session model.
//
// Both magic links and session cookies use the same shape:
//
//   * generateRawToken() returns 32 random bytes encoded as URL-safe
//     base64 (43 characters, no padding). 32 bytes is 256 bits of
//     entropy: enough that brute-forcing a single token is infeasible
//     even before rate limiting and TTL truncate the search space.
//   * hashToken() returns the lowercase SHA-256 hex of the raw token
//     (64 chars). This is the only value persisted to the DB; the
//     raw token only ever exists in transit (URL parameter or cookie
//     value) and inside the email body. A DB compromise therefore
//     does NOT yield usable tokens.
//   * timingSafeHashEqual() compares two SHA-256 hex strings via
//     crypto.timingSafeEqual so an attacker cannot use response-time
//     differences to learn anything about a stored hash. Since the
//     hash is constant-length (64 hex chars), Buffer.from + equality
//     check is constant-time on the hash itself.
//
// What this file does NOT do:
//   * No DB access. The session/magic-link writers in
//     lib/portal/session.ts and the verify route do the inserts /
//     selects using the admin client.
//   * No cookie handling. lib/portal/session.ts owns the
//     hone_portal_session cookie.

// Bytes of entropy per token. 32 = 256 bits, comfortably above what a
// rate-limited brute force could ever exhaust.
const TOKEN_BYTES = 32;

// Generate a fresh raw token. URL-safe base64 with no padding so it
// flows through path segments (verify) and Set-Cookie (session)
// without escaping.
export function generateRawToken(): string {
  return randomBytes(TOKEN_BYTES)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// SHA-256 hex digest. Lowercase to match the DB CHECK / unique index
// expectations and to make case-insensitive comparison unnecessary.
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

// Constant-time comparison of two SHA-256 hex strings. Both inputs
// MUST be the lowercase hex output of hashToken (64 chars); length
// mismatch returns false without comparing so the timing-safe check
// is never called with mismatched buffers.
export function timingSafeHashEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (a.length !== 64) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return timingSafeEqual(ab, bb);
}

// Optional helper for callers that want to record a hashed fingerprint
// (IP / user-agent / email) on a magic-link or consent-signature row
// without ever storing the raw string. SHA-256 over a salt + the input,
// hex-encoded. The salt comes from PORTAL_FINGERPRINT_SALT so a DB
// dump leaks no usable IP/UA lookup tables.
//
// This is DIAGNOSTIC ONLY. The portal token model uses raw -> hashToken
// for authentication (see hashToken above); the fingerprint is logged
// alongside the magic-link / consent row for operator triage of
// abuse, not for any session or auth decision. The hash columns are
// nullable in the schema (migration 0052 + 0057), so callers already
// tolerate a null return.
//
// Production salt handling
// ------------------------
// When PORTAL_FINGERPRINT_SALT is unset in production we DO NOT
// silently fall back to a constant. Returning null instead means:
//
//   * The diagnostic column on the DB row stores null (safe; column
//     is nullable and the row otherwise still writes successfully).
//   * No predictable, project-known salt is ever used to hash a
//     real client's IP or UA. A leaked DB then yields no usable
//     reverse-lookup table.
//   * Portal login, magic-link issuance, consent capture, and
//     session creation all continue to function (the fingerprint is
//     never consulted for those decisions).
//
// The first-occurrence warning still fires so an operator notices.
const FINGERPRINT_SALT_ENV = process.env.PORTAL_FINGERPRINT_SALT;
let fingerprintSaltWarned = false;
function resolveFingerprintSalt(): string | null {
  if (FINGERPRINT_SALT_ENV && FINGERPRINT_SALT_ENV.length > 0) {
    return FINGERPRINT_SALT_ENV;
  }
  if (!fingerprintSaltWarned) {
    fingerprintSaltWarned = true;
    if (process.env.NODE_ENV === "production") {
      // Sanitized server-side log. No raw IP, UA, or email content
      // included; this is purely an env-config alert.
      console.error(
        JSON.stringify({
          event: "portal_fingerprint_salt_missing",
          environment: process.env.NODE_ENV,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }
  if (process.env.NODE_ENV === "production") {
    return null;
  }
  // Non-production: stable per-process fallback so dev/test do not
  // need an .env entry to exercise the hash code path.
  return "hone-portal-fingerprint-dev-fallback";
}

export function hashFingerprint(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const salt = resolveFingerprintSalt();
  if (salt === null) return null;
  return createHash("sha256")
    .update(`${salt}:${trimmed}`, "utf8")
    .digest("hex");
}
